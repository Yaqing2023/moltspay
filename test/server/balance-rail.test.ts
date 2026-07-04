/**
 * HTTP-level integration tests for the custodial balance rail (2.2.0).
 *
 * Boots a real MoltsPayServer (reusing the actual handleRequest) with
 * provider.balance on an in-memory SQLite ledger and asserts:
 *   1. 402 challenge carries a `balance` accepts[] entry when the service
 *      opts in — and does NOT when it doesn't.
 *   2. /balance endpoints: query (incl. never-seen buyer), topup via the
 *      operator-trusted alipay path (idempotent on trade_no), transactions.
 *   3. /execute with a balance X-Payment: deduct → skill → 200; the ledger
 *      is charged exactly once; request_id replay does not double-charge.
 *   4. Skill failure refunds the deduction automatically.
 *   5. Insufficient balance → 402 with the ledger error code.
 *
 * No network, no real money, no key material.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { MoltsPayServer } from '../../src/server/index.js';

interface Booted { server: MoltsPayServer; http: Server; port: number; }

let failNextSkillCall = false;

async function boot(dir: string): Promise<Booted> {
  const manifest = {
    provider: {
      name: 'balance-test',
      wallet: '0x1111111111111111111111111111111111111111',
      chains: [{ chain: 'base', tokens: ['USDC'] }, 'balance'],
      balance: { db_path: ':memory:', currency: 'USD', single_limit: '5.00', daily_limit: '10.00' },
    },
    services: [
      {
        id: 'video-demo', name: 'Video Demo', price: 3.99, currency: 'USDC',
        input: {}, output: {},
        balance: { price: '3.99' },
      },
      {
        id: 'no-balance-svc', name: 'No Balance', price: 1.0, currency: 'USDC',
        input: {}, output: {},
      },
    ],
  };
  const manifestPath = path.join(dir, 'balance.services.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const server = new MoltsPayServer(manifestPath, {});
  server.skill('video-demo', async () => {
    if (failNextSkillCall) { failNextSkillCall = false; throw new Error('boom'); }
    return { url: 'https://example.com/v.mp4' };
  });
  server.skill('no-balance-svc', async () => ({ ok: true }));
  const handle = (server as any).handleRequest.bind(server);
  const http = createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { server, http, port: (http.address() as AddressInfo).port };
}

function xPaymentHeader(buyerId: string, requestId?: string): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    scheme: 'balance',
    network: 'balance',
    payload: { buyer_id: buyerId, ...(requestId ? { request_id: requestId } : {}) },
  })).toString('base64');
}

describe('balance rail HTTP integration', () => {
  let b: Booted;
  const base = () => `http://127.0.0.1:${b.port}`;

  beforeAll(async () => {
    b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-balance-')));
  });
  afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

  async function topup(buyerId: string, amount: string, ref: string) {
    const res = await fetch(`${base()}/balance/topup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyer_id: buyerId, rail: 'alipay', trade_no: ref, amount }),
    });
    return { status: res.status, body: await res.json() };
  }

  it('402 challenge includes the balance accepts[] entry for opted-in services only', async () => {
    const res = await fetch(`${base()}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    expect(res.status).toBe(402);
    const x402 = JSON.parse(Buffer.from(res.headers.get('x-payment-required')!, 'base64').toString());
    const balanceEntry = x402.accepts.find((a: any) => a.scheme === 'balance');
    expect(balanceEntry).toBeDefined();
    expect(balanceEntry.amount).toBe('3.99');
    expect(balanceEntry.network).toBe('balance');
    // crypto entries are untouched
    expect(x402.accepts.some((a: any) => a.network?.startsWith('eip155'))).toBe(true);

    const res2 = await fetch(`${base()}/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'no-balance-svc', params: {} }),
    });
    const x4022 = JSON.parse(Buffer.from(res2.headers.get('x-payment-required')!, 'base64').toString());
    expect(x4022.accepts.some((a: any) => a.scheme === 'balance')).toBe(false);
  });

  it('GET /balance returns an empty account for a never-seen buyer', async () => {
    const res = await fetch(`${base()}/balance?buyer_id=nobody`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.balance).toBe('0.00');
    expect(body.exists).toBe(false);
  });

  it('topup credits and is idempotent on the external reference', async () => {
    const t1 = await topup('buyer-1', '10.00', 'TRADE-001');
    expect(t1.status).toBe(200);
    expect(t1.body.balance).toBe('10.00');
    const t2 = await topup('buyer-1', '10.00', 'TRADE-001');
    expect(t2.body.replayed).toBe(true);
    expect(t2.body.balance).toBe('10.00'); // credited exactly once

    const q = await (await fetch(`${base()}/balance?buyer_id=buyer-1`)).json();
    expect(q.balance).toBe('10.00');
    expect(q.single_limit).toBe('5.00');
  });

  it('execute deducts, runs the skill, returns 200 + payment response header', async () => {
    await topup('buyer-2', '10.00', 'TRADE-002');
    const res = await fetch(`${base()}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment': xPaymentHeader('buyer-2', 'req-a') },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.result.url).toContain('example.com');
    expect(body.payment.facilitator).toBe('balance');
    expect(body.payment.transaction).toMatch(/^btx_/);
    const pr = JSON.parse(Buffer.from(res.headers.get('x-payment-response')!, 'base64').toString());
    expect(pr.network).toBe('balance');

    const q = await (await fetch(`${base()}/balance?buyer_id=buyer-2`)).json();
    expect(q.balance).toBe('6.01');
  });

  it('request_id replay executes without double-charging', async () => {
    const res = await fetch(`${base()}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment': xPaymentHeader('buyer-2', 'req-a') },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    expect(res.status).toBe(200);
    const q = await (await fetch(`${base()}/balance?buyer_id=buyer-2`)).json();
    expect(q.balance).toBe('6.01'); // unchanged — replayed deduct
  });

  it('skill failure auto-refunds the deduction', async () => {
    await topup('buyer-3', '10.00', 'TRADE-003');
    failNextSkillCall = true;
    const res = await fetch(`${base()}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment': xPaymentHeader('buyer-3') },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.refunded).toBe(true);
    const q = await (await fetch(`${base()}/balance?buyer_id=buyer-3`)).json();
    expect(q.balance).toBe('10.00'); // fully restored
  });

  it('insufficient balance → 402 with the ledger error code', async () => {
    const res = await fetch(`${base()}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment': xPaymentHeader('broke-buyer') },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    const body = await res.json();
    expect(res.status).toBe(402);
    expect(body.code).toBe('buyer_not_found');
    expect(body.facilitator).toBe('balance');
  });

  it('lists transactions newest-first via /balance/transactions', async () => {
    const res = await fetch(`${base()}/balance/transactions?buyer_id=buyer-2&limit=10`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.transactions.length).toBeGreaterThanOrEqual(2);
    expect(body.transactions[0].type).toBe('deduct'); // most recent
    expect(body.transactions.some((t: any) => t.type === 'topup')).toBe(true);
  });

  it('refund endpoint reverses a deduct and is idempotent', async () => {
    const txs = await (await fetch(`${base()}/balance/transactions?buyer_id=buyer-2`)).json();
    const deduct = txs.transactions.find((t: any) => t.type === 'deduct');
    const r1 = await fetch(`${base()}/balance/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_id: deduct.tx_id, reason: 'ops' }),
    });
    const b1 = await r1.json();
    expect(b1.success).toBe(true);
    const r2 = await fetch(`${base()}/balance/refund`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_id: deduct.tx_id, reason: 'ops again' }),
    });
    const b2 = await r2.json();
    expect(b2.replayed).toBe(true);
    expect(b2.balance).toBe(b1.balance); // refunded exactly once
  });
});
