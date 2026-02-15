/**
 * x402 Client - Easy HTTP client with automatic payment handling
 * 
 * Wraps @x402/fetch to provide simple API for AI Agents.
 * 
 * @example
 * ```typescript
 * import { createX402Client } from 'moltspay/x402';
 * 
 * // Using local wallet (AgentWallet)
 * const client = await createX402Client({ chain: 'base' });
 * 
 * // Using CDP wallet
 * const client = await createX402Client({ chain: 'base', useCDP: true });
 * 
 * // Make request - payment handled automatically
 * const response = await client.fetch('https://juai8.com/x402pay');
 * ```
 */

import type { ChainName } from '../types/index.js';
import { getChain } from '../chains/index.js';

export interface X402ClientConfig {
  /** Chain to use */
  chain?: ChainName;
  /** Use CDP wallet instead of local wallet */
  useCDP?: boolean;
  /** Custom private key (overrides stored wallet) */
  privateKey?: string;
  /** Storage directory for wallet */
  storageDir?: string;
}

export interface X402Client {
  /** Fetch with automatic x402 payment handling */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Wallet address */
  address: string;
  /** Chain being used */
  chain: ChainName;
}

/**
 * Check if @x402/fetch is available
 */
export function isX402Available(): boolean {
  try {
    require.resolve('@x402/fetch');
    require.resolve('@x402/evm');
    return true;
  } catch {
    return false;
  }
}

/**
 * Create x402 client using local AgentWallet
 */
async function createLocalX402Client(config: X402ClientConfig): Promise<X402Client> {
  const { AgentWallet } = await import('../agent/AgentWallet.js');
  const { ethers } = await import('ethers');
  
  const wallet = new AgentWallet({
    chain: config.chain,
    storageDir: config.storageDir,
  });

  // Load private key
  const fs = await import('fs');
  const path = await import('path');
  const storageDir = config.storageDir || path.join(process.env.HOME || '.', '.moltspay');
  const walletPath = path.join(storageDir, 'wallet.json');
  const walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  const privateKey = config.privateKey || walletData.privateKey;

  // Create viem account from private key
  const { privateKeyToAccount } = await import('viem/accounts');
  const signer = privateKeyToAccount(privateKey as `0x${string}`);

  // Create x402 client
  const { x402Client, wrapFetchWithPayment } = await import('@x402/fetch');
  const { registerExactEvmScheme } = await import('@x402/evm/exact/client');

  const client = new x402Client();
  registerExactEvmScheme(client, { signer });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  return {
    fetch: fetchWithPayment,
    address: wallet.address,
    chain: config.chain || 'base',
  };
}

/**
 * Create x402 client using CDP wallet
 */
async function createCDPX402Client(config: X402ClientConfig): Promise<X402Client> {
  const { CDPWallet } = await import('../cdp/index.js');
  
  const wallet = new CDPWallet({
    chain: config.chain,
    storageDir: config.storageDir,
  });

  // Get viem account from CDP
  const signer = await wallet.getViemAccount();

  // Create x402 client
  const { x402Client, wrapFetchWithPayment } = await import('@x402/fetch');
  const { registerExactEvmScheme } = await import('@x402/evm/exact/client');

  const client = new x402Client();
  registerExactEvmScheme(client, { signer: signer as any });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  return {
    fetch: fetchWithPayment,
    address: wallet.address,
    chain: config.chain || 'base',
  };
}

/**
 * Create x402 client
 * 
 * Automatically handles 402 Payment Required responses.
 * 
 * @example
 * ```typescript
 * import { createX402Client } from 'moltspay/x402';
 * 
 * const client = await createX402Client({ chain: 'base' });
 * 
 * // Request paid API - payment handled automatically
 * const response = await client.fetch('https://juai8.com/x402pay', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ prompt: 'a cat dancing' })
 * });
 * 
 * const result = await response.json();
 * ```
 */
export async function createX402Client(config: X402ClientConfig = {}): Promise<X402Client> {
  if (!isX402Available()) {
    throw new Error('x402 packages not installed. Run: npm install @x402/fetch @x402/evm');
  }

  if (config.useCDP) {
    return createCDPX402Client(config);
  } else {
    return createLocalX402Client(config);
  }
}

/**
 * Simple one-shot x402 request
 * 
 * For when you just need to make one paid request.
 * 
 * @example
 * ```typescript
 * import { x402Fetch } from 'moltspay/x402';
 * 
 * const response = await x402Fetch('https://juai8.com/x402pay', {
 *   method: 'POST',
 *   body: JSON.stringify({ prompt: 'a cat dancing' })
 * }, { chain: 'base' });
 * ```
 */
export async function x402Fetch(
  input: string | URL | Request,
  init?: RequestInit,
  config?: X402ClientConfig
): Promise<Response> {
  const client = await createX402Client(config);
  return client.fetch(input, init);
}
