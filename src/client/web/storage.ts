/**
 * Browser-side spending limits — optional opt-in only. Mirrors the Node
 * CLI's daily-reset ledger but persists to `localStorage` instead of
 * `~/.moltspay/spending.json`.
 *
 * Default: disabled. Rationale (from docs/WEB-CLIENT-DESIGN.md §Spending
 * Limits on Web): external wallets already enforce per-signature policy,
 * per-browser localStorage limits don't sync, and the UX of silently
 * blocking a payment without consulting the wallet is worse than just
 * letting the wallet prompt. Apps that want session-level caps can still
 * opt in.
 */

import { SpendingLimitExceededError } from '../core/index.js';

export interface SpendingLimitsConfig {
  /** Maximum per single transaction. Currency-agnostic; measured in service units (USD). */
  maxPerTx: number;
  /** Maximum aggregate across the current calendar day (local time). */
  maxPerDay: number;
  /** `localStorage` key. Default: `moltspay:spending`. */
  storageKey?: string;
}

interface PersistedSpending {
  /** `Date.setHours(0,0,0,0)` of the day the counter started. */
  date: number;
  /** Sum of charges recorded today. */
  amount: number;
  updatedAt: number;
}

const DEFAULT_STORAGE_KEY = 'moltspay:spending';

/** Minimal shape of `window.localStorage` — the only surface we touch. */
interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Returns `globalThis.localStorage` if available, else `null` (non-browser runtime). */
function getStorage(): StorageLike | null {
  const g = globalThis as { localStorage?: StorageLike };
  return g.localStorage ?? null;
}

function todayKey(): number {
  return new Date().setHours(0, 0, 0, 0);
}

export class SpendingLedger {
  private readonly storageKey: string;
  private readonly maxPerTx: number;
  private readonly maxPerDay: number;

  constructor(config: SpendingLimitsConfig) {
    this.maxPerTx = config.maxPerTx;
    this.maxPerDay = config.maxPerDay;
    this.storageKey = config.storageKey ?? DEFAULT_STORAGE_KEY;
  }

  /** Load the persisted total for today. Fails silently on parse errors. */
  private read(): PersistedSpending {
    const storage = getStorage();
    const today = todayKey();
    if (!storage) return { date: today, amount: 0, updatedAt: Date.now() };
    try {
      const raw = storage.getItem(this.storageKey);
      if (!raw) return { date: today, amount: 0, updatedAt: Date.now() };
      const parsed = JSON.parse(raw) as PersistedSpending;
      if (parsed.date !== today) {
        // Stale day — reset in-memory. Disk is rewritten on next record.
        return { date: today, amount: 0, updatedAt: Date.now() };
      }
      return parsed;
    } catch {
      return { date: today, amount: 0, updatedAt: Date.now() };
    }
  }

  private write(entry: PersistedSpending): void {
    const storage = getStorage();
    if (!storage) return;
    try {
      storage.setItem(this.storageKey, JSON.stringify(entry));
    } catch {
      // Quota / disabled storage — non-fatal. Limits degrade to per-session only.
    }
  }

  /**
   * Throw `SpendingLimitExceededError` if the requested charge would push
   * per-tx or per-day limits over. Does NOT mutate state — callers record
   * only after the payment clears via {@link record}.
   */
  check(amount: number): void {
    if (amount > this.maxPerTx) {
      throw new SpendingLimitExceededError(
        `Amount $${amount} exceeds max per transaction ($${this.maxPerTx})`
      );
    }
    const current = this.read();
    if (current.amount + amount > this.maxPerDay) {
      throw new SpendingLimitExceededError(
        `Would exceed daily limit ($${current.amount} + $${amount} > $${this.maxPerDay})`
      );
    }
  }

  /** Persist a successful charge. Silently no-ops in non-browser runtimes. */
  record(amount: number): void {
    const current = this.read();
    this.write({
      date: current.date,
      amount: current.amount + amount,
      updatedAt: Date.now(),
    });
  }

  /** Current aggregate for the active day. Intended for UI display. */
  get todaySpending(): number {
    return this.read().amount;
  }

  /** Manually reset — mainly useful for tests. */
  reset(): void {
    this.write({ date: todayKey(), amount: 0, updatedAt: Date.now() });
  }
}
