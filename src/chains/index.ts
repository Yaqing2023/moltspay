/**
 * Blockchain Configuration
 */

import type { ChainConfig, ChainName } from '../types/index.js';

export const CHAINS: Record<ChainName, ChainConfig> = {
  // ============ Mainnet ============
  base: {
    name: 'Base',
    chainId: 8453,
    rpc: 'https://mainnet.base.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    explorer: 'https://basescan.org/address/',
    explorerTx: 'https://basescan.org/tx/',
    avgBlockTime: 2,
  },
  polygon: {
    name: 'Polygon',
    chainId: 137,
    rpc: 'https://polygon-rpc.com',
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    explorer: 'https://polygonscan.com/address/',
    explorerTx: 'https://polygonscan.com/tx/',
    avgBlockTime: 2,
  },
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    rpc: 'https://eth.llamarpc.com',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    explorer: 'https://etherscan.io/address/',
    explorerTx: 'https://etherscan.io/tx/',
    avgBlockTime: 12,
  },

  // ============ Testnet ============
  base_sepolia: {
    name: 'Base Sepolia',
    chainId: 84532,
    rpc: 'https://sepolia.base.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org/address/',
    explorerTx: 'https://sepolia.basescan.org/tx/',
    avgBlockTime: 2,
  },
  sepolia: {
    name: 'Sepolia',
    chainId: 11155111,
    rpc: 'https://rpc.sepolia.org',
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    explorer: 'https://sepolia.etherscan.io/address/',
    explorerTx: 'https://sepolia.etherscan.io/tx/',
    avgBlockTime: 12,
  },
};

/**
 * Get chain configuration
 */
export function getChain(name: ChainName): ChainConfig {
  const config = CHAINS[name];
  if (!config) {
    throw new Error(`Unsupported chain: ${name}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  }
  return config;
}

/**
 * List all supported chains
 */
export function listChains(): ChainName[] {
  return Object.keys(CHAINS) as ChainName[];
}

/**
 * Get chain config by chainId
 */
export function getChainById(chainId: number): ChainConfig | undefined {
  return Object.values(CHAINS).find(c => c.chainId === chainId);
}

/**
 * ERC20 ABI (minimal, only required methods)
 */
export const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function nonces(address owner) view returns (uint256)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
];

export type { ChainConfig, ChainName };
