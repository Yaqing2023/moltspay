/**
 * x402 Protocol Support for MoltsPay
 * 
 * x402 is an open standard for HTTP-native payments.
 * When a server returns 402 Payment Required, the client can pay and retry.
 * 
 * @see https://x402.org
 * @see https://github.com/coinbase/x402
 */

// Re-export easy-to-use client
export { createX402Client, x402Fetch, isX402Available } from './client.js';
export type { X402Client, X402ClientConfig } from './client.js';

import { ethers } from 'ethers';
import { getChain } from '../chains/index.js';
import type { ChainName } from '../types/index.js';

// x402 protocol version
export const X402_VERSION = 2;

// Header names
export const PAYMENT_REQUIRED_HEADER = 'x-payment-required';
export const PAYMENT_HEADER = 'x-payment';
export const PAYMENT_RESPONSE_HEADER = 'x-payment-response';

/**
 * x402 Payment Requirements (from server 402 response)
 */
export interface X402PaymentRequirements {
  /** Scheme (e.g., "exact") */
  scheme: string;
  /** Network (e.g., "eip155:8453" for Base) */
  network: string;
  /** Maximum amount in base units (e.g., "990000" for 0.99 USDC) */
  maxAmountRequired: string;
  /** Payee address */
  resource: string;
  /** Payment description */
  description?: string;
  /** MIME type of the resource */
  mimeType?: string;
  /** Output schema for the resource */
  outputSchema?: unknown;
  /** Expiration timestamp */
  expiration?: number;
  /** Extra data */
  extra?: string;
}

/**
 * x402 Payment Payload (client sends to server)
 */
export interface X402PaymentPayload {
  /** x402 protocol version */
  x402Version: number;
  /** Scheme used */
  scheme: string;
  /** Network used */
  network: string;
  /** Scheme-specific payload */
  payload: unknown;
}

/**
 * Parse x402 Payment Required header from 402 response
 */
export function parsePaymentRequired(header: string): X402PaymentRequirements[] {
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error('Invalid x-payment-required header');
  }
}

/**
 * Encode payment payload for x-payment header
 */
export function encodePaymentPayload(payload: X402PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

/**
 * Convert chain name to x402 network identifier
 */
export function chainToNetwork(chain: ChainName): string {
  const chainConfig = getChain(chain);
  return `eip155:${chainConfig.chainId}`;
}

/**
 * Convert x402 network identifier to chain name
 */
export function networkToChain(network: string): ChainName | null {
  const match = network.match(/^eip155:(\d+)$/);
  if (!match) return null;
  
  const chainId = parseInt(match[1]);
  
  // Map chain IDs to names
  const chainMap: Record<number, ChainName> = {
    8453: 'base',
    84532: 'base_sepolia',
    137: 'polygon',
    1: 'ethereum',
    11155111: 'sepolia',
  };
  
  return chainMap[chainId] || null;
}

/**
 * EIP-3009 Authorization for USDC transferWithAuthorization
 */
export interface EIP3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * Sign EIP-3009 transferWithAuthorization
 * Used for x402 "exact" scheme with USDC
 */
export async function signEIP3009(
  wallet: ethers.Wallet,
  params: {
    to: string;
    amount: number;
    validAfter?: number;
    validBefore?: number;
    chain: ChainName;
  }
): Promise<{
  authorization: EIP3009Authorization;
  signature: string;
}> {
  const chainConfig = getChain(params.chain);
  
  const validAfter = params.validAfter || 0;
  const validBefore = params.validBefore || Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const value = BigInt(Math.floor(params.amount * 1e6)).toString();
  
  const authorization: EIP3009Authorization = {
    from: wallet.address,
    to: params.to,
    value,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };
  
  // EIP-712 domain for USDC
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: chainConfig.chainId,
    verifyingContract: chainConfig.usdc,
  };
  
  // EIP-3009 types
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  
  const signature = await wallet.signTypedData(domain, types, authorization);
  
  return { authorization, signature };
}

/**
 * Create x402 payment payload for "exact" scheme on EVM
 */
export async function createExactEvmPayload(
  wallet: ethers.Wallet,
  requirements: X402PaymentRequirements,
  chain: ChainName
): Promise<X402PaymentPayload> {
  const amount = Number(requirements.maxAmountRequired) / 1e6;
  
  const { authorization, signature } = await signEIP3009(wallet, {
    to: requirements.resource,
    amount,
    chain,
  });
  
  return {
    x402Version: X402_VERSION,
    scheme: 'exact',
    network: chainToNetwork(chain),
    payload: {
      signature,
      authorization,
    },
  };
}

/**
 * Wrap fetch to handle x402 402 responses automatically
 * 
 * @example
 * ```typescript
 * import { AgentWallet } from 'moltspay';
 * import { wrapFetchWith402 } from 'moltspay/x402';
 * 
 * const wallet = new AgentWallet({ chain: 'base' });
 * const fetch402 = wrapFetchWith402(fetch, wallet);
 * 
 * // Automatically handles 402 and pays
 * const response = await fetch402('https://api.example.com/paid-resource');
 * ```
 */
export function wrapFetchWith402(
  fetchFn: typeof fetch,
  wallet: { address: string; chain: ChainName },
  privateKey: string
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Make initial request
    const response = await fetchFn(input, init);
    
    // If not 402, return as-is
    if (response.status !== 402) {
      return response;
    }
    
    // Get payment requirements
    const paymentRequiredHeader = response.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!paymentRequiredHeader) {
      return response; // No x402 header, return original 402
    }
    
    try {
      const requirements = parsePaymentRequired(paymentRequiredHeader);
      
      // Find a requirement we can fulfill
      const network = chainToNetwork(wallet.chain);
      const matching = requirements.find(r => 
        r.scheme === 'exact' && r.network === network
      );
      
      if (!matching) {
        console.warn('[x402] No matching payment requirement for', network);
        return response;
      }
      
      // Create payment payload
      const provider = new ethers.JsonRpcProvider(getChain(wallet.chain).rpc);
      const signer = new ethers.Wallet(privateKey, provider);
      
      const payload = await createExactEvmPayload(signer, matching, wallet.chain);
      const paymentHeader = encodePaymentPayload(payload);
      
      // Retry with payment
      const retryInit: RequestInit = {
        ...init,
        headers: {
          ...init?.headers,
          [PAYMENT_HEADER]: paymentHeader,
        },
      };
      
      return fetchFn(input, retryInit);
    } catch (error) {
      console.error('[x402] Payment failed:', error);
      return response;
    }
  };
}

/**
 * Server-side: Generate x402 Payment Required response
 */
export function createPaymentRequiredResponse(
  requirements: X402PaymentRequirements[]
): { status: 402; headers: Record<string, string> } {
  const encoded = Buffer.from(JSON.stringify(requirements)).toString('base64');
  
  return {
    status: 402,
    headers: {
      [PAYMENT_REQUIRED_HEADER]: encoded,
      'Content-Type': 'application/json',
    },
  };
}

/**
 * Server-side: Verify x402 payment header
 */
export function verifyPaymentHeader(
  header: string,
  expectedRecipient: string,
  expectedAmount: number
): {
  valid: boolean;
  error?: string;
  payload?: X402PaymentPayload;
} {
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    const payload: X402PaymentPayload = JSON.parse(decoded);
    
    if (payload.x402Version !== X402_VERSION) {
      return { valid: false, error: `Unsupported x402 version: ${payload.x402Version}` };
    }
    
    if (payload.scheme !== 'exact') {
      return { valid: false, error: `Unsupported scheme: ${payload.scheme}` };
    }
    
    // For EIP-3009 payload
    const eip3009 = payload.payload as { authorization: EIP3009Authorization; signature: string };
    
    if (eip3009.authorization.to.toLowerCase() !== expectedRecipient.toLowerCase()) {
      return { valid: false, error: 'Payment recipient mismatch' };
    }
    
    const amount = Number(eip3009.authorization.value) / 1e6;
    if (amount < expectedAmount) {
      return { valid: false, error: `Insufficient amount: ${amount} < ${expectedAmount}` };
    }
    
    // TODO: Verify signature on-chain
    
    return { valid: true, payload };
  } catch (error) {
    return { valid: false, error: (error as Error).message };
  }
}
