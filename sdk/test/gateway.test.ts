import { assert, describe, it } from "vitest";
import { GatewaySDK } from "../src/gateway";
import { MAINNET_GATEWAY_BASE_URL } from "../src/gateway/client";
import { SYMBOL_LOOKUP } from "../src/gateway/tokens";
import { ZeroAddress } from "ethers";
import nock from "nock";
import * as bitcoin from "bitcoinjs-lib";

describe("Gateway Tests", () => {
    it("should get quote", async () => {
        const gatewaySDK = new GatewaySDK("mainnet");

        const mockQuote = {
            gatewayAddress: ZeroAddress,
            dustThreshold: 1000,
            satoshis: 1000,
            fee: 10,
            bitcoinAddress: "",
            txProofDifficultyFactor: 3,
            strategyAddress: ZeroAddress,
        };

        nock(`${MAINNET_GATEWAY_BASE_URL}`)
            .get(`/quote/${SYMBOL_LOOKUP["tbtc"].bob}/1000`)
            .times(4)
            .reply(200, mockQuote);

        assert.deepEqual(await gatewaySDK.getQuote({
            toChain: "BOB",
            toToken: "tBTC",
            toUserAddress: ZeroAddress,
            amount: 1000,
        }), mockQuote);
        assert.deepEqual(await gatewaySDK.getQuote({
            toChain: "bob",
            toToken: "tbtc",
            toUserAddress: ZeroAddress,
            amount: 1000,
        }), mockQuote);
        assert.deepEqual(await gatewaySDK.getQuote({
            toChain: 60808,
            toToken: "tbtc",
            toUserAddress: ZeroAddress,
            amount: 1000,
        }), mockQuote);
        assert.deepEqual(await gatewaySDK.getQuote({
            toChain: "BOB",
            toToken: SYMBOL_LOOKUP["tbtc"].bob,
            toUserAddress: ZeroAddress,
            amount: 1000,
        }), mockQuote);

        // get the total available without amount
        nock(`${MAINNET_GATEWAY_BASE_URL}`)
            .get(`/quote/${SYMBOL_LOOKUP["tbtc"].bob}/`)
            .reply(200, mockQuote);
        assert.deepEqual(await gatewaySDK.getQuote({
            toChain: "BOB",
            toToken: SYMBOL_LOOKUP["tbtc"].bob,
            toUserAddress: ZeroAddress,
        }), mockQuote);
    });

    it("should start order", async () => {
        const gatewaySDK = new GatewaySDK("bob");

        const mockQuote = {
            gatewayAddress: ZeroAddress,
            dustThreshold: 1000,
            satoshis: 1000,
            fee: 10,
            bitcoinAddress: "bc1qafk4yhqvj4wep57m62dgrmutldusqde8adh20d",
            txProofDifficultyFactor: 3,
            strategyAddress: ZeroAddress,
        };

        nock(`${MAINNET_GATEWAY_BASE_URL}`)
            .post(`/order`)
            .reply(201, {
                uuid: "00000000-0000-0000-0000-000000000000",
                opReturnHash: "0x10e69ac36b8d7ae8eb1dca7fe368da3d27d159259f48d345ff687ef0fcbdedcd",
            });

        const result = await gatewaySDK.startOrder(mockQuote, {
            toChain: "BOB",
            toToken: "tBTC",
            toUserAddress: ZeroAddress,
            amount: 1000,
            fromChain: "Bitcoin",
            fromUserAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        });

        assert.isDefined(result.psbtBase64);
        const psbt = bitcoin.Psbt.fromBase64(result.psbtBase64!);
        assert.deepEqual(
            psbt.txOutputs[0].script,
            bitcoin.script.compile([
                bitcoin.opcodes.OP_RETURN,
                Buffer.from(result.opReturnHash.slice(2), "hex")
            ])
        );
    });
});
