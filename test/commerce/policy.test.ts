/**
 * Unit tests for the commerce policy layer (commerce-core):
 * - PolicyEngine: provider allow/deny, per-transaction cap, auto/approval threshold
 * - ApprovalStore: request/notify, idempotent resolve
 *
 * Pure logic — no I/O, no network.
 */
import { describe, it, expect, vi } from 'vitest';
import { PolicyEngine, ApprovalStore } from '../../src/commerce/index.js';

describe('PolicyEngine', () => {
  const engine = (overrides: any = {}) =>
    new PolicyEngine({
      providers: overrides.providers,
      budgets: overrides.budgets ?? { perTransactionSat: 100 }, // 1.00
      approval: overrides.approval ?? { autoPayBelowSat: 50 }, // 0.50
    });

  it('auto-pays below the threshold', () => {
    expect(engine().decide({ amountSat: 49, providerId: 'p1' }).action).toBe('auto_pay');
  });

  it('requires approval at/above the threshold', () => {
    expect(engine().decide({ amountSat: 50, providerId: 'p1' }).action).toBe('require_approval');
    expect(engine().decide({ amountSat: 80, providerId: 'p1' }).action).toBe('require_approval');
  });

  it('denies above the hard per-transaction cap', () => {
    const d = engine().decide({ amountSat: 101, providerId: 'p1' });
    expect(d.action).toBe('deny');
    expect(d.code).toBe('exceeds_per_transaction');
  });

  it('denies a provider on the deny list', () => {
    const d = engine({ providers: { deny: ['evil'] } }).decide({ amountSat: 10, providerId: 'EVIL' });
    expect(d.action).toBe('deny');
    expect(d.code).toBe('provider_denied');
  });

  it('denies a provider not on a configured allow list', () => {
    const e = engine({ providers: { allow: ['verified'] } });
    expect(e.decide({ amountSat: 10, providerId: 'unknown' }).code).toBe('provider_not_allowed');
    expect(e.decide({ amountSat: 10, providerId: 'VERIFIED' }).action).toBe('auto_pay'); // case-insensitive
    expect(e.decide({ amountSat: 10 }).code).toBe('provider_not_allowed'); // no provider given
  });

  it('deny (deny-list) takes precedence over allow-list membership', () => {
    const e = engine({ providers: { allow: ['p1'], deny: ['p1'] } });
    expect(e.decide({ amountSat: 10, providerId: 'p1' }).code).toBe('provider_denied');
  });

  it('rejects non-positive amounts', () => {
    expect(engine().decide({ amountSat: 0, providerId: 'p1' }).code).toBe('invalid_amount');
    expect(engine().decide({ amountSat: -5, providerId: 'p1' }).code).toBe('invalid_amount');
  });

  it('supports a gray zone between autoPayBelow and requireHumanAbove', () => {
    // auto below 0.20; anything >= 0.20 needs approval even though a higher
    // require-human bound exists — the safe default is approval, not auto.
    const e = engine({ approval: { autoPayBelowSat: 20, requireHumanAboveSat: 60 } });
    expect(e.decide({ amountSat: 19, providerId: 'p1' }).action).toBe('auto_pay');
    expect(e.decide({ amountSat: 20, providerId: 'p1' }).action).toBe('require_approval');
    expect(e.decide({ amountSat: 70, providerId: 'p1' }).action).toBe('require_approval');
  });

  it('rejects a misconfigured threshold ordering', () => {
    expect(() => new PolicyEngine({ approval: { autoPayBelowSat: 100, requireHumanAboveSat: 50 } })).toThrow();
  });
});

describe('ApprovalStore', () => {
  it('parks a request and notifies listeners', async () => {
    const store = new ApprovalStore();
    const seen: string[] = [];
    store.onRequested((r) => { seen.push(r.id); });
    const req = await store.request({ amountSat: 200, providerId: 'p1', taskId: 't1', requester: 'agent-1' });
    expect(req.status).toBe('pending');
    expect(seen).toEqual([req.id]);
    expect(store.list('pending')).toHaveLength(1);
  });

  it('approve/reject is idempotent', async () => {
    const store = new ApprovalStore();
    const req = await store.request({ amountSat: 200 });
    const r1 = store.approve(req.id, 'boss', 'ok');
    expect(r1.ok).toBe(true);
    expect(r1.request!.status).toBe('approved');
    expect(r1.request!.approver).toBe('boss');
    // second resolution is refused, original stands
    const r2 = store.reject(req.id, 'boss');
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('already_resolved');
    expect(store.get(req.id)!.status).toBe('approved');
  });

  it('resolving an unknown id fails cleanly', () => {
    const store = new ApprovalStore();
    expect(store.approve('nope').error).toBe('not_found');
  });

  it('a throwing listener does not lose the request', async () => {
    const store = new ApprovalStore();
    store.onRequested(() => { throw new Error('channel down'); });
    const req = await store.request({ amountSat: 10 });
    expect(store.get(req.id)!.status).toBe('pending'); // still queued
  });
});
