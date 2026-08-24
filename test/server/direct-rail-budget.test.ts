/**
 * Cross-rail task budget on the DIRECT (crypto/USDC) rail.
 *
 * Proves the per-task budget + audit apply to a non-balance rail: a USDC
 * (x402) payment reserves against the SAME meter as the balance/fiat rails.
 * The on-chain verify/settle are stubbed (no CDP, no network) so the test
 * exercises the server's budget + audit wiring, not the facilitator.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { MoltsPayServer } from '../../src/server/index.js';

const OPERATOR_KEY = 'direct-operator-secret';
const opHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR_KEY}` };

let failNext = false;

async function boot(dir: string) {
  const manifest = {
    provider: {
      name: 'direct-test',
      wallet: '0x1111111111111111111111111111111111111111',
      chains: [{ chain: 'base', tokens: ['USDC'] }],
      audit: { dir: path.join(dir, 'audit') },
      commerce: { operator_key: OPERATOR_KEY },   // no balance rail on this server
    },
    services: [
      { id: 'usdc-report', name: 'USDC Report', price: 2.0, currency: 'USDC', input: {}, output: {} },
    ],
  };
  const mp = path.join(dir, 'direct.services.json');
  writeFileSync(mp, JSON.stringify(manifest));
  const server = new MoltsPayServer(mp, {});
  server.skill('usdc-report', async () => {
    if (failNext) { failNext = false; throw new Error('boom'); }
    return { report: 'ok' };
  });
  // Stub the on-chain verify/settle so no CDP/network is needed.
  (server as any).registry.verify = async () => ({ valid: true, facilitator: 'stub' });
  (server as any).registry.settle = async () => ({ success: true, transaction: '0xdeadbeef', facilitator: 'stub' });
  (server as any).validatePayment = () => ({ valid: true });
  (server as any).detectPaymentToken = () => 'USDC';

  const handle = (server as any).handleRequest.bind(server);
  const http = createServer((req, res) => handle(req, res));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  return { server, http, port: (http.address() as AddressInfo).port };
}

let nonce = 0;
/** A distinct crypto X-Payment per call (real payments differ → distinct ref). */
function cryptoXPayment(): string {
  nonce += 1;
  return Buffer.from(JSON.stringify({
    x402Version: 2, scheme: 'exact', network: 'eip155:8453',
    payload: { authorization: { from: '0xabc', nonce }, signature: `0x${nonce}` },
  })).toString('base64');
}

let b: { server: MoltsPayServer; http: Server; port: number };
const base = () => `http://127.0.0.1:${b.port}`;

beforeAll(async () => { b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-direct-'))); });
afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

async function pay(taskId: string) {
  return fetch(`${base()}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-payment': cryptoXPayment() },
    body: JSON.stringify({ service: 'usdc-report', params: {}, task_id: taskId }),
  });
}

describe('direct (USDC) rail — cross-rail task budget + audit', () => {
  it('registers a task budget without a balance rail (operator via provider.commerce)', async () => {
    const res = await fetch(`${base()}/balance/task-budget`, {
      method: 'POST', headers: opHeaders,
      body: JSON.stringify({ task_id: 'usdc-job', budget: '3.00' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).budget).toBe('3.00');
  });

  it('caps USDC spend at the task budget and audits the settled payment', async () => {
    // First $2 fits the $3 budget.
    expect((await pay('usdc-job')).status).toBe(200);
    // Second $2 → $4 > $3 → refused by the task budget (same meter as other rails).
    const second = await pay('usdc-job');
    expect(second.status).toBe(402);
    expect((await second.json()).code).toBe('exceeds_task_budget');

    // Budget view reflects the USDC spend.
    const q = await (await fetch(`${base()}/balance/task-budget?task_id=usdc-job`)).json();
    expect(q.spent).toBe('2.00');
    expect(q.remaining).toBe('1.00');

    // Audit recorded the USDC settlement.
    const a = await (await fetch(`${base()}/audit?task_id=usdc-job`, { headers: opHeaders })).json();
    expect(a.integrity_ok).toBe(true);
    const e = a.entries.find((x: any) => x.action === 'payment_settled');
    expect(e.service_id).toBe('usdc-report');
    expect(e.payment_channel).toContain('usdc');
    expect(e.amount).toBe(2);
  });

  it('frees the reservation and audits a refund when the skill fails', async () => {
    await fetch(`${base()}/balance/task-budget`, {
      method: 'POST', headers: opHeaders,
      body: JSON.stringify({ task_id: 'usdc-fail', budget: '5.00' }),
    });
    failNext = true;
    const res = await pay('usdc-fail');
    expect(res.status).toBe(500);
    // Reservation released → spend back to 0.
    const q = await (await fetch(`${base()}/balance/task-budget?task_id=usdc-fail`)).json();
    expect(q.spent).toBe('0.00');
    const a = await (await fetch(`${base()}/audit?task_id=usdc-fail`, { headers: opHeaders })).json();
    expect(a.entries.some((x: any) => x.action === 'payment_refunded')).toBe(true);
  });
});
