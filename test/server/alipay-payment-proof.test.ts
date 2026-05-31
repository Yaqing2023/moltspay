/**
 * HTTP regression: the server must consume the `Payment-Proof` header.
 *
 * After the buyer pays, alipay-bot re-requests the resource with a
 * `Payment-Proof` header (Base64URL `{protocol:{payment_proof,trade_no},
 * method:{client_session}}`). The server has to read it, verify via the
 * facilitator, run the skill, and return 200 — NOT a fresh 402 challenge.
 *
 * This path was missing (the server only advertised Payment-Proof in CORS),
 * so a paid buyer got a 402 loop — caught by the live 1-CNY E2E. Here we mock
 * the Alipay gateway (verify + fulfillment.confirm → code 10000) and pass real
 * fetch through to localhost, so the whole server path runs offline.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { MoltsPayServer } from '../../src/server/index.js';

const realFetch = globalThis.fetch;

// Intercept Alipay gateway calls; pass everything else (localhost) through.
function stubGatewayFetch() {
  vi.stubGlobal('fetch', (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('alipay.com') || u.includes('alipaydev.com')) {
      // The gateway call form-encodes `method` in the POST body, not the URL.
      const method = new URLSearchParams(String(init?.body ?? '')).get('method') ?? '';
      const body = method.includes('verify')
        ? { code: '10000', msg: 'Success', trade_no: 'T1', amount: '1.00', active: true }
        : { code: '10000', msg: 'Success' }; // fulfillment.confirm
      // alipayOpenApiCall expects the `${method.replace(/\./g,'_')}_response` envelope.
      const key = method.replace(/\./g, '_') + '_response';
      return new Response(JSON.stringify({ [key]: body, sign: 'x' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, init);
  }) as typeof fetch);
}

function makeProofHeader(): string {
  const proof = {
    protocol: { payment_proof: 'p'.repeat(64), trade_no: '2'.repeat(32) },
    method: { client_session: 'sess-abc' },
  };
  return Buffer.from(JSON.stringify(proof)).toString('base64url');
}

describe('server consumes Payment-Proof → verify → fulfill (§ live E2E)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'alipay-proof-'));
  let http: Server;
  let port: number;

  beforeAll(async () => {
    stubGatewayFetch();
    const kp = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const strip = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    writeFileSync(path.join(dir, 'priv.txt'), strip(kp.privateKey));
    writeFileSync(path.join(dir, 'pub.txt'), strip(kp.publicKey));
    const manifestPath = path.join(dir, 'm.services.json');
    writeFileSync(manifestPath, JSON.stringify({
      provider: {
        name: 'proof test', wallet: '0x' + 'a'.repeat(40), chains: ['base'],
        alipay: {
          seller_id: '2088641494699428', app_id: '2021006150642142', seller_name: 'demo',
          service_id_default: 'API_X',
          private_key_path: path.join(dir, 'priv.txt'),
          alipay_public_key_path: path.join(dir, 'pub.txt'),
          gateway_url: 'https://openapi.alipay.com/gateway.do',
        },
      },
      services: [{
        id: 'video-demo', name: 'demo', price: 0.14, currency: 'USDC', input: {}, output: {},
        alipay: { service_id: 'API_X', price_cny: '1.00', goods_name: 'demo' },
      }],
    }));
    const server = new MoltsPayServer(manifestPath, {});
    server.skill('video-demo', async () => ({ url: 'https://example.com/v.mp4' }));
    const handle = (server as any).handleRequest.bind(server);
    http = createServer((req, res) => handle(req, res));
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    port = (http.address() as AddressInfo).port;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((r) => http.close(() => r()));
  });

  it('returns 200 + the skill result when a valid Payment-Proof is presented', async () => {
    const res = await realFetch(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Payment-Proof': makeProofHeader() },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result?.url ?? body.url).toBe('https://example.com/v.mp4');
    // x-payment-response confirms the fulfillment leg ran.
    expect(res.headers.get('x-payment-response')).toBeTruthy();
  });

  it('still returns 402 (no proof) — unchanged 1.6.0 behavior', async () => {
    const res = await realFetch(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'video-demo', params: {} }),
    });
    expect(res.status).toBe(402);
  });
});
