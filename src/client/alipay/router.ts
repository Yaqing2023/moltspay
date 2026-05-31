/**
 * Rail routing (design §5.2.5).
 *
 * 1.6.0 and earlier, a service accepted exactly one payment method. With the
 * 1.7.0 Alipay rail the server's 402 `accepts[]` can carry BOTH crypto
 * (USDC on Base, …) and fiat (CNY via Alipay). `selectRail` picks one,
 * deterministically, from the caller's intent + the server's offer.
 *
 * Pure function — no Node-only imports, safe in the Web bundle.
 */

import type { X402PaymentRequirements } from '../core/types.js';
import { networkToChainName } from '../core/chain-map.js';
import { UnsupportedRailError } from './errors.js';

/** Rail identifier as used in `{ rail }` / `--rail`: 'alipay' or a chain name. */
export const ALIPAY_RAIL = 'alipay';

export interface RailAvailability {
  /** Caller has an EVM wallet able to pay (e.g. funded USDC). */
  evmReady?: boolean;
  /** alipay-bot is installed/online and a wallet is opened. */
  alipayReady?: boolean;
}

export interface SelectRailInput {
  /** The server's 402 `accepts[]`. */
  serverAccepts: X402PaymentRequirements[];
  /** Explicit caller choice from `{ rail }` / `--rail`. Highest priority. */
  explicitRail?: string;
  /** Client-configured ordered preference (e.g. `["base", "alipay"]`). */
  preference?: string[];
  /** What the caller can actually do right now. */
  availability?: RailAvailability;
}

export interface RailSelection {
  rail: string;
  requirement: X402PaymentRequirements;
}

/**
 * Map a single 402 accepts entry to its rail identifier.
 * Alipay → 'alipay'; EVM/SVM → the chain name; unknown → the raw network.
 */
export function railOf(req: X402PaymentRequirements): string {
  if (req.scheme === 'alipay-aipay' || req.network === ALIPAY_RAIL) return ALIPAY_RAIL;
  return networkToChainName(req.network) ?? req.network;
}

function findRail(accepts: X402PaymentRequirements[], rail: string): RailSelection | null {
  const requirement = accepts.find((r) => railOf(r) === rail);
  return requirement ? { rail, requirement } : null;
}

/**
 * Choose the rail to pay on. Decision order (design §5.2.5):
 *   1. explicitRail        → use it, else UnsupportedRailError
 *   2. preference list     → first entry that the server also accepts
 *   3. availability         → EVM if ready, else Alipay if ready
 *   4. fallback            → server accepts[0]
 */
export function selectRail(input: SelectRailInput): RailSelection {
  const { serverAccepts, explicitRail, preference, availability } = input;

  if (!serverAccepts || serverAccepts.length === 0) {
    throw new UnsupportedRailError(explicitRail ?? 'unknown', 'Server offered no payment options');
  }

  // 1. Explicit caller choice wins.
  if (explicitRail) {
    const hit = findRail(serverAccepts, explicitRail);
    if (!hit) {
      const offered = serverAccepts.map(railOf);
      throw new UnsupportedRailError(
        explicitRail,
        `Server doesn't accept rail '${explicitRail}'. Offered: ${offered.join(', ')}`,
      );
    }
    return hit;
  }

  // 2. Client-configured ordered preference ∩ server offer.
  if (preference) {
    for (const pref of preference) {
      const hit = findRail(serverAccepts, pref);
      if (hit) return hit;
    }
  }

  // 3. Availability-based.
  if (availability?.evmReady) {
    const evm = serverAccepts.find((r) => railOf(r) !== ALIPAY_RAIL);
    if (evm) return { rail: railOf(evm), requirement: evm };
  }
  if (availability?.alipayReady) {
    const hit = findRail(serverAccepts, ALIPAY_RAIL);
    if (hit) return hit;
  }

  // 4. Fallback to the server's first offer.
  return { rail: railOf(serverAccepts[0]), requirement: serverAccepts[0] };
}
