/**
 * Solana Chain Configuration
 * 
 * Solana is NOT an EVM chain - uses different:
 * - Key format: ed25519 (EdDSA) vs secp256k1 (ECDSA)
 * - Address format: Base58 vs 0x hex
 * - Token standard: SPL vs ERC-20
 */

import { Connection, PublicKey } from '@solana/web3.js';

export interface SolanaChainConfig {
  name: string;
  cluster: 'mainnet-beta' | 'devnet' | 'testnet';
  rpc: string;
  explorer: string;
  explorerTx: string;
  tokens: {
    USDC: {
      mint: string;
      decimals: number;
    };
  };
}

export type SolanaChainName = 'solana' | 'solana_devnet';

export const SOLANA_CHAINS: Record<SolanaChainName, SolanaChainConfig> = {
  solana: {
    name: 'Solana Mainnet',
    cluster: 'mainnet-beta',
    rpc: 'https://api.mainnet-beta.solana.com',
    explorer: 'https://solscan.io/account/',
    explorerTx: 'https://solscan.io/tx/',
    tokens: {
      USDC: {
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Circle official USDC
        decimals: 6,
      },
    },
  },
  solana_devnet: {
    name: 'Solana Devnet',
    cluster: 'devnet',
    rpc: 'https://api.devnet.solana.com',
    explorer: 'https://solscan.io/account/',
    explorerTx: 'https://solscan.io/tx/',
    tokens: {
      USDC: {
        // Circle's devnet USDC (if not available, we'll deploy our own test token)
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        decimals: 6,
      },
    },
  },
};

/**
 * Get Solana RPC connection
 */
export function getSolanaConnection(chain: SolanaChainName): Connection {
  const config = SOLANA_CHAINS[chain];
  return new Connection(config.rpc, 'confirmed');
}

/**
 * Get USDC mint public key for a Solana chain
 */
export function getUSDCMint(chain: SolanaChainName): PublicKey {
  return new PublicKey(SOLANA_CHAINS[chain].tokens.USDC.mint);
}

/**
 * Get Solana chain config
 */
export function getSolanaChain(name: SolanaChainName): SolanaChainConfig {
  const config = SOLANA_CHAINS[name];
  if (!config) {
    throw new Error(`Unsupported Solana chain: ${name}. Supported: ${Object.keys(SOLANA_CHAINS).join(', ')}`);
  }
  return config;
}

/**
 * Check if a chain name is a Solana chain
 */
export function isSolanaChain(chain: string): chain is SolanaChainName {
  return chain === 'solana' || chain === 'solana_devnet';
}

/**
 * Get explorer URL for a Solana address
 */
export function getSolanaExplorerUrl(chain: SolanaChainName, address: string): string {
  const config = SOLANA_CHAINS[chain];
  const clusterParam = chain === 'solana_devnet' ? '?cluster=devnet' : '';
  return `${config.explorer}${address}${clusterParam}`;
}

/**
 * Get explorer URL for a Solana transaction
 */
export function getSolanaTxExplorerUrl(chain: SolanaChainName, signature: string): string {
  const config = SOLANA_CHAINS[chain];
  const clusterParam = chain === 'solana_devnet' ? '?cluster=devnet' : '';
  return `${config.explorerTx}${signature}${clusterParam}`;
}
