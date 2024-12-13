import { Transaction, Script, selectUTXO, TEST_NETWORK, NETWORK, p2wpkh, p2sh, p2tr } from '@scure/btc-signer';
import { hex, base64 } from '@scure/base';
import { AddressType, getAddressInfo, Network } from 'bitcoin-address-validation';
import { EsploraClient, UTXO } from '../esplora';
import { OrdinalsClient, OutPoint, OutputJson } from '../ordinal-api';
import { getTxInscriptions } from '../inscription';

export type BitcoinNetworkName = Exclude<Network, 'regtest'>;

const bitcoinNetworks: Record<BitcoinNetworkName, typeof NETWORK> = {
    mainnet: NETWORK,
    testnet: TEST_NETWORK,
};

export const getBtcNetwork = (name: BitcoinNetworkName) => {
    return bitcoinNetworks[name];
};

type Output = { address: string; amount: bigint } | { script: Uint8Array; amount: bigint };

class TreeNode<T> {
    val: T;
    children: TreeNode<T>[];

    constructor(val: T, children: TreeNode<T>[] = []) {
        this.val = val;
        this.children = children;
    }
}

const processNodes = async (rootNodes: (TreeNode<OutputNodeData> | null)[], esploraClient: EsploraClient) => {
    const queue = Array.from(rootNodes);

    while (queue.length > 0) {
        const childNode = queue.shift();

        if (childNode === null) continue;

        const txInscriptions = await getTxInscriptions(esploraClient, childNode.val.txid);

        if (txInscriptions.length === 0) {
            const transaction = await esploraClient.getTransaction(childNode.val.txid);

            // if not confirmed check inputs for current utxo
            if (!transaction.status.confirmed) {
                childNode.children = transaction.vin.map((vin) => {
                    return new TreeNode<OutputNodeData>({
                        vout: vin.vout,
                        txid: vin.txid,
                        cardinal: true,
                    });
                });

                queue.push(...childNode.children);
            }
        } else {
            // mark node as containing ordinals
            childNode.val.cardinal = false;
        }
    }
};

const checkUtxoNode = (node: TreeNode<OutputNodeData>) => {
    // leaf node either confirmed or contains ordinals
    if (node.children.length === 0) return node.val.cardinal;

    return node.children.reduce((acc, child) => acc && checkUtxoNode(child), true);
};

type OutputNodeData = Pick<UTXO, 'txid' | 'vout'> & { cardinal: boolean };

export interface Input {
    txid: string;
    index: number;
    witness_script?: Uint8Array;
    redeemScript?: Uint8Array;
    witnessUtxo?: {
        script: Uint8Array;
        amount: bigint;
    };
    nonWitnessUtxo?: Uint8Array;
}

/**
 * Create a PSBT with an output `toAddress` and an optional OP_RETURN output.
 * May add an additional change output. This returns an **unsigned** PSBT encoded
 * as a Base64 string.
 *
 * @param fromAddress The Bitcoin address which is sending to the `toAddress`.
 * @param toAddress The Bitcoin address which is receiving the BTC.
 * @param amount The amount of BTC (as satoshis) to send.
 * @param publicKey Optional public key needed if using P2SH-P2WPKH.
 * @param opReturnData Optional OP_RETURN data to include in an output.
 * @param feeRate Optional fee rate in satoshis per byte.
 * @param confirmationTarget The number of blocks to include this tx (for fee estimation).
 * @returns {Promise<string>} The Base64 encoded PSBT.
 *
 * @example
 * ```typescript
 * const fromAddress = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
 * const toAddress = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
 * const amount = 100000;
 * const publicKey = '02d4...`; // only for P2SH
 * const opReturnData = 'Hello, World!'; // optional
 * const confirmationTarget = 3; // optional
 *
 * const psbt = await createBitcoinPsbt(fromAddress, toAddress, amount, publicKey, opReturnData, confirmationTarget);
 * console.log(psbt);
 *
 * // The PSBT can then be signed with the private key using sats-wagmi, sats-connect, ...
 * ```
 */
export async function createBitcoinPsbt(
    fromAddress: string,
    toAddress: string,
    amount: number,
    publicKey?: string,
    opReturnData?: string,
    feeRate?: number,
    confirmationTarget: number = 3
): Promise<string> {
    const addressInfo = getAddressInfo(fromAddress);

    // TODO: possibly, allow other strategies to be passed to this function
    const utxoSelectionStrategy: 'all' | 'default' = 'default';

    if (addressInfo.network === 'regtest') {
        throw new Error('Bitcoin regtest not supported');
    }

    // We need the public key to generate the redeem and witness script to spend the scripts
    if (
        addressInfo.type === AddressType.p2sh ||
        addressInfo.type === AddressType.p2wsh ||
        addressInfo.type === AddressType.p2tr
    ) {
        if (!publicKey) {
            throw new Error('Public key is required to spend from the selected address type');
        }
    }

    const esploraClient = new EsploraClient(addressInfo.network);
    const ordinalsClient = new OrdinalsClient(addressInfo.network);

    let utxos: UTXO[] = [];
    // contains UTXOs which do not contain inscriptions
    let cardinalOutputs: OutputJson[] = [];

    [utxos, feeRate, cardinalOutputs] = await Promise.all([
        esploraClient.getAddressUtxos(fromAddress),
        feeRate === undefined ? esploraClient.getFeeEstimate(confirmationTarget) : feeRate,
        // cardinal = return UTXOs not containing inscriptions or runes
        ordinalsClient.getOutputsFromAddress(fromAddress, 'cardinal'),
    ]);

    if (utxos.length === 0) {
        throw new Error('No confirmed UTXOs');
    }

    const cardinalOutputsSet = new Set(cardinalOutputs.map((output) => output.outpoint));

    const rootUtxoNodes = utxos.reduce(
        (acc, utxo) => {
            if (!cardinalOutputsSet.has(OutPoint.toString(utxo)))
                acc.push(new TreeNode<OutputNodeData>({ ...utxo, cardinal: true }));
            else acc.push(null);

            return acc;
        },
        [] as (TreeNode<OutputNodeData> | null)[]
    );

    await processNodes(rootUtxoNodes, esploraClient);

    // To construct the spending transaction and estimate the fee, we need the transactions for the UTXOs
    const possibleInputs: Input[] = [];

    await Promise.all(
        utxos.map(async (utxo, index) => {
            const hex = await esploraClient.getTransactionHex(utxo.txid);
            const transaction = Transaction.fromRaw(Buffer.from(hex, 'hex'), { allowUnknownOutputs: true });
            const input = getInputFromUtxoAndTx(
                addressInfo.network as BitcoinNetworkName,
                utxo,
                transaction,
                addressInfo.type,
                publicKey
            );
            // to support taproot addresses we want to exclude outputs which contain inscriptions
            if (cardinalOutputsSet.has(OutPoint.toString(utxo))) return possibleInputs.push(input);

            // allow to spend output if none of `vin` contains ordinals
            if (rootUtxoNodes[index] !== null && checkUtxoNode(rootUtxoNodes[index])) return possibleInputs.push(input);
        })
    );

    const outputs: Output[] = [
        {
            address: toAddress,
            amount: BigInt(amount),
        },
    ];

    if (opReturnData) {
        // Strip 0x prefix from opReturn
        if (opReturnData.startsWith('0x')) {
            opReturnData = opReturnData.slice(2);
        }
        outputs.push({
            // OP_RETURN https://github.com/paulmillr/scure-btc-signer/issues/26
            script: Script.encode(['RETURN', hex.decode(opReturnData)]),
            amount: BigInt(0),
        });
    }

    // Outsource UTXO selection to btc-signer
    // https://github.com/paulmillr/scure-btc-signer?tab=readme-ov-file#utxo-selection
    // default = exactBiggest/accumBiggest creates tx with smallest fees, but it breaks
    // big outputs to small ones, which in the end will create a lot of outputs close to dust.
    const transaction = selectUTXO(possibleInputs, outputs, utxoSelectionStrategy, {
        changeAddress: fromAddress, // Refund surplus to the payment address
        feePerByte: BigInt(Math.ceil(feeRate)), // round up to the nearest integer
        bip69: true, // Sort inputs and outputs according to BIP69
        createTx: true, // Create the transaction
        network: getBtcNetwork(addressInfo.network),
        allowUnknownOutputs: true, // Required for OP_RETURN
        allowLegacyWitnessUtxo: true, // Required for P2SH-P2WPKH
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dust: BigInt(546) as any, // TODO: update scure-btc-signer
    });

    if (!transaction || !transaction.tx) {
        console.debug('utxos', utxos);
        console.debug('outputsFromAddress', cardinalOutputs);
        console.debug(`fromAddress: ${fromAddress}, toAddress: ${toAddress}, amount: ${amount}`);
        console.debug(`publicKey: ${publicKey}, opReturnData: ${opReturnData}`);
        console.debug(`feeRate: ${feeRate}, confirmationTarget: ${confirmationTarget}`);
        throw new Error('Failed to create transaction. Do you have enough funds?');
    }

    return base64.encode(transaction.tx.toPSBT(0));
}

// Using the UTXO and the transaction, we can construct the input for the transaction
export function getInputFromUtxoAndTx(
    network: BitcoinNetworkName,
    utxo: UTXO,
    transaction: Transaction,
    addressType: AddressType,
    publicKey?: string
): Input {
    // The output containts the necessary details to spend the UTXO based on the script type
    // Under the hood, @scure/btc-signer parses the output and extracts the script and amount
    const output = transaction.getOutput(utxo.vout);

    // For p2sh, we additionally need the redeem script. This cannot be extracted from the transaction itself
    // We only support P2SH-P2WPKH
    // TODO: add support for P2WSH
    // TODO: add support for P2SH-P2PKH
    let redeemScript = {};

    if (addressType === AddressType.p2sh) {
        if (!publicKey) {
            throw new Error('Bitcoin P2SH not supported without public key');
        }
        const inner = p2wpkh(Buffer.from(publicKey!, 'hex'), getBtcNetwork(network));
        redeemScript = p2sh(inner);
    } else if (addressType === AddressType.p2tr) {
        const xOnlyPublicKey = Buffer.from(publicKey, 'hex').subarray(1, 33);
        redeemScript = p2tr(xOnlyPublicKey);
    }

    // For the redeem and witness script, we need to construct the script mixin
    const scriptMixin = {
        ...redeemScript,
    };

    const nonWitnessUtxo = {
        nonWitnessUtxo: Buffer.from(transaction.hex, 'hex'),
    };
    const witnessUtxo = {
        witnessUtxo: {
            script: output.script!,
            amount: output.amount!,
        },
    };
    const witnessMixin = transaction.hasWitnesses ? { ...witnessUtxo, ...nonWitnessUtxo } : nonWitnessUtxo;

    // Construct inputs based on the script type
    const input = {
        txid: utxo.txid,
        index: utxo.vout,
        ...scriptMixin, // Maybe adds the redeemScript and/or witnessScript
        ...witnessMixin, // Adds the witnessUtxo and/or nonWitnessUtxo
    };

    return input;
}

/**
 * Estimate the tx inclusion fee for a given address or public key with an optional OP_RETURN output.
 *
 * @param fromAddress The Bitcoin address which is sending to the `toAddress`.
 * @param amount The amount of BTC (as satoshis) to send. If no amount is specified, the fee is estimated for all UTXOs, i.e., the max amount.
 * @param publicKey Optional public key needed if using P2SH-P2WPKH.
 * @param opReturnData Optional OP_RETURN data to include in an output.
 * @param feeRate Optional fee rate in satoshis per byte.
 * @param confirmationTarget The number of blocks to include this tx (for fee estimation).
 * @returns {Promise<bigint>} The fee amount for estimated transaction inclusion in satoshis.
 *
 * @example
 * ```typescript
 * // Using a target amount (call might fail if amount is larger than balance plus fees)
 * const fromAddress = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
 * const amount = 100000;
 * const publicKey = '02d4...`; // only for P2SH
 * const opReturnData = 'Hello, World!'; // optional
 * const feeRate = 1; // optional
 * const confirmationTarget = 3; // optional
 *
 * const fee = await estimateTxFee(fromAddress, amount, publicKey, opReturnData, feeRate, confirmationTarget);
 * console.log(fee);
 *
 * // Using all UTXOs without a target amount (max fee for spending all UTXOs)
 * const fromAddress = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
 * const publicKey = '02d4...`; // only for P2SH
 * const opReturnData = 'Hello, World!'; // optional
 * const feeRate = 1; // optional
 *
 * const fee = await estimateTxFee(fromAddress, undefined, publicKey, opReturnData, feeRate);
 * console.log(fee);
 * ```
 *
 * @dev Wtih no amount set, we estimate the fee for all UTXOs by trying to spend all inputs using strategy 'all'. If an amount is set, we use the 'default
 * strategy to select the UTXOs. If the amount is more than available, an error will be thrown.
 */
export async function estimateTxFee(
    fromAddress: string,
    amount?: number,
    publicKey?: string,
    opReturnData?: string,
    feeRate?: number,
    confirmationTarget: number = 3
): Promise<bigint> {
    const addressInfo = getAddressInfo(fromAddress);

    if (addressInfo.network === 'regtest') {
        throw new Error('Bitcoin regtest not supported');
    }

    // We need the public key to generate the redeem and witness script to spend the scripts
    if (
        addressInfo.type === AddressType.p2sh ||
        addressInfo.type === AddressType.p2wsh ||
        addressInfo.type === AddressType.p2tr
    ) {
        if (!publicKey) {
            throw new Error('Public key is required to spend from the selected address type');
        }
    }

    // Use the from address as the toAddress for the fee estimate
    const toAddress = fromAddress;

    // TODO: allow submitting the UTXOs, fee estimate and confirmed transactions
    // to avoid fetching them again.
    const esploraClient = new EsploraClient(addressInfo.network);
    const ordinalsClient = new OrdinalsClient(addressInfo.network);

    let utxos: UTXO[] = [];
    // contains UTXOs which do not contain inscriptions
    let cardinalOutputs: OutputJson[] = [];

    [utxos, feeRate, cardinalOutputs] = await Promise.all([
        esploraClient.getAddressUtxos(fromAddress),
        feeRate === undefined ? esploraClient.getFeeEstimate(confirmationTarget) : feeRate,
        // cardinal = return UTXOs not containing inscriptions or runes
        ordinalsClient.getOutputsFromAddress(fromAddress, 'cardinal'),
    ]);

    if (utxos.length === 0) {
        throw new Error('No confirmed UTXOs');
    }

    const cardinalOutputsSet = new Set(cardinalOutputs.map((output) => output.outpoint));

    const rootUtxoNodes = utxos.reduce(
        (acc, utxo) => {
            if (!cardinalOutputsSet.has(OutPoint.toString(utxo)))
                acc.push(new TreeNode<OutputNodeData>({ ...utxo, cardinal: true }));
            else acc.push(null);

            return acc;
        },
        [] as (TreeNode<OutputNodeData> | null)[]
    );

    await processNodes(rootUtxoNodes, esploraClient);

    const possibleInputs: Input[] = [];

    await Promise.all(
        utxos.map(async (utxo, index) => {
            const hex = await esploraClient.getTransactionHex(utxo.txid);
            const transaction = Transaction.fromRaw(Buffer.from(hex, 'hex'), { allowUnknownOutputs: true });
            const input = getInputFromUtxoAndTx(
                addressInfo.network as BitcoinNetworkName,
                utxo,
                transaction,
                addressInfo.type,
                publicKey
            );

            // to support taproot addresses we want to exclude outputs which contain inscriptions
            if (cardinalOutputsSet.has(OutPoint.toString(utxo))) return possibleInputs.push(input);

            // allow to spend output if none of `vin` contains ordinals
            if (rootUtxoNodes[index] !== null && checkUtxoNode(rootUtxoNodes[index])) return possibleInputs.push(input);
        })
    );

    // Create transaction without outputs
    const outputs: Output[] = [
        {
            address: toAddress,
            amount: BigInt(amount ? amount : 0),
        },
    ];

    if (opReturnData) {
        // Strip 0x prefix from opReturn
        if (opReturnData.toLowerCase().startsWith('0x')) {
            opReturnData = opReturnData.slice(2);
        }
        outputs.push({
            // OP_RETURN https://github.com/paulmillr/scure-btc-signer/issues/26
            script: Script.encode(['RETURN', hex.decode(opReturnData)]),
            amount: BigInt(0),
        });
    }

    // Select all UTXOs if no amount is specified
    let utxoSelectionStrategy: 'all' | 'default' = 'default';
    if (amount === undefined) {
        utxoSelectionStrategy = 'all';
    }

    // Outsource UTXO selection to btc-signer
    // https://github.com/paulmillr/scure-btc-signer?tab=readme-ov-file#utxo-selection
    // default = exactBiggest/accumBiggest creates tx with smallest fees, but it breaks
    // big outputs to small ones, which in the end will create a lot of outputs close to dust.
    const transaction = selectUTXO(possibleInputs, outputs, utxoSelectionStrategy, {
        changeAddress: fromAddress, // Refund surplus to the payment address
        feePerByte: BigInt(Math.ceil(feeRate)), // round up to the nearest integer
        bip69: true, // Sort inputs and outputs according to BIP69
        createTx: true, // Create the transaction
        network: getBtcNetwork(addressInfo.network),
        allowUnknownOutputs: true, // Required for OP_RETURN
        allowLegacyWitnessUtxo: true, // Required for P2SH-P2WPKH
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        dust: BigInt(546) as any, // TODO: update scure-btc-signer
    });

    if (!transaction || !transaction.tx) {
        console.debug('utxos', utxos);
        console.debug('cardinalOutputs', cardinalOutputs);
        console.debug(`fromAddress: ${fromAddress}, amount: ${amount}`);
        console.debug(`publicKey: ${publicKey}, opReturnData: ${opReturnData}`);
        console.debug(`feeRate: ${feeRate}, confirmationTarget: ${confirmationTarget}`);
        throw new Error('Failed to create transaction. Do you have enough funds?');
    }

    return transaction.fee;
}

/**
 * Get balance of provided address in satoshis.
 *
 * @typedef { {confirmed: BigInt, unconfirmed: BigInt, total: bigint} } Balance
 *
 * @param {string} [address] The Bitcoin address. If no address specified returning object will contain zeros.
 * @returns {Promise<Balance>} The balance object of provided address in satoshis.
 *
 * @example
 * ```typescript
 * const address = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
 *
 * const balance = await getBalance(address);
 * console.log(balance);
 * ```
 *
 * @dev UTXOs that contain inscriptions or runes will not be used to calculate balance.
 */
export async function getBalance(address?: string) {
    if (!address) {
        return { confirmed: BigInt(0), unconfirmed: BigInt(0), total: BigInt(0) };
    }

    const addressInfo = getAddressInfo(address);

    const esploraClient = new EsploraClient(addressInfo.network);
    const ordinalsClient = new OrdinalsClient(addressInfo.network);

    const [utxos, cardinalOutputs] = await Promise.all([
        esploraClient.getAddressUtxos(address),
        // cardinal = return UTXOs not containing inscriptions or runes
        ordinalsClient.getOutputsFromAddress(address, 'cardinal'),
    ]);

    const cardinalOutputsSet = new Set(cardinalOutputs.map((output) => output.outpoint));

    const rootUtxoNodes = utxos.reduce(
        (acc, utxo) => {
            if (!cardinalOutputsSet.has(OutPoint.toString(utxo)))
                acc.push(new TreeNode<OutputNodeData>({ ...utxo, cardinal: true }));
            else acc.push(null);

            return acc;
        },
        [] as (TreeNode<OutputNodeData> | null)[]
    );

    await processNodes(rootUtxoNodes, esploraClient);

    const total = utxos.reduce((acc, utxo, index) => {
        // there will be a match if output is confirmed and has no ordinals
        if (cardinalOutputsSet.has(OutPoint.toString(utxo))) return acc + utxo.value;

        // allow to spend output if none of `vin` contains ordinals
        if (rootUtxoNodes[index] !== null && checkUtxoNode(rootUtxoNodes[index])) return acc + utxo.value;

        return acc;
    }, 0);

    const confirmed = utxos.reduce((acc, utxo) => {
        if (cardinalOutputsSet.has(OutPoint.toString(utxo)) && utxo.confirmed) {
            return acc + utxo.value;
        }

        return acc;
    }, 0);

    return {
        confirmed: BigInt(confirmed),
        unconfirmed: BigInt(total - confirmed),
        total: BigInt(total),
    };
}
