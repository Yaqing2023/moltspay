/**
 * x402 protocol primitives — pure, runtime-agnostic.
 *
 * Handles:
 *  - Decoding the `X-Payment-Required` header into a list of requirements
 *    (supporting v1 array / v2 object-with-accepts / single-object shapes).
 *  - Selecting the right requirement for a user-chosen chain.
 *  - Assembling and base64-encoding the `X-Payment` request header.
 *
 * All inputs and outputs are JSON-serializable. No network I/O, no signing.
 */

import {
  decodeBase64,
  encodeBase64,
} from './base64.js';
import {
  networkToChainName,
  chainNameToNetwork,
  type ChainName,
} from './chain-map.js';
import { InvalidPaymentHeaderError, UnsupportedChainError } from './errors.js';
import {
  X402_VERSION,
  type X402PaymentRequirements,
} from './types.js';

/**
 * Decode a base64-encoded `X-Payment-Required` header into an array of
 * requirement entries. Accepts all three observed shapes:
 *   - v1: `[req1, req2, ...]`
 *   - v2: `{ x402Version: 2, accepts: [req1, req2, ...] }`
 *   - single: `{ scheme, network, ... }`
 */
export function parsePaymentRequiredHeader(
  header: string
): X402PaymentRequirements[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64(header));
  } catch {
    throw new InvalidPaymentHeaderError('Invalid x-payment-required header');
  }

  if (Array.isArray(parsed)) {
    return parsed as X402PaymentRequirements[];
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { accepts?: unknown }).accepts)
  ) {
    return (parsed as { accepts: X402PaymentRequirements[] }).accepts;
  }
  // Single requirement object
  return [parsed as X402PaymentRequirements];
}

/** Collect the set of chain names the server accepts, from its requirements list. */
export function serverAcceptedChains(
  requirements: X402PaymentRequirements[]
): ChainName[] {
  return requirements
    .map(r => networkToChainName(r.network))
    .filter((c): c is ChainName => c !== null);
}

/**
 * Select the chain to pay on, using the 1.5.x rules:
 *   - If the caller specified a chain, it must be in the server's accepted set.
 *   - Otherwise, default to `base` **only** when `base` is the sole accepted chain;
 *     otherwise require the caller to be explicit.
 */
export function selectChain(
  requirements: X402PaymentRequirements[],
  userSpecifiedChain?: ChainName
): ChainName {
  const accepted = serverAcceptedChains(requirements);

  if (userSpecifiedChain) {
    if (!accepted.includes(userSpecifiedChain)) {
      throw new UnsupportedChainError(
        userSpecifiedChain,
        `Server doesn't accept '${userSpecifiedChain}'. Server accepts: ${accepted.join(', ')}`
      );
    }
    return userSpecifiedChain;
  }

  if (accepted.length === 1 && accepted[0] === 'base') {
    return 'base';
  }

  throw new UnsupportedChainError(
    'unspecified',
    `Server accepts: ${accepted.join(', ')}. Please specify a chain explicitly.`
  );
}

/** Find the requirement entry matching a given chain name. */
export function findRequirementForChain(
  requirements: X402PaymentRequirements[],
  chain: ChainName
): X402PaymentRequirements | null {
  const network = chainNameToNetwork(chain);
  return requirements.find(r => r.network === network) ?? null;
}

/** x402 v2 payment payload envelope, returned by the scheme-specific builders. */
export interface X402PaymentPayloadEnvelope {
  x402Version: typeof X402_VERSION;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
  accepted: X402PaymentRequirements;
}

/**
 * Assemble an x402 v2 payment payload.
 *
 * `payload` is scheme-specific (EIP-3009 authorization, EIP-2612 permit
 * struct, BNB intent, Solana signed transaction, etc.). `accepted` mirrors
 * the server's requirement so settlement can verify exact match.
 */
export function buildPaymentPayload(args: {
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
  accepted: X402PaymentRequirements;
}): X402PaymentPayloadEnvelope {
  return {
    x402Version: X402_VERSION,
    scheme: args.scheme,
    network: args.network,
    payload: args.payload,
    accepted: args.accepted,
  };
}

/** Base64-encode a payment payload for the `X-Payment` request header. */
export function encodePaymentHeader(
  payload: X402PaymentPayloadEnvelope | Record<string, unknown>
): string {
  return encodeBase64(JSON.stringify(payload));
}
