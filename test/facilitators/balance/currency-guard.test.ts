/**
 * P0 regression: the balance ledger records its quote currency once and
 * refuses to reopen under a different one.
 *
 * The minor unit (`*_sat`) is 1/100 of the ledger currency -- cents for USD,
 * fen for CNY -- so reopening a USD-funded ledger as CNY would silently
 * reinterpret every balance (7 sat = 0.07 USD vs 0.07 CNY). The guard turns
 * that into a hard startup error. See WECHAT-BALANCE-PASSWORDLESS-DESIGN.md P0.
 *
 * Uses a temp file (not ':memory:') so a second BalanceLedger reopens the
 * same db. No network, no money.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { BalanceLedger } from '../../../src/facilitators/balance/ledger.js';

describe('BalanceLedger currency guard', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ledger-currency-'));
    dbPath = path.join(dir, 'balance.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to USD and records it in ledger_meta on first init', () => {
    const l = new BalanceLedger({ dbPath });
    const meta = (l as any).db
      .prepare(`SELECT value FROM ledger_meta WHERE key = 'currency'`)
      .get() as { value: string } | undefined;
    expect(meta?.value).toBe('USD');
  });

  it('records the configured currency (CNY) on a fresh ledger', () => {
    const l = new BalanceLedger({ dbPath, currency: 'CNY' });
    const meta = (l as any).db
      .prepare(`SELECT value FROM ledger_meta WHERE key = 'currency'`)
      .get() as { value: string } | undefined;
    expect(meta?.value).toBe('CNY');
  });

  it('reopening the same currency is fine', () => {
    new BalanceLedger({ dbPath, currency: 'CNY' });
    expect(() => new BalanceLedger({ dbPath, currency: 'CNY' })).not.toThrow();
  });

  it('refuses to reopen a USD ledger under a CNY config', () => {
    new BalanceLedger({ dbPath }); // USD (default)
    expect(() => new BalanceLedger({ dbPath, currency: 'CNY' })).toThrow(
      /currency mismatch: db=USD config=CNY/,
    );
  });

  it('refuses to reopen a CNY ledger under a USD config', () => {
    new BalanceLedger({ dbPath, currency: 'CNY' });
    expect(() => new BalanceLedger({ dbPath, currency: 'USD' })).toThrow(
      /currency mismatch: db=CNY config=USD/,
    );
  });
});
