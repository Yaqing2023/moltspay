/**
 * HTTP-level regression for the Alipay 402 dual-emit path (§1 closeout).
 *
 * Boots a real MoltsPayServer over HTTP (reusing the actual handleRequest)
 * and asserts:
 *   1. WITHOUT provider.alipay  -> 402 carries x402 `X-Payment-Required` only,
 *      NO `Payment-Needed` header  (byte-identical to 1.6.0 behavior).
 *   2. WITH provider.alipay      -> 402 carries BOTH headers; the legacy
 *      `Payment-Needed` is Base64URL and decodes to a signed challenge.
 *   3. Adding the alipay rail does NOT mutate or drop any of the existing
 *      8-chain crypto `accepts[]` entries — alipay is appended, nothing else
 *      changes. This is the "双发 header 不破坏 1.6.0" regression gate.
 *
 * Self-contained: generates a throwaway RSA keypair and writes it as the
 * bare-Base64 form Alipay actually hands out, so it runs in CI without the
 * real sr007 keys.  No network, no real money.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { MoltsPayServer } from '../../src/server/index.js';
import { decodeBase64UrlWithPadFix } from '../../src/facilitators/alipay/encoding.js';

// All 8 crypto chains the provider can accept (CHAIN_TO_NETWORK in server/index.ts).
const CHAINS = [
  'base', 'base_sepolia', 'polygon', 'tempo_moderato',
  'bnb', 'bnb_testnet', 'solana', 'solana_devnet',
];

interface Booted { server: MoltsPayServer; http: Server; port: number; }

async function boot(manifest: any, dir: string, name: string): Promise<Booted> {
  const manifestPath = path.join(dir, `${name}.services.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const server = new MoltsPayServer(manifestPath, {});
  server.skill('video-demo', async () => ({ url: 'https://example.com/v.mp4' }));
  // Reuse the real request handler without the un-closeable listen() helper.
  const handle = (server as any).handleRequest.bind(server);
  const http = createServer((req, res) => handle(req, res));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return { server, http, port };
}

async function post402(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service: 'video-demo', params: {} }),
  });
  const body = await res.json();
  return {
    status: res.status,
    xPaymentRequired: res.headers.get('x-payment-required'),
    paymentNeeded: res.headers.get('payment-needed'),
    x402: body.x402,
  };
}

describe('Alipay 402 dual-emit — HTTP regression (§1)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alipay-402-'));
  let noAlipay: Booted;
  let withAlipay: Booted;

  beforeAll(async () => {
    // Bare-Base64 keypair, exactly the shape Alipay Open Platform hands out.
    const kp = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const strip = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const privPath = path.join(dir, 'priv.txt');
    const pubPath = path.join(dir, 'pub.txt');
    writeFileSync(privPath, strip(kp.privateKey));
    writeFileSync(pubPath, strip(kp.publicKey));

    const baseProvider = {
      name: 'regression provider',
      wallet: '0x' + 'a'.repeat(40),
      solana_wallet: 'So11111111111111111111111111111111111111112',
      chains: CHAINS,
    };
    const baseService = {
      id: 'video-demo', name: '产品演示视频', price: 0.14, currency: 'USDC',
      input: {}, output: {},
    };

    noAlipay = await boot(
      { provider: baseProvider, services: [baseService] },
      dir, 'no-alipay',
    );
    withAlipay = await boot(
      {
        provider: {
          ...baseProvider,
          alipay: {
            seller_id: '2088641494699428',
            app_id: '2021006150642142',
            seller_name: '上海超响应数字科技有限公司',
            service_id_default: 'API_0EA6DC4FC99A4DF7',
            private_key_path: privPath,
            alipay_public_key_path: pubPath,
            gateway_url: 'https://openapi.alipaydev.com/gateway.do',
          },
        },
        services: [{
          ...baseService,
          alipay: { service_id: 'API_0EA6DC4FC99A4DF7', price_cny: '1.00', goods_name: '产品演示视频 - 系列一' },
        }],
      },
      dir, 'with-alipay',
    );
  });

  afterAll(async () => {
    await Promise.all([
      new Promise<void>((r) => noAlipay.http.close(() => r())),
      new Promise<void>((r) => withAlipay.http.close(() => r())),
    ]);
  });

  it('without alipay: 402 has X-Payment-Required and NO Payment-Needed (1.6.0 behavior)', async () => {
    const r = await post402(noAlipay.port);
    expect(r.status).toBe(402);
    expect(r.xPaymentRequired).toBeTruthy();
    expect(r.paymentNeeded).toBeNull();
    expect(r.x402.accepts.some((a: any) => a.scheme === 'alipay-aipay')).toBe(false);
  });

  it('without alipay: one accepts[] entry per configured crypto chain', async () => {
    const r = await post402(noAlipay.port);
    const networks = r.x402.accepts.map((a: any) => a.network);
    // Every configured chain shows up; none are alipay.
    expect(networks.length).toBe(CHAINS.length);
    expect(new Set(networks).size).toBe(CHAINS.length);
  });

  it('with alipay: 402 dual-emits BOTH X-Payment-Required and Payment-Needed', async () => {
    const r = await post402(withAlipay.port);
    expect(r.status).toBe(402);
    expect(r.xPaymentRequired).toBeTruthy();
    expect(r.paymentNeeded).toBeTruthy();
  });

  it('with alipay: Payment-Needed is Base64URL and decodes to a signed challenge', async () => {
    const r = await post402(withAlipay.port);
    const challenge = JSON.parse(decodeBase64UrlWithPadFix(r.paymentNeeded!));
    expect(challenge.protocol.seller_signature).toBeTruthy();
    expect(challenge.protocol.out_trade_no).toBeTruthy();
  });

  it('with alipay: x402 accepts[] includes the alipay-aipay entry (CNY)', async () => {
    const r = await post402(withAlipay.port);
    const alipay = r.x402.accepts.find((a: any) => a.scheme === 'alipay-aipay');
    expect(alipay).toBeDefined();
    expect(alipay.asset).toBe('CNY');
    expect(alipay.amount).toBe('1.00');
  });

  it('regression: adding alipay appends — every crypto accepts entry is preserved unchanged', async () => {
    const before = await post402(noAlipay.port);
    const after = await post402(withAlipay.port);
    const cryptoBefore = before.x402.accepts;
    const cryptoAfter = after.x402.accepts.filter((a: any) => a.scheme !== 'alipay-aipay');
    // Same number of crypto entries, and each is byte-identical (alipay only appends).
    expect(cryptoAfter.length).toBe(cryptoBefore.length);
    expect(cryptoAfter).toEqual(cryptoBefore);
    // The alipay entry is appended last, not interleaved.
    expect(after.x402.accepts.at(-1).scheme).toBe('alipay-aipay');
  });
});
