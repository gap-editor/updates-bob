/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */

// @ts-check

const fs = require('fs');
const contractDir = 'docs/contracts/src/src';
// Check if the contract directory exists and is a directory
const contractItems =
    fs.existsSync(contractDir) && fs.lstatSync(contractDir).isDirectory()
        ? fs
            .readdirSync(contractDir, { withFileTypes: true })
            .filter((dirent) => dirent.isDirectory())
            .map((dirent) => ({
              type: "category",
              label: `${dirent.name.charAt(0).toUpperCase()}${dirent.name.slice(
                  1
              )}`, // Capitalize the first letter of the directory name
              items: [
                {
                  type: "autogenerated",
                  dirName: `contracts/src/src/${dirent.name}`,
                },
              ],
            }))
        : [
          {
            type: "category",
            label: "Contracts",
            items: ["contracts/contract_references"], // Default item when the directory doesn't exist or is not a directory
          },
        ];


/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  // By default, Docusaurus generates a sidebar from the docs folder structure
  rootSidebar: [{type: 'autogenerated', dirName: '.'}],
  learnSidebar: [{type: 'autogenerated', dirName: 'learn'}],
  buildSidebar: [{type: 'autogenerated', dirName: 'build'}],
  contractSidebar: [
    {
      type: 'category',
      label: 'Contracts',
      collapsed: false,
      items: contractItems,
    }
  ],
  apiSidebar: [
    {
      type: 'category',
      label: 'TypeScript API',
      collapsed: false,
      items: [
        "api/ts-sdk/modules",
        {
          type: 'category',
          label: 'Modules',
          items: [
            {
              type: 'autogenerated',
              dirName: 'api/ts-sdk/modules'
            }
          ]
        },
        {
          type: 'category',
          label: 'Interfaces',
          items: [
            {
              type: 'autogenerated',
              dirName: 'api/ts-sdk/interfaces'
            }
          ]
        },
        {
          type: 'category',
          label: 'Classes',
          items: [
            {
              type: 'autogenerated',
              dirName: 'api/ts-sdk/classes'
            }
          ]
        }
      ],
    }
  ],
};

module.exports = sidebars;
