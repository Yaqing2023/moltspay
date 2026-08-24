/**
 * Unit tests for CommerceMiddleware — the 402 enforcement point.
 *
 * A fake fetch returns 402 (with an x-payment-required header) on the first
 * call and 200 on the retry; a fake executor reports the charge and returns a
 * dummy proof. No network, no keys.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CommerceMiddleware,
  PolicyEngine,
  ApprovalStore,
  PaymentDeniedError,
  ApprovalRequiredError,
  ApprovalRejectedError,
  PAYMENT_HEADER,
} from '../../src/commerce/index.js';
import { AuditLog } from '../../src/audit/AuditLog.js';

function challengeHeader(amount: string, serviceId = 'svc-1'): string {
  const body = { x402Version: 2, accepts: [{ scheme: 'balance', network: 'balance', amount, payTo: 'custodial', extra: { service_id: serviceId } }] };
  return Buffer.from(JSON.stringify(body)).toString('base64');
}

/** Fake fetch: first call → 402 w/ challenge, subsequent calls → 200 echoing the X-Payment it saw. */
function fakeFetch(amount = '3.99') {
  const calls: Array<{ init?: RequestInit }> = [];
  const impl = vi.fn(async (_url: any, init?: RequestInit) => {
    calls.push({ init });
    if (calls.length === 1) {
      return new Response('', { status: 402, headers: { 'x-payment-required': challengeHeader(amount) } });
    }
    const paid = (init?.headers as Record<string, string> | undefined)?.[PAYMENT_HEADER];
    return new Response(JSON.stringify({ ok: true, paid }), { status: 200 });
  });
  return { impl, calls };
}

const executor = (amountSat: number, providerId = 'prov-1') => ({
  quote: (accepts: any[]) => ({ amountSat, providerId, chosen: accepts[0] }),
  pay: vi.fn(async () => ({ xPayment: 'PROOF123', paymentId: 'btx_1' })),
});

const policy = (autoBelow: number, providers?: any) =>
  new PolicyEngine({ providers, budgets: { perTransactionSat: 1000 }, approval: { autoPayBelowSat: autoBelow } });

describe('CommerceMiddleware', () => {
  it('auto-pays a below-threshold 402 and retries with the proof', async () => {
    const { impl, calls } = fakeFetch('3.99');
    const exec = executor(399);
    const audit = new AuditLog();
    const mw = new CommerceMiddleware({ policy: policy(500), executor: exec, audit, fetchImpl: impl });

    const res = await mw.fetch('https://x/execute', { method: 'POST' }, { taskId: 't1', requester: 'agent-1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.paid).toBe('PROOF123'); // retry carried the proof
    expect(exec.pay).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2); // original + one retry

    const entry = audit.getEntries().find(e => e.action === 'payment_settled')!;
    expect(entry.verification_status).toBe('fulfilled');
    expect(entry.task_id).toBe('t1');
    expect(entry.provider_id).toBe('prov-1');
    expect(entry.service_id).toBe('svc-1');
    expect(entry.payment_id).toBe('btx_1');
  });

  it('passes non-402 responses straight through without paying', async () => {
    const impl = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const exec = executor(399);
    const mw = new CommerceMiddleware({ policy: policy(500), executor: exec, fetchImpl: impl });
    const res = await mw.fetch('https://x/free');
    expect(res.status).toBe(200);
    expect(exec.pay).not.toHaveBeenCalled();
  });

  it('denies a provider on the deny list and never pays', async () => {
    const { impl } = fakeFetch('3.99');
    const exec = executor(399, 'evil');
    const audit = new AuditLog();
    const mw = new CommerceMiddleware({
      policy: policy(500, { deny: ['evil'] }), executor: exec, audit, fetchImpl: impl,
    });
    await expect(mw.fetch('https://x/execute')).rejects.toBeInstanceOf(PaymentDeniedError);
    expect(exec.pay).not.toHaveBeenCalled();
    expect(audit.getEntries().some(e => e.action === 'payment_denied')).toBe(true);
  });

  it('throws ApprovalRequiredError when over threshold and no resolver is set', async () => {
    const { impl } = fakeFetch('3.99');
    const exec = executor(399);
    const approvals = new ApprovalStore();
    const mw = new CommerceMiddleware({ policy: policy(100), executor: exec, approvals, fetchImpl: impl });
    await expect(mw.fetch('https://x/execute', undefined, { taskId: 't1' })).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(exec.pay).not.toHaveBeenCalled();
    expect(approvals.list('pending')).toHaveLength(1);
  });

  it('pays after the resolver approves', async () => {
    const { impl } = fakeFetch('3.99');
    const exec = executor(399);
    const approvals = new ApprovalStore();
    const mw = new CommerceMiddleware({
      policy: policy(100), executor: exec, approvals, fetchImpl: impl,
      approvalResolver: async () => true,
    });
    const res = await mw.fetch('https://x/execute', undefined, { taskId: 't1', requester: 'agent-1' });
    expect(res.status).toBe(200);
    expect(exec.pay).toHaveBeenCalledOnce();
    expect(approvals.list('approved')).toHaveLength(1);
  });

  it('refuses after the resolver rejects', async () => {
    const { impl } = fakeFetch('3.99');
    const exec = executor(399);
    const approvals = new ApprovalStore();
    const mw = new CommerceMiddleware({
      policy: policy(100), executor: exec, approvals, fetchImpl: impl,
      approvalResolver: async () => false,
    });
    await expect(mw.fetch('https://x/execute')).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(exec.pay).not.toHaveBeenCalled();
    expect(approvals.list('rejected')).toHaveLength(1);
  });
});
