/**
 * BNB PaymentIntent typed-data builder (pure).
 *
 * Used on BNB Smart Chain (mainnet 56, testnet 97) where the user has already
 * approved the MoltsPay spender contract (via `npx moltspay approve` on CLI,
 * or `client.approveBnb()` on Web) and now signs an EIP-712 intent that
 * authorizes a specific spender → payTo transfer for a specific service.
 *
 * The server's spender contract verifies the signature in `transferFrom`-like
 * flow and moves tokens from owner → payTo.
 */

import type { BnbPaymentIntent, TypedDataEnvelope } from './types.js';

export interface BuildBnbIntentArgs {
  /** Owner address (payer). */
  from: string;
  /** Recipient address (payTo). */
  to: string;
  /** Amount in token's smallest unit (BNB stablecoins use 18 decimals). */
  amount: string;
  /** Token contract address on BNB chain. */
  tokenAddress: string;
  /** Service ID the intent authorizes payment for. */
  service: string;
  /** Intent nonce — any uint256 value unique per (owner, service). Caller supplies. */
  nonce: number;
  /** Unix milliseconds when the intent expires. */
  deadline: number;
  /** Chain id (56 or 97). */
  chainId: number;
}

export const BNB_INTENT_TYPES = {
  PaymentIntent: [
    { name: 'from',     type: 'address' },
    { name: 'to',       type: 'address' },
    { name: 'amount',   type: 'uint256' },
    { name: 'token',    type: 'address' },
    { name: 'service',  type: 'string'  },
    { name: 'nonce',    type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const BNB_DOMAIN_NAME = 'MoltsPay';
export const BNB_DOMAIN_VERSION = '1';

export function buildBnbIntentTypedData(
  args: BuildBnbIntentArgs
): TypedDataEnvelope<BnbPaymentIntent> {
  const intent: BnbPaymentIntent = {
    from: args.from,
    to: args.to,
    amount: args.amount,
    token: args.tokenAddress,
    service: args.service,
    nonce: args.nonce,
    deadline: args.deadline,
  };

  return {
    domain: {
      name: BNB_DOMAIN_NAME,
      version: BNB_DOMAIN_VERSION,
      chainId: args.chainId,
    },
    types: BNB_INTENT_TYPES,
    primaryType: 'PaymentIntent',
    message: intent,
  };
}
