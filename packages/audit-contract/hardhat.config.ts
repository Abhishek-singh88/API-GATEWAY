import { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-toolbox';
import 'dotenv/config';

const PRIVATE_KEY = process.env.CHAIN_PRIVATE_KEY || '';
const RPC_URL = process.env.CHAIN_RPC_URL || '';

const config: HardhatUserConfig = {
  solidity: '0.8.24',
  networks: {
    sepolia: {
      url: RPC_URL,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
};

export default config;
