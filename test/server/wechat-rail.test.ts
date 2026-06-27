/**
 * HTTP-level regression for the WeChat Pay rail server integration (2.1.0).
 *
 * Boots a real MoltsPayServer over HTTP (reusing the actual handleRequest)
 * and asserts:
 *   1. WITHOUT provider.wechat -> 402 accepts[] has NO wechat entry.
 *   2. WITH provider.wechat    -> 402 accepts[] appends a wechatpay-native
 *      entry carrying code_url + out_trade_no in `extra`; the existing crypto
 *      accepts[] entries are untouched.
 *   3. The /execute path: a payment payload carrying out_trade_no verifies via
 *      order query (trade_state=SUCCESS), runs the skill, and returns 200.
 *
 * Self-contained: generates a throwaway RSA keypair and stubs `fetch` for the
 * WeChat gateway only (localhost requests pass through). No network, no money.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { MoltsPayServer } from '../../src/server/index.js';

const CRYPTO_CHAINS = ['base', 'polygon', 'solana'];

interface Booted { server: MoltsPayServer; http: Server; port: number; }

async function boot(manifest: any, dir: string, name: string): Promise<Booted> {
  const manifestPath = path.join(dir, `${name}.services.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const server = new MoltsPayServer(manifestPath, {});
  server.skill('video-demo', async () => ({ url: 'https://example.com/v.mp4' }));
  const handle = (server as any).handleRequest.bind(server);
  const http = createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return { server, http, port };
}

/** Stub fetch: WeChat gateway -> canned JSON; everything else (localhost) -> real fetch. */
function stubWechatFetch(realFetch: typeof fetch): void {
  vi.stubGlobal('fetch', (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('api.mch.weixin.qq.com')) {
      const body = u.includes('/transactions/native')
        ? { code_url: 'weixin://wxpay/bizpayurl?pr=SRV0TEST' }
        : { trade_state: 'SUCCESS', transaction_id: '4200SRV0001', amount: { total: 1000 } };
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

describe('WeChat rail — HTTP server integration (2.1.0)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-rail-'));
  const realFetch = globalThis.fetch;
  let noWechat: Booted;
  let withWechat: Booted;

  beforeAll(async () => {
    const kp = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const keyPath = path.join(dir, 'wechat_key.pem');
    writeFileSync(keyPath, kp.privateKey);

    const baseProvider = {
      name: 'wechat regression provider',
      wallet: '0x' + 'a'.repeat(40),
      solana_wallet: 'So11111111111111111111111111111111111111112',
      chains: CRYPTO_CHAINS,
    };
    const baseService = {
      id: 'video-demo', name: 'Demo Video', price: 0.14, currency: 'USDC',
      input: {}, output: {},
    };

    noWechat = await boot({ provider: baseProvider, services: [baseService] }, dir, 'no-wechat');

    withWechat = await boot({
      provider: {
        ...baseProvider,
        chains: [...CRYPTO_CHAINS, 'wechat'],
        wechat: {
          mchid: '1900000001',
          appid: 'wx8888888888888888',
          serial_no: 'TESTSERIAL0001',
          private_key_path: keyPath,
          notify_url: 'https://example.com/wechat/notify',
        },
      },
      services: [{ ...baseService, wechat: { price_cny: '10.00', description: 'Demo Video' } }],
    }, dir, 'with-wechat');
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((r) => noWechat.http.close(() => r()));
    await new Promise<void>((r) => withWechat.http.close(() => r()));
  });

  async function get402(port: number) {
    const res = await realFetch(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    return { status: res.status, body: await res.json() as any };
  }

  it('without provider.wechat: 402 accepts[] has no wechat entry', async () => {
    stubWechatFetch(realFetch);
    const { status, body } = await get402(noWechat.port);
    expect(status).toBe(402);
    const accepts = body.x402.accepts as any[];
    expect(accepts.some((a) => a.scheme === 'wechatpay-native')).toBe(false);
  });

  it('with provider.wechat: 402 appends a wechatpay-native entry with code_url', async () => {
    stubWechatFetch(realFetch);
    const { status, body } = await get402(withWechat.port);
    expect(status).toBe(402);
    const accepts = body.x402.accepts as any[];

    // Crypto entries still present, untouched.
    expect(accepts.some((a) => a.network === 'eip155:8453')).toBe(true);

    const wx = accepts.find((a) => a.scheme === 'wechatpay-native');
    expect(wx).toBeDefined();
    expect(wx.network).toBe('wechat');
    expect(wx.asset).toBe('CNY');
    expect(wx.amount).toBe('10.00');
    expect(wx.payTo).toBe('1900000001');
    expect(wx.extra.code_url).toBe('weixin://wxpay/bizpayurl?pr=SRV0TEST');
    expect(typeof wx.extra.out_trade_no).toBe('string');
  });

  it('execute: a paid order (trade_state=SUCCESS) verifies, runs the skill, returns 200', async () => {
    stubWechatFetch(realFetch);
    const paymentPayload = {
      x402Version: 2,
      scheme: 'wechatpay-native',
      network: 'wechat',
      accepted: {
        scheme: 'wechatpay-native',
        network: 'wechat',
        extra: { out_trade_no: 'WXserver0test01' },
      },
      payload: { out_trade_no: 'WXserver0test01' },
    };
    const res = await realFetch(`http://127.0.0.1:${withWechat.port}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': Buffer.from(JSON.stringify(paymentPayload)).toString('base64'),
      },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.result.url).toBe('https://example.com/v.mp4');
    expect(body.payment.status).toBe('fulfilled');
    expect(body.payment.transaction).toBe('4200SRV0001');
  });
});
