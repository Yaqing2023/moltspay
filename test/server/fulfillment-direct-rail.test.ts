/**
 * Earn-side fulfillment policy on the DIRECT (crypto/USDC, x402) rail. Proves
 * the same FulfillmentPolicy that guards the balance rail also guards the
 * pay-for-success x402 rail: a denied buyer / underpriced request is refused
 * BEFORE the skill runs or the payment settles. verify/settle are stubbed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { MoltsPayServer } from '../../src/server/index.js';

let skillRuns = 0;
let settleRuns = 0;

async function boot(dir: string, fulfillment: any) {
  const manifest = {
    provider: {
      name: 'direct-fulfill-test',
      wallet: '0x1111111111111111111111111111111111111111',
      chains: [{ chain: 'base', tokens: ['USDC'] }],
      commerce: { operator_key: 'k' },
      fulfillment,
    },
    services: [{ id: 'usdc-report', name: 'USDC Report', price: 2.0, currency: 'USDC', input: {}, output: {} }],
  };
  const mp = path.join(dir, 'direct.services.json');
  writeFileSync(mp, JSON.stringify(manifest));
  const server = new MoltsPayServer(mp, {});
  server.skill('usdc-report', async () => { skillRuns += 1; return { report: 'ok' }; });
  (server as any).registry.verify = async () => ({ valid: true, facilitator: 'stub' });
  (server as any).registry.settle = async () => { settleRuns += 1; return { success: true, transaction: '0xdead', facilitator: 'stub' }; };
  (server as any).validatePayment = () => ({ valid: true });
  (server as any).detectPaymentToken = () => 'USDC';
  const handle = (server as any).handleRequest.bind(server);
  const http = createServer((req, res) => handle(req, res));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  return { server, http, port: (http.address() as AddressInfo).port };
}

let n = 0;
function xPayment(from: string): string {
  n += 1;
  return Buffer.from(JSON.stringify({
    x402Version: 2, scheme: 'exact', network: 'eip155:8453',
    payload: { authorization: { from, nonce: n }, signature: `0x${n}` },
  })).toString('base64');
}

let b: { server: MoltsPayServer; http: Server; port: number };
const base = () => `http://127.0.0.1:${b.port}`;
const exec = (from: string) =>
  fetch(`${base()}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-payment': xPayment(from) },
    body: JSON.stringify({ service: 'usdc-report', params: {} }),
  });

describe('fulfillment policy on the direct (x402) rail', () => {
  describe('buyer deny', () => {
    beforeAll(async () => { skillRuns = 0; settleRuns = 0; b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-df-')), { buyers: { deny: ['0xBAD'] } }); });
    afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

    it('denies the deny-listed payer before running or settling', async () => {
      const res = await exec('0xbad');
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.code).toBe('buyer_denied');
      expect(skillRuns).toBe(0);
      expect(settleRuns).toBe(0);
    });

    it('serves an allowed payer', async () => {
      const res = await exec('0xgood');
      expect(res.status).toBe(200);
      expect(skillRuns).toBe(1);
    });
  });

  describe('min-price floor', () => {
    beforeAll(async () => { skillRuns = 0; settleRuns = 0; b = await boot(mkdtempSync(path.join(tmpdir(), 'mp-df-min-')), { minPriceSat: 500 }); }); // $5 > $2
    afterAll(() => new Promise<void>((r) => b.http.close(() => r())));

    it('rejects an underpriced service before running or settling', async () => {
      const res = await exec('0xabc');
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.code).toBe('below_min_price');
      expect(skillRuns).toBe(0);
      expect(settleRuns).toBe(0);
    });
  });
});
