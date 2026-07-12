/**
 * Regression for the WeChat topup amount-spoofing fix in `handleBalanceTopup`.
 *
 * Before the fix, `/balance/topup` credited the client-declared `amount`
 * after only confirming `trade_state === 'SUCCESS'` -- a buyer could pay the
 * 1-fen minimum and declare an arbitrary `amount` to mint balance for free.
 * The fix credits `check.details.amount.payer_total` (fen, 1:1 with ledger
 * cents) from the WeChat order-query response instead.
 *
 * Self-contained: stubs `fetch` for the WeChat gateway only (localhost
 * requests pass through). No network, no money.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { MoltsPayServer } from '../../src/server/index.js';

interface Booted { server: MoltsPayServer; http: Server; port: number; }

/** Stub fetch: WeChat order-query -> a fixed real-paid amount; everything else passes through. */
function stubWechatFetch(realFetch: typeof fetch, paidFen: number): void {
  vi.stubGlobal('fetch', (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('api.mch.weixin.qq.com')) {
      const body = {
        trade_state: 'SUCCESS',
        transaction_id: '4200TOPUP0001',
        out_trade_no: 'WXtopupmismatch01',
        amount: { total: paidFen, payer_total: paidFen, currency: 'CNY' },
      };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
      } as any;
    }
    return realFetch(url, init);
  }) as any);
}

describe('WeChat topup amount spoofing -- regression', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-balance-topup-'));
  const realFetch = globalThis.fetch;
  let b: Booted;

  beforeAll(async () => {
    const kp = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const keyPath = path.join(dir, 'wechat_key.pem');
    writeFileSync(keyPath, kp.privateKey);

    const manifest = {
      provider: {
        name: 'wechat-topup-test',
        wallet: '0x' + 'a'.repeat(40),
        chains: ['base', 'wechat', 'balance'],
        wechat: {
          mchid: '1900000001',
          appid: 'wx8888888888888888',
          serial_no: 'TESTSERIAL0001',
          private_key_path: keyPath,
          notify_url: 'https://example.com/wechat/notify',
        },
        balance: { db_path: ':memory:', currency: 'USD', single_limit: '5.00', daily_limit: '10.00' },
      },
      services: [{ id: 'video-demo', name: 'Demo Video', price: 0.14, currency: 'USDC', input: {}, output: {} }],
    };
    const manifestPath = path.join(dir, 'wechat-topup.services.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const server = new MoltsPayServer(manifestPath, {});
    const handle = (server as any).handleRequest.bind(server);
    const http = createServer((req, res) => handle(req, res));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    b = { server, http, port: (http.address() as AddressInfo).port };
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((r) => b.http.close(() => r()));
  });

  async function topup(buyerId: string, amount: string, outTradeNo: string) {
    const res = await realFetch(`http://127.0.0.1:${b.port}/balance/topup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ buyer_id: buyerId, rail: 'wechat', amount, out_trade_no: outTradeNo }),
    });
    return { status: res.status, body: await res.json() as any };
  }

  it('credits the WeChat-verified paid amount, not a higher client-declared amount', async () => {
    // Real payment: 7 fen (0.07 CNY). Client declares amount=100.00 (way more).
    stubWechatFetch(realFetch, 7);
    const { status, body } = await topup('buyer-spoof', '100.00', 'WXtopupmismatch01');
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // Credited amount must match the gateway's payer_total (7 fen = $0.07),
    // never the client's declared $100.00.
    expect(body.balance).toBe('0.07');

    const q = await (await realFetch(`http://127.0.0.1:${b.port}/balance?buyer_id=buyer-spoof`)).json() as any;
    expect(q.balance).toBe('0.07');
  });

  it('credits the WeChat-verified amount even when the client under-declares', async () => {
    stubWechatFetch(realFetch, 50);
    const { status, body } = await topup('buyer-under', '0.01', 'WXtopupunder01');
    expect(status).toBe(200);
    expect(body.balance).toBe('0.50');
  });

  it('is idempotent on out_trade_no regardless of the amount passed on replay', async () => {
    stubWechatFetch(realFetch, 7);
    const t1 = await topup('buyer-replay', '7.00', 'WXtopupreplay01');
    expect(t1.body.balance).toBe('0.07');

    const t2 = await topup('buyer-replay', '999.00', 'WXtopupreplay01');
    expect(t2.body.replayed).toBe(true);
    expect(t2.body.balance).toBe('0.07');
  });
});
