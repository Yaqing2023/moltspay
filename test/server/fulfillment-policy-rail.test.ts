/**
 * HTTP-level integration test for the earn-side fulfillment policy wired into
 * the custodial balance rail. Boots a real MoltsPayServer with
 * provider.fulfillment and asserts that a denied buyer / underpriced request is
 * refused with 403 BEFORE any deduction (balance unchanged), while an allowed
 * request still settles. No network, no real money.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { MoltsPayServer } from '../../src/server/index.js';

const OPERATOR_KEY = 'test-operator-secret';
const opHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${OPERATOR_KEY}` };

interface Booted { server: MoltsPayServer; http: Server; port: number; }

async function boot(dir: string, fulfillment: any): Promise<Booted> {
  const manifest = {
    provider: {
      name: 'fulfill-test',
      wallet: '0x1111111111111111111111111111111111111111',
      chains: [{ chain: 'base', tokens: ['USDC'] }, 'balance'],
      balance: { db_path: ':memory:', currency: 'USD', single_limit: '5.00', daily_limit: '10.00', operator_key: OPERATOR_KEY },
      fulfillment,
    },
    services: [
      { id: 'video-demo', name: 'Video Demo', price: 3.99, currency: 'USDC', input: {}, output: {}, balance: { price: '3.99' } },
    ],
  };
  const manifestPath = path.join(dir, 'fulfill.services.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const server = new MoltsPayServer(manifestPath, {});
  server.skill('video-demo', async () => ({ url: 'https://example.com/v.mp4' }));
  const handle = (server as any).handleRequest.bind(server);
  const http = createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return { server, http, port: (http.address() as AddressInfo).port };
}

function xPaymentHeader(buyerId: string, requestId?: string): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2, scheme: 'balance', network: 'balance',
    payload: { buyer_id: buyerId, ...(requestId ? { request_id: requestId } : {}) },
  })).toString('base64');
}

describe('fulfillment policy on the balance rail', () => {
  let b: Booted;
  const base = () => `http://127.0.0.1:${b.port}`;
  const topup = (buyerId: string, ref: string) =>
    fetch(`${base()}/balance/topup`, { method: 'POST', headers: opHeaders,
      body: JSON.stringify({ buyer_id: buyerId, rail: 'alipay', trade_no: ref, amount: '10.00' }) });
  const balanceOf = async (buyerId: string) =>
    (await (await fetch(`${base()}/balance?buyer_id=${buyerId}`)).json()).balance;
  const exec = (buyerId: string, reqId?: string) =>
    fetch(`${base()}/execute`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-payment': xPaymentHeader(buyerId, reqId) },
      body: JSON.stringify({ service: 'video-demo', params: {} }) });

  describe('buyer allow/deny', () => {
    beforeAll(async () => { b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-fulfill-')), { buyers: { deny: ['buyer-bad'] } }); });
    afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

    it('denies a deny-listed buyer with 403 and does NOT charge', async () => {
      await topup('buyer-bad', 'T-BAD');
      const res = await exec('buyer-bad', 'r1');
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.code).toBe('buyer_denied');
      expect(await balanceOf('buyer-bad')).toBe('10.00'); // untouched
    });

    it('serves an allowed buyer and charges normally', async () => {
      await topup('buyer-ok', 'T-OK');
      const res = await exec('buyer-ok', 'r2');
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(await balanceOf('buyer-ok')).toBe('6.01'); // 10 - 3.99
    });
  });

  describe('min-price floor', () => {
    beforeAll(async () => { b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-fulfill-min-')), { minPriceSat: 500 }); });
    afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

    it('rejects a request priced below the floor without charging', async () => {
      await topup('buyer-x', 'T-X');
      const res = await exec('buyer-x', 'r3');
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.code).toBe('below_min_price');
      expect(await balanceOf('buyer-x')).toBe('10.00'); // untouched
    });
  });

  describe('approval hold (require_approval)', () => {
    // service price 3.99 (399 minor) >= 100 → every request needs approval
    beforeAll(async () => { b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-fulfill-appr-')), { approval: { autoFulfillBelowSat: 100 } }); });
    afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

    const listPending = async () =>
      (await (await fetch(`${base()}/fulfillment/approvals?status=pending`, { headers: opHeaders })).json());
    const resolve = (id: string, action: 'approve' | 'reject') =>
      fetch(`${base()}/fulfillment/approvals/${id}/${action}`, { method: 'POST', headers: opHeaders, body: '{}' });

    it('parks for approval, then serves after the seller approves', async () => {
      await topup('buyer-a', 'T-A');
      const r1 = await exec('buyer-a', 'ra');
      const b1 = await r1.json();
      expect(r1.status).toBe(402);
      expect(b1.code).toBe('fulfillment_pending_approval');
      expect(b1.approvalId).toBeTruthy();
      expect(await balanceOf('buyer-a')).toBe('10.00'); // not charged while pending

      const pending = await listPending();
      expect(pending.approvals.some((a: any) => a.id === b1.approvalId)).toBe(true);

      const appr = await resolve(b1.approvalId, 'approve');
      expect((await appr.json()).ok).toBe(true);

      // retry with the SAME request_id → now proceeds and charges
      const r2 = await exec('buyer-a', 'ra');
      const b2 = await r2.json();
      expect(r2.status).toBe(200);
      expect(b2.success).toBe(true);
      expect(await balanceOf('buyer-a')).toBe('6.01');
    });

    it('rejects a held fulfillment and never charges', async () => {
      await topup('buyer-b', 'T-B');
      const r1 = await exec('buyer-b', 'rb');
      const b1 = await r1.json();
      expect(r1.status).toBe(402);

      const rej = await resolve(b1.approvalId, 'reject');
      expect((await rej.json()).ok).toBe(true);

      const r2 = await exec('buyer-b', 'rb');
      const b2 = await r2.json();
      expect(r2.status).toBe(403);
      expect(b2.code).toBe('fulfillment_rejected');
      expect(await balanceOf('buyer-b')).toBe('10.00'); // never charged
    });

    it('approval endpoints require the operator key', async () => {
      const res = await fetch(`${base()}/fulfillment/approvals`, { headers: { 'Content-Type': 'application/json' } });
      expect(res.status).toBe(401);
    });
  });
});
