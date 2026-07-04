/**
 * Regression for the WeChat 402 double-charge fix (2026-07-02 incident).
 *
 * Before the fix, EVERY 402 emit placed a fresh Native order, so a client
 * that received two challenges could surface two live QRs and a buyer could
 * pay both (confirmed ¥0.07×2 real double charge). The fix caches the unpaid
 * order per service id in `MoltsPayServer.wechatPendingChallenges`.
 *
 * Asserts, over a real HTTP server with a stubbed WeChat gateway:
 *   1. Two consecutive 402s return the SAME out_trade_no/code_url, and the
 *      gateway's order-create endpoint is hit exactly once.
 *   2. After the order is PAID (verified via /execute), the next 402 mints a
 *      FRESH order (Native is one-code-one-payment).
 *   3. Concurrent 402s (Promise.all) share one in-flight order create.
 *   4. A gateway failure is NOT cached: the next 402 retries and succeeds.
 *
 * No network, no money: fetch is stubbed for api.mch.weixin.qq.com only.
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

let orderCreateCalls = 0;
let failNextOrderCreate = false;

/** Stub fetch: count order creates; order query always SUCCESS; else real fetch. */
function stubWechatFetch(realFetch: typeof fetch): void {
  vi.stubGlobal('fetch', (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('api.mch.weixin.qq.com')) {
      if (u.includes('/transactions/native')) {
        orderCreateCalls++;
        if (failNextOrderCreate) {
          failNextOrderCreate = false;
          return {
            ok: false, status: 500, headers: { get: () => null },
            text: async () => JSON.stringify({ code: 'SYSTEM_ERROR', message: 'stubbed outage' }),
          } as any;
        }
        return {
          ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ code_url: `weixin://wxpay/bizpayurl?pr=ORDER${orderCreateCalls}` }),
        } as any;
      }
      // Order query → paid.
      return {
        ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ trade_state: 'SUCCESS', transaction_id: '4200DBLCHG01', amount: { total: 700 } }),
      } as any;
    }
    return realFetch(url, init);
  }) as any);
}

describe('WeChat 402 double-charge fix — pending-order idempotency cache', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-dblchg-'));
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

    const manifestPath = path.join(dir, 'dblchg.services.json');
    writeFileSync(manifestPath, JSON.stringify({
      provider: {
        name: 'double-charge regression',
        wallet: '0x' + 'a'.repeat(40),
        chains: ['base', 'wechat'],
        wechat: {
          mchid: '1900000001',
          appid: 'wx8888888888888888',
          serial_no: 'TESTSERIAL0001',
          private_key_path: keyPath,
          notify_url: 'https://example.com/wechat/notify',
        },
      },
      services: [{
        id: 'video-demo', name: 'Demo Video', price: 0.14, currency: 'USDC',
        input: {}, output: {},
        wechat: { price_cny: '0.07', description: 'Demo Video' },
      }],
    }));
    const server = new MoltsPayServer(manifestPath, {});
    server.skill('video-demo', async () => ({ url: 'https://example.com/v.mp4' }));
    const handle = (server as any).handleRequest.bind(server);
    const http = createServer((req, res) => handle(req, res));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    b = { server, http, port: (http.address() as AddressInfo).port };
    stubWechatFetch(realFetch);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((r) => b.http.close(() => r()));
  });

  async function get402Wx(): Promise<{ out_trade_no: string; code_url: string }> {
    const res = await realFetch(`http://127.0.0.1:${b.port}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    expect(res.status).toBe(402);
    const body = await res.json() as any;
    const wx = (body.x402.accepts as any[]).find((a) => a.scheme === 'wechatpay-native');
    expect(wx).toBeDefined();
    return { out_trade_no: wx.extra.out_trade_no, code_url: wx.extra.code_url };
  }

  async function payOrder(outTradeNo: string): Promise<void> {
    const paymentPayload = {
      x402Version: 2,
      scheme: 'wechatpay-native',
      network: 'wechat',
      accepted: { scheme: 'wechatpay-native', network: 'wechat', extra: { out_trade_no: outTradeNo } },
      payload: { out_trade_no: outTradeNo },
    };
    const res = await realFetch(`http://127.0.0.1:${b.port}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': Buffer.from(JSON.stringify(paymentPayload)).toString('base64'),
      },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    expect(res.status).toBe(200);
  }

  it('repeated 402s reuse ONE pending order (the double-charge scenario)', async () => {
    orderCreateCalls = 0;
    const first = await get402Wx();
    const second = await get402Wx();
    const third = await get402Wx();
    // Same order everywhere — a buyer can only ever pay one.
    expect(second.out_trade_no).toBe(first.out_trade_no);
    expect(third.out_trade_no).toBe(first.out_trade_no);
    expect(second.code_url).toBe(first.code_url);
    // The gateway was asked to mint exactly one order.
    expect(orderCreateCalls).toBe(1);
  });

  it('after the order is paid, the next 402 mints a FRESH order', async () => {
    orderCreateCalls = 0;
    const challenge = await get402Wx(); // cache hit from the previous test or a new mint
    await payOrder(challenge.out_trade_no);
    const next = await get402Wx();
    expect(next.out_trade_no).not.toBe(challenge.out_trade_no);
  });

  it('concurrent 402s share one in-flight order create', async () => {
    // Consume the pending order left by the previous test.
    const pending = await get402Wx();
    await payOrder(pending.out_trade_no);

    orderCreateCalls = 0;
    const [a, c, d] = await Promise.all([get402Wx(), get402Wx(), get402Wx()]);
    expect(c.out_trade_no).toBe(a.out_trade_no);
    expect(d.out_trade_no).toBe(a.out_trade_no);
    expect(orderCreateCalls).toBe(1);
  });

  it('a gateway failure is not cached — the next 402 retries and succeeds', async () => {
    const pending = await get402Wx();
    await payOrder(pending.out_trade_no);

    failNextOrderCreate = true;
    const res = await realFetch(`http://127.0.0.1:${b.port}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    expect(res.status).toBe(402);
    const body = await res.json() as any;
    // Build failed → 402 ships without a wechat entry (graceful degrade).
    expect((body.x402.accepts as any[]).some((a) => a.scheme === 'wechatpay-native')).toBe(false);

    // Next 402 retries the order create and succeeds.
    const recovered = await get402Wx();
    expect(recovered.out_trade_no).toBeTruthy();
  });
});
