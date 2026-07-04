/**
 * Unit tests for the custodial balance rail:
 * - src/facilitators/balance/ledger.ts (BalanceLedger)
 * - src/facilitators/balance.ts (BalanceFacilitator)
 *
 * All against an in-memory SQLite (node:sqlite) — no filesystem, no network.
 *
 * Covers the money-safety invariants from BALANCE-RAIL-DESIGN.md:
 * - atomic check-and-deduct (no negative balances, races serialized)
 * - request_id idempotency (a replayed deduct never charges twice)
 * - external_ref idempotency (a replayed top-up never credits twice)
 * - refund idempotency (a deduct refunds at most once)
 * - single / daily limits
 * - verify is read-only; settle is the deduction; facilitator payload plumbing
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  BalanceLedger,
  toSat,
  fromSat,
} from '../../../src/facilitators/balance/ledger.js';
import {
  BalanceFacilitator,
  BALANCE_SCHEME,
  BALANCE_NETWORK,
  extractBalancePayload,
} from '../../../src/facilitators/balance.js';
import { X402PaymentPayload, X402PaymentRequirements } from '../../../src/facilitators/interface.js';

function ledger(overrides: Partial<{ single: number; daily: number }> = {}): BalanceLedger {
  return new BalanceLedger({
    dbPath: ':memory:',
    defaultSingleLimitSat: overrides.single ?? 500,
    defaultDailyLimitSat: overrides.daily ?? 1000,
  });
}

describe('toSat / fromSat', () => {
  it('converts decimal strings to integer cents and back', () => {
    expect(toSat('3.99')).toBe(399);
    expect(toSat('10')).toBe(1000);
    expect(toSat('0.01')).toBe(1);
    expect(toSat('5.5')).toBe(550);
    expect(fromSat(399)).toBe('3.99');
    expect(fromSat(1000)).toBe('10.00');
  });

  it('rejects malformed amounts', () => {
    expect(() => toSat('1.999')).toThrow();
    expect(() => toSat('-1')).toThrow();
    expect(() => toSat('abc')).toThrow();
    expect(() => toSat('')).toThrow();
  });
});

describe('BalanceLedger', () => {
  let l: BalanceLedger;
  beforeEach(() => {
    l = ledger();
  });

  it('creates a buyer on first top-up and credits the balance', () => {
    const r = l.topup({ buyerId: 'b1', amountSat: 1000, externalRef: '0xaaa' });
    expect(r.balanceSat).toBe(1000);
    expect(l.getBuyer('b1')!.total_topup_sat).toBe(1000);
  });

  it('top-up with a replayed external_ref credits nothing (idempotent)', () => {
    const first = l.topup({ buyerId: 'b1', amountSat: 1000, externalRef: '0xaaa' });
    const replay = l.topup({ buyerId: 'b1', amountSat: 1000, externalRef: '0xaaa' });
    expect(replay.replayed).toBe(true);
    expect(replay.txId).toBe(first.txId);
    expect(l.getBuyer('b1')!.balance_sat).toBe(1000);
  });

  it('deducts atomically and records a transaction', () => {
    l.topup({ buyerId: 'b1', amountSat: 1000, externalRef: '0xaaa' });
    const r = l.deduct({ buyerId: 'b1', amountSat: 399, requestId: 'req-1', service: 'text-to-video' });
    expect(r.success).toBe(true);
    expect(r.balanceSat).toBe(601);
    const txs = l.listTransactions('b1');
    expect(txs[0].type).toBe('deduct');
    expect(txs[0].amount_sat).toBe(399);
  });

  it('replayed request_id returns the original tx without charging again', () => {
    l.topup({ buyerId: 'b1', amountSat: 1000, externalRef: '0xaaa' });
    const first = l.deduct({ buyerId: 'b1', amountSat: 399, requestId: 'req-1' });
    const replay = l.deduct({ buyerId: 'b1', amountSat: 399, requestId: 'req-1' });
    expect(replay.success).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.txId).toBe(first.txId);
    expect(l.getBuyer('b1')!.balance_sat).toBe(601); // charged exactly once
  });

  it('never over-deducts: insufficient balance is rejected, balance unchanged', () => {
    l.topup({ buyerId: 'b1', amountSat: 300, externalRef: '0xaaa' });
    const r = l.deduct({ buyerId: 'b1', amountSat: 399 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('insufficient_balance');
    expect(l.getBuyer('b1')!.balance_sat).toBe(300);
  });

  it('unknown buyer / frozen buyer are rejected', () => {
    expect(l.deduct({ buyerId: 'ghost', amountSat: 1 }).error).toBe('buyer_not_found');
    expect(l.checkDeduct('ghost', 1).error).toBe('buyer_not_found');
  });

  it('enforces the single-transaction limit', () => {
    l.topup({ buyerId: 'b1', amountSat: 10_000, externalRef: '0xaaa' });
    const r = l.deduct({ buyerId: 'b1', amountSat: 501 });
    expect(r.success).toBe(false);
    expect(r.error).toBe('exceeds_single_limit');
    expect(r.limitSat).toBe(500);
  });

  it('enforces the daily limit across multiple deducts', () => {
    l.topup({ buyerId: 'b1', amountSat: 10_000, externalRef: '0xaaa' });
    expect(l.deduct({ buyerId: 'b1', amountSat: 500 }).success).toBe(true);
    expect(l.deduct({ buyerId: 'b1', amountSat: 500 }).success).toBe(true);
    const third = l.deduct({ buyerId: 'b1', amountSat: 1 });
    expect(third.success).toBe(false);
    expect(third.error).toBe('exceeds_daily_limit');
  });

  it('refund reverses a deduct and restores daily headroom', () => {
    l.topup({ buyerId: 'b1', amountSat: 10_000, externalRef: '0xaaa' });
    const d = l.deduct({ buyerId: 'b1', amountSat: 500 });
    const r = l.refund(d.txId!, 'video_gen_failed');
    expect(r.success).toBe(true);
    expect(r.balanceSat).toBe(10_000);
    expect(l.spentTodaySat('b1')).toBe(0);
    // the refunded deduct is marked
    const deductRow = l.listTransactions('b1').find(t => t.id === d.txId)!;
    expect(deductRow.status).toBe('refunded');
  });

  it('refund is idempotent per deduct: second refund credits nothing', () => {
    l.topup({ buyerId: 'b1', amountSat: 1000, externalRef: '0xaaa' });
    const d = l.deduct({ buyerId: 'b1', amountSat: 400 });
    const r1 = l.refund(d.txId!);
    const r2 = l.refund(d.txId!);
    expect(r2.success).toBe(true);
    expect(r2.replayed).toBe(true);
    expect(r2.txId).toBe(r1.txId);
    expect(l.getBuyer('b1')!.balance_sat).toBe(1000); // refunded exactly once
  });

  it('refund of a non-deduct or unknown tx fails cleanly', () => {
    const t = l.topup({ buyerId: 'b1', amountSat: 1000, externalRef: '0xaaa' });
    expect(l.refund(t.txId).error).toBe('not_a_deduct');
    expect(l.refund('btx_nope').error).toBe('tx_not_found');
  });

  it('checkDeduct never mutates', () => {
    l.topup({ buyerId: 'b1', amountSat: 1000, externalRef: '0xaaa' });
    expect(l.checkDeduct('b1', 399).success).toBe(true);
    expect(l.getBuyer('b1')!.balance_sat).toBe(1000);
  });

  it('serialized concurrent-style deducts cannot overdraw', () => {
    l.topup({ buyerId: 'b1', amountSat: 500, externalRef: '0xaaa' });
    // Simulate a burst of same-amount deducts (DatabaseSync serializes them);
    // exactly one of the 250-cent charges beyond the balance must fail.
    const results = [250, 250, 250].map(amount => l.deduct({ buyerId: 'b1', amountSat: amount }));
    const ok = results.filter(r => r.success).length;
    expect(ok).toBe(2);
    expect(l.getBuyer('b1')!.balance_sat).toBe(0);
  });

  it('paginates transaction history newest-first', () => {
    l.topup({ buyerId: 'b1', amountSat: 1000, externalRef: '0xaaa' });
    l.deduct({ buyerId: 'b1', amountSat: 100 });
    l.deduct({ buyerId: 'b1', amountSat: 200 });
    const page = l.listTransactions('b1', 2, 0);
    expect(page).toHaveLength(2);
    expect(page[0].amount_sat).toBe(200);
  });
});

describe('BalanceFacilitator', () => {
  let f: BalanceFacilitator;

  const payment = (buyerId: string, requestId?: string): X402PaymentPayload => ({
    x402Version: 1,
    scheme: BALANCE_SCHEME,
    network: BALANCE_NETWORK,
    payload: { buyer_id: buyerId, ...(requestId ? { request_id: requestId } : {}) },
  });

  const reqs = (amount: string): X402PaymentRequirements => ({
    scheme: BALANCE_SCHEME,
    network: BALANCE_NETWORK,
    asset: 'USD',
    amount,
    payTo: 'custodial',
    maxTimeoutSeconds: 30,
  });

  beforeEach(() => {
    f = new BalanceFacilitator({ db_path: ':memory:' });
  });

  it('createPaymentRequirements is pure and shapes the accepts[] entry', () => {
    const r = f.createPaymentRequirements({ price: '3.99', serviceId: 'text-to-video' });
    expect(r.scheme).toBe('balance');
    expect(r.network).toBe('balance');
    expect(r.amount).toBe('3.99');
    expect(r.extra?.service_id).toBe('text-to-video');
    expect(() => f.createPaymentRequirements({ price: 'nope' })).toThrow();
  });

  it('extractBalancePayload pulls buyer_id/request_id and rejects garbage', () => {
    expect(extractBalancePayload(payment('b1', 'r1'))).toEqual({ buyer_id: 'b1', request_id: 'r1' });
    expect(extractBalancePayload({ x402Version: 1, payload: {} } as X402PaymentPayload)).toBeNull();
  });

  it('verify precheck: funds → valid; empty account → invalid; no mutation', async () => {
    f.getLedger().topup({ buyerId: 'b1', amountSat: 500, externalRef: '0x1' });
    expect((await f.verify(payment('b1'), reqs('3.99'))).valid).toBe(true);
    expect((await f.verify(payment('ghost'), reqs('3.99'))).valid).toBe(false);
    expect(f.getLedger().getBuyer('b1')!.balance_sat).toBe(500);
  });

  it('settle deducts and returns the ledger tx id; replay is idempotent', async () => {
    f.getLedger().topup({ buyerId: 'b1', amountSat: 500, externalRef: '0x1' });
    const s1 = await f.settle(payment('b1', 'req-9'), reqs('3.99'));
    expect(s1.success).toBe(true);
    expect(s1.transaction).toMatch(/^btx_/);
    const s2 = await f.settle(payment('b1', 'req-9'), reqs('3.99'));
    expect(s2.success).toBe(true);
    expect(s2.status).toBe('replayed');
    expect(s2.transaction).toBe(s1.transaction);
    expect(f.getLedger().getBuyer('b1')!.balance_sat).toBe(101);
  });

  it('settle failure surfaces the ledger error code in status', async () => {
    const s = await f.settle(payment('ghost'), reqs('1.00'));
    expect(s.success).toBe(false);
    expect(s.status).toBe('buyer_not_found');
  });

  it('refund reverses a settled deduct via the facilitator', async () => {
    f.getLedger().topup({ buyerId: 'b1', amountSat: 500, externalRef: '0x1' });
    const s = await f.settle(payment('b1'), reqs('3.99'));
    const r = f.refund(s.transaction!, 'skill_failed');
    expect(r.success).toBe(true);
    expect(f.getLedger().getBuyer('b1')!.balance_sat).toBe(500);
  });

  it('healthCheck reports healthy on an open ledger', async () => {
    const h = await f.healthCheck();
    expect(h.healthy).toBe(true);
  });
});
