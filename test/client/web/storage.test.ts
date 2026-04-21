/**
 * SpendingLedger — localStorage-backed daily spending counter.
 *
 * Tests run without a real browser; we install a tiny in-memory shim on
 * `globalThis.localStorage` for each test and tear it down afterward.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SpendingLedger } from '../../../src/client/web/storage.js';
import { SpendingLimitExceededError } from '../../../src/client/core/errors.js';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  clear(): void {
    this.store.clear();
  }
}

describe('SpendingLedger', () => {
  let original: unknown;

  beforeEach(() => {
    original = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();
  });

  afterEach(() => {
    if (original === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage: unknown }).localStorage = original;
    }
    vi.useRealTimers();
  });

  it('blocks per-tx overage without touching storage', () => {
    const ledger = new SpendingLedger({ maxPerTx: 5, maxPerDay: 100 });
    expect(() => ledger.check(10)).toThrow(SpendingLimitExceededError);
    expect(ledger.todaySpending).toBe(0);
  });

  it('accumulates and blocks at the daily cap', () => {
    const ledger = new SpendingLedger({ maxPerTx: 100, maxPerDay: 10 });
    ledger.check(6);
    ledger.record(6);
    expect(ledger.todaySpending).toBe(6);
    expect(() => ledger.check(5)).toThrow(SpendingLimitExceededError);
    ledger.check(4);
    ledger.record(4);
    expect(ledger.todaySpending).toBe(10);
  });

  it('persists across instances via the same storage key', () => {
    const a = new SpendingLedger({ maxPerTx: 100, maxPerDay: 100, storageKey: 'custom:key' });
    a.record(7);
    const b = new SpendingLedger({ maxPerTx: 100, maxPerDay: 100, storageKey: 'custom:key' });
    expect(b.todaySpending).toBe(7);
  });

  it('resets across day boundaries', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-21T12:00:00Z'));

    const ledger = new SpendingLedger({ maxPerTx: 100, maxPerDay: 100 });
    ledger.record(5);
    expect(ledger.todaySpending).toBe(5);

    vi.setSystemTime(new Date('2026-04-22T12:00:00Z'));
    expect(ledger.todaySpending).toBe(0);
  });

  it('silently no-ops without localStorage', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    const ledger = new SpendingLedger({ maxPerTx: 100, maxPerDay: 100 });
    ledger.record(1);
    ledger.check(1);
    expect(ledger.todaySpending).toBe(0);
  });
});
