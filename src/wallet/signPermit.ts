/**
 * signPermit - Agent signs EIP-2612 Permit to authorize another address to spend USDC
 * 
 * Used for Agent-to-Agent payments where the client agent authorizes
 * the service provider to pull payment.
 */

import { ethers } from 'ethers';
import { getChain, ERC20_ABI } from '../chains/index.js';
import type { ChainName } from '../types/index.js';

export interface SignPermitParams {
  /** Spender address (service provider's wallet) */
  spender: string;
  /** Amount in USDC (e.g., 0.99) */
  amount: number;
  /** Deadline timestamp (Unix seconds) or minutes from now if < 1000000 */
  deadline?: number;
}

export interface SignPermitResult {
  /** Permit owner (signer's address) */
  owner: string;
  /** Authorized spender */
  spender: string;
  /** Authorized amount (raw, 6 decimals) */
  value: string;
  /** Expiration timestamp */
  deadline: number;
  /** Nonce used */
  nonce: number;
  /** Signature v */
  v: number;
  /** Signature r */
  r: string;
  /** Signature s */
  s: string;
}

export interface SignPermitConfig {
  chain?: ChainName;
  privateKey?: string;
  rpcUrl?: string;
}

/**
 * Sign an EIP-2612 Permit
 * 
 * @example
 * ```typescript
 * import { signPermit } from 'moltspay';
 * 
 * const permit = await signPermit(
 *   { chain: 'base', privateKey: process.env.WALLET_KEY },
 *   { 
 *     spender: '0xZen7Wallet...',
 *     amount: 0.99,
 *     deadline: 30  // 30 minutes from now
 *   }
 * );
 * 
 * // Send permit to service provider
 * await fetch('https://service/api/pay', {
 *   body: JSON.stringify({ permit })
 * });
 * ```
 */
export async function signPermit(
  config: SignPermitConfig,
  params: SignPermitParams
): Promise<SignPermitResult> {
  const chain = config.chain || 'base';
  const chainConfig = getChain(chain);
  
  const privateKey = config.privateKey || process.env.PAYMENT_AGENT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('privateKey is required');
  }
  
  const rpcUrl = config.rpcUrl || chainConfig.rpc;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  
  // Get USDC contract for nonce
  const usdcContract = new ethers.Contract(chainConfig.usdc, ERC20_ABI, provider);
  const nonce = Number(await usdcContract.nonces(wallet.address));
  
  // Parse deadline
  let deadline: number;
  if (!params.deadline) {
    deadline = Math.floor(Date.now() / 1000) + 30 * 60; // 30 min default
  } else if (params.deadline < 1000000) {
    // Treat as minutes from now
    deadline = Math.floor(Date.now() / 1000) + params.deadline * 60;
  } else {
    deadline = params.deadline;
  }
  
  // Convert amount to raw value (6 decimals for USDC)
  const value = BigInt(Math.floor(params.amount * 1e6)).toString();
  
  // EIP-712 Domain
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: chainConfig.chainId,
    verifyingContract: chainConfig.usdc,
  };
  
  // EIP-712 Types
  const types = {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  
  // Message to sign
  const message = {
    owner: wallet.address,
    spender: params.spender,
    value: value,
    nonce: nonce,
    deadline: deadline,
  };
  
  // Sign
  const signature = await wallet.signTypedData(domain, types, message);
  const sig = ethers.Signature.from(signature);
  
  return {
    owner: wallet.address,
    spender: params.spender,
    value: value,
    deadline: deadline,
    nonce: nonce,
    v: sig.v,
    r: sig.r,
    s: sig.s,
  };
}

/**
 * Convenient class method version
 */
export class PermitSigner {
  private config: SignPermitConfig;
  
  constructor(config: SignPermitConfig) {
    this.config = config;
  }
  
  async sign(params: SignPermitParams): Promise<SignPermitResult> {
    return signPermit(this.config, params);
  }
}
