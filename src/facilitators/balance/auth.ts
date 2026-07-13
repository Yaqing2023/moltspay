/**
 * Custodial balance rail — user authentication (originator signature).
 *
 * The balance rail is password-free by design (a bare `buyer_id` deducts).
 * This adds a per-request signature so only the holder of the account's
 * bound key can spend it. The signer is an EVM key (reuses the client's
 * ethers wallet); the server recovers the address from the signature via
 * EIP-191 `personal_sign` — no public key is transmitted or stored beyond
 * the recovered address.
 *
 * TOFU binding + rollout live at the call site (see handleBalanceExecute):
 * `auth_mode` = off | shadow | enforce.
 *
 * @see ../../../docs/2026-07-13-wechat-fiat-auth-design.md
 */
import { ethers } from 'ethers';

/** Domain tag — separates these signatures from any other message a key signs. */
export const BALANCE_AUTH_DOMAIN = 'moltspay-balance-auth:v1';

/** Accepted clock skew between client timestamp and server (replay window). */
export const BALANCE_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;

/** Rollout gate for balance-rail user auth. */
export type BalanceAuthMode = 'off' | 'shadow' | 'enforce';

/** Signature material carried in the balance X-Payment payload. */
export interface BalanceAuthFields {
  /** Unix seconds when the client signed. */
  timestamp: number;
  /** EIP-191 signature over {@link buildDeductMessage}. */
  signature: string;
}

/** Extract auth fields from an untrusted payload object, or null. */
export function extractBalanceAuth(raw: unknown): BalanceAuthFields | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  if (typeof a.signature === 'string' && a.signature && typeof a.timestamp === 'number' && Number.isFinite(a.timestamp)) {
    return { timestamp: a.timestamp, signature: a.signature };
  }
  return null;
}

/**
 * Canonical message a client signs to authorize one deduction. Both sides
 * MUST build this identically. `amount` is intentionally omitted — the
 * service id determines the price server-side, and `request_id` (unique per
 * charge) + `timestamp` (windowed) already bound replay.
 */
export function buildDeductMessage(f: {
  buyerId: string;
  requestId: string;
  service: string;
  timestamp: number;
}): string {
  return [BALANCE_AUTH_DOMAIN, 'balance-deduct', f.buyerId, f.requestId, f.service, String(f.timestamp)].join('\n');
}

export interface AuthVerifyResult {
  ok: boolean;
  /** Recovered signer address (lowercase 0x…), present when the signature parsed. */
  recovered?: string;
  /** Failure code when `ok` is false: no_signature | malformed | timestamp_skew | bad_signature. */
  reason?: string;
}

/**
 * Verify a deduction signature and recover the signer address. Never throws.
 * Does NOT decide binding/enforcement — the caller compares `recovered`
 * against the account's bound signer and applies `auth_mode`.
 */
export function verifyDeductAuth(opts: {
  auth: BalanceAuthFields | null;
  buyerId: string;
  requestId: string;
  service: string;
  nowMs: number;
}): AuthVerifyResult {
  const { auth } = opts;
  if (!auth) return { ok: false, reason: 'no_signature' };
  if (!auth.signature || !Number.isFinite(auth.timestamp)) return { ok: false, reason: 'malformed' };
  if (Math.abs(opts.nowMs - auth.timestamp * 1000) > BALANCE_AUTH_MAX_SKEW_MS) {
    return { ok: false, reason: 'timestamp_skew' };
  }
  const message = buildDeductMessage({
    buyerId: opts.buyerId,
    requestId: opts.requestId,
    service: opts.service,
    timestamp: auth.timestamp,
  });
  try {
    const recovered = ethers.verifyMessage(message, auth.signature).toLowerCase();
    return { ok: true, recovered };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}
