/**
 * Blockchain Configuration
 */

import type { ChainConfig, ChainName, TokenSymbol } from '../types/index.js';

export const CHAINS: Record<ChainName, ChainConfig> = {
  // ============ Mainnet ============
  base: {
    name: 'Base',
    chainId: 8453,
    rpc: 'https://mainnet.base.org',
    tokens: {
      USDC: {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        symbol: 'USDC',
      },
      USDT: {
        address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
        decimals: 6,
        symbol: 'USDT',
      },
    },
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // deprecated, for backward compat
    explorer: 'https://basescan.org/address/',
    explorerTx: 'https://basescan.org/tx/',
    avgBlockTime: 2,
  },
  polygon: {
    name: 'Polygon',
    chainId: 137,
    rpc: 'https://polygon-bor-rpc.publicnode.com',
    tokens: {
      USDC: {
        address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        decimals: 6,
        symbol: 'USDC',
      },
      USDT: {
        address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        decimals: 6,
        symbol: 'USDT',
      },
    },
    usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    explorer: 'https://polygonscan.com/address/',
    explorerTx: 'https://polygonscan.com/tx/',
    avgBlockTime: 2,
  },
  // ============ Testnet ============
  base_sepolia: {
    name: 'Base Sepolia',
    chainId: 84532,
    rpc: 'https://sepolia.base.org',
    tokens: {
      USDC: {
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
        symbol: 'USDC',
      },
      USDT: {
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Same as USDC on testnet (no official USDT)
        decimals: 6,
        symbol: 'USDT',
      },
    },
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org/address/',
    explorerTx: 'https://sepolia.basescan.org/tx/',
    avgBlockTime: 2,
  },
};

/**
 * Get token address for a chain
 */
export function getTokenAddress(chainName: ChainName, token: TokenSymbol): string {
  const chain = CHAINS[chainName];
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainName}`);
  }
  const tokenConfig = chain.tokens[token];
  if (!tokenConfig) {
    throw new Error(`Token ${token} not supported on ${chainName}`);
  }
  return tokenConfig.address;
}

/**
 * Get token config for a chain
 */
export function getTokenConfig(chainName: ChainName, token: TokenSymbol) {
  const chain = CHAINS[chainName];
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainName}`);
  }
  return chain.tokens[token];
}

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

export type { ChainConfig, ChainName, TokenSymbol };
