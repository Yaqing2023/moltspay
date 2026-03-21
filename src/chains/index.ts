/**
 * Blockchain Configuration
 */

import type { ChainConfig, ChainName, EvmChainName, TokenSymbol } from '../types/index.js';

export const CHAINS: Record<EvmChainName, ChainConfig> = {
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
        eip712Name: 'USD Coin', // EIP-712 domain name
      },
      USDT: {
        address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
        decimals: 6,
        symbol: 'USDT',
        eip712Name: 'Tether USD',
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
        eip712Name: 'USD Coin',
      },
      USDT: {
        address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
        decimals: 6,
        symbol: 'USDT',
        eip712Name: '(PoS) Tether USD', // Polygon uses this name
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
        eip712Name: 'USDC', // Testnet USDC uses 'USDC' not 'USD Coin'
      },
      USDT: {
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Same as USDC on testnet (no official USDT)
        decimals: 6,
        symbol: 'USDT',
        eip712Name: 'USDC', // Uses same contract as USDC
      },
    },
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    explorer: 'https://sepolia.basescan.org/address/',
    explorerTx: 'https://sepolia.basescan.org/tx/',
    avgBlockTime: 2,
  },
  // ============ Tempo Testnet (Moderato) ============
  tempo_moderato: {
    name: 'Tempo Moderato',
    chainId: 42431,
    rpc: 'https://rpc.moderato.tempo.xyz',
    tokens: {
      // TIP-20 stablecoins on Tempo testnet (from mppx SDK)
      // Note: Tempo uses USD as native gas token, not ETH
      USDC: {
        address: '0x20c0000000000000000000000000000000000000', // pathUSD - primary testnet stablecoin
        decimals: 6,
        symbol: 'USDC',
        eip712Name: 'pathUSD',
      },
      USDT: {
        address: '0x20c0000000000000000000000000000000000001', // alphaUSD
        decimals: 6,
        symbol: 'USDT',
        eip712Name: 'alphaUSD',
      },
    },
    usdc: '0x20c0000000000000000000000000000000000000',
    explorer: 'https://explore.testnet.tempo.xyz/address/',
    explorerTx: 'https://explore.testnet.tempo.xyz/tx/',
    avgBlockTime: 0.5, // ~500ms finality
  },
  // ============ BNB Chain Testnet ============
  bnb_testnet: {
    name: 'BNB Testnet',
    chainId: 97,
    rpc: 'https://data-seed-prebsc-1-s1.binance.org:8545',
    tokens: {
      // Note: BNB uses 18 decimals for stablecoins (unlike Base/Polygon which use 6)
      // Using official Binance-Peg testnet tokens
      USDC: {
        address: '0x64544969ed7EBf5f083679233325356EbE738930', // Testnet USDC
        decimals: 18,
        symbol: 'USDC',
        eip712Name: 'USD Coin',
      },
      USDT: {
        address: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd', // Testnet USDT
        decimals: 18,
        symbol: 'USDT',
        eip712Name: 'Tether USD',
      },
    },
    usdc: '0x64544969ed7EBf5f083679233325356EbE738930',
    explorer: 'https://testnet.bscscan.com/address/',
    explorerTx: 'https://testnet.bscscan.com/tx/',
    avgBlockTime: 3,
    // BNB-specific: requires approval for pay-for-success flow
    requiresApproval: true,
  },
  // ============ BNB Chain Mainnet ============
  bnb: {
    name: 'BNB Smart Chain',
    chainId: 56,
    rpc: 'https://bsc-dataseed.binance.org',
    tokens: {
      // Note: BNB uses 18 decimals for stablecoins
      USDC: {
        address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
        decimals: 18,
        symbol: 'USDC',
        eip712Name: 'USD Coin',
      },
      USDT: {
        address: '0x55d398326f99059fF775485246999027B3197955',
        decimals: 18,
        symbol: 'USDT',
        eip712Name: 'Tether USD',
      },
    },
    usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    explorer: 'https://bscscan.com/address/',
    explorerTx: 'https://bscscan.com/tx/',
    avgBlockTime: 3,
    // BNB-specific: requires approval for pay-for-success flow
    requiresApproval: true,
  },
};

/**
 * Get token address for a chain
 */
export function getTokenAddress(chainName: EvmChainName, token: TokenSymbol): string {
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
export function getTokenConfig(chainName: EvmChainName, token: TokenSymbol) {
  const chain = CHAINS[chainName];
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainName}`);
  }
  return chain.tokens[token];
}

/**
 * Get chain configuration
 */
export function getChain(name: EvmChainName): ChainConfig {
  const config = CHAINS[name];
  if (!config) {
    throw new Error(`Unsupported chain: ${name}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  }
  return config;
}

/**
 * List all supported EVM chains
 */
export function listChains(): EvmChainName[] {
  return Object.keys(CHAINS) as EvmChainName[];
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

export type { ChainConfig, ChainName, EvmChainName, TokenSymbol };
