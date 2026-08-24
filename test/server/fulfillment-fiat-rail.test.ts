/**
 * Earn-side fulfillment policy on the FIAT rails (Alipay / WeChat). Fiat has no
 * refund path, so the gate runs BEFORE the gateway order is created: a fiat
 * challenge is offered only when the policy would auto-fulfill. This asserts the
 * 402 challenge withholds the fiat accepts[] entries when the policy denies,
 * offers them when it auto-fulfills, and never affects the crypto entry.
 * build{Alipay,WeChat}Challenge are stubbed so no gateway/network is touched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { MoltsPayServer } from '../../src/server/index.js';

async function boot(dir: string, fulfillment: any) {
  const manifest = {
    provider: { name: 'fiat-fulfill-test', wallet: '0x1111111111111111111111111111111111111111', chains: [{ chain: 'base', tokens: ['USDC'] }], fulfillment },
    services: [{
      id: 'report', name: 'Report', price: 2.0, currency: 'USDC', input: {}, output: {},
      alipay: { price_cny: '2.00', description: 'r' },
      wechat: { price_cny: '2.00', description: 'r' },
    }],
  };
  const mp = path.join(dir, 'fiat.services.json');
  writeFileSync(mp, JSON.stringify(manifest));
  const server = new MoltsPayServer(mp, {});
  server.skill('report', async () => ({ ok: true }));
  // Stub the fiat challenge builders (no gateway/network). The gate decides
  // BEFORE calling these, so a withheld rail means the stub is never invoked.
  (server as any).buildAlipayChallenge = async () => ({
    accepts: { scheme: 'alipay', network: 'alipay:cn', asset: 'CNY', amount: '2.00', payTo: 'seller' },
    paymentNeededHeader: 'stub',
  });
  (server as any).buildWechatChallenge = async () => ({
    accepts: { scheme: 'wechat', network: 'wechat:cn', asset: 'CNY', amount: '2.00', payTo: 'seller' },
  });
  const handle = (server as any).handleRequest.bind(server);
  const http = createServer((req, res) => handle(req, res));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  return { server, http, port: (http.address() as AddressInfo).port };
}

let b: { server: MoltsPayServer; http: Server; port: number };
const base = () => `http://127.0.0.1:${b.port}`;

async function accepts(): Promise<any[]> {
  const res = await fetch(`${base()}/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: 'report', params: {} }),
  });
  expect(res.status).toBe(402);
  const x402 = JSON.parse(Buffer.from(res.headers.get('x-payment-required')!, 'base64').toString());
  return x402.accepts;
}

describe('fulfillment policy on the fiat rails', () => {
  describe('policy withholds fiat when it would not auto-fulfill', () => {
    beforeAll(async () => { b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-ff-deny-')), { minPriceSat: 500 }); }); // 5.00 > 2.00 CNY
    afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

    it('drops alipay + wechat from the 402, keeps crypto', async () => {
      const a = await accepts();
      expect(a.some((x) => x.scheme === 'alipay')).toBe(false);
      expect(a.some((x) => x.scheme === 'wechat')).toBe(false);
      expect(a.some((x) => x.network?.startsWith('eip155'))).toBe(true); // crypto untouched
    });
  });

  describe('require_approval also withholds fiat (no safe hold without refund)', () => {
    beforeAll(async () => { b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-ff-appr-')), { approval: { autoFulfillBelowSat: 100 } }); }); // 2.00>1.00 → approval
    afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

    it('drops fiat entries when the request would need approval', async () => {
      const a = await accepts();
      expect(a.some((x) => x.scheme === 'alipay' || x.scheme === 'wechat')).toBe(false);
    });
  });

  describe('auto-fulfill offers fiat normally', () => {
    beforeAll(async () => { b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-ff-ok-')), { minPriceSat: 100 }); }); // 1.00 <= 2.00 → fulfill
    afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

    it('includes alipay + wechat in the 402', async () => {
      const a = await accepts();
      expect(a.some((x) => x.scheme === 'alipay')).toBe(true);
      expect(a.some((x) => x.scheme === 'wechat')).toBe(true);
    });
  });

  describe('no policy → fiat offered as before', () => {
    beforeAll(async () => { b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-ff-none-')), undefined); });
    afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

    it('offers fiat when no fulfillment policy is set', async () => {
      const a = await accepts();
      expect(a.some((x) => x.scheme === 'alipay')).toBe(true);
      expect(a.some((x) => x.scheme === 'wechat')).toBe(true);
    });
  });
});
