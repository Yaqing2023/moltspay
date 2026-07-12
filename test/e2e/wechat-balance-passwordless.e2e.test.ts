/**
 * P1-7 end-to-end: the whole password-free chain through both real layers.
 *
 * A real MoltsPayServer (WeChat + CNY balance rail + a ping skill) and a real
 * MoltsPayClient, wired over a real localhost HTTP server. The WeChat gateway
 * is the only stub; localhost passes through. Drives:
 *   pay --rail balance -> deduct 402 (empty) -> auto top-up pack -> scan
 *   confirmed -> credit -> retry -> password-free success.
 * No network, no wallet, no money.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { MoltsPayServer } from '../../src/server/index.js';
import { MoltsPayClient } from '../../src/client/node/index.js';

interface Booted { server: MoltsPayServer; http: Server; port: number; }

/** Stub only the WeChat gateway; echo the attach set at order-create. */
function stubWechatGateway(realFetch: typeof fetch, paidFen: number): void {
  const orders = new Map<string, { attach?: string }>();
  const json = (body: unknown) => ({
    ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body),
  } as any);
  vi.stubGlobal('fetch', (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('api.mch.weixin.qq.com')) {
      if (u.includes('/v3/pay/transactions/native')) {
        const body = JSON.parse(init.body);
        orders.set(body.out_trade_no, { attach: body.attach });
        return json({ code_url: 'weixin://wxpay/bizpayurl?pr=E2E' });
      }
      const otn = decodeURIComponent(u.split('/out-trade-no/')[1].split('?')[0]);
      return json({
        trade_state: 'SUCCESS',
        transaction_id: '4200E2E0001',
        out_trade_no: otn,
        amount: { total: paidFen, payer_total: paidFen, currency: 'CNY' },
        attach: orders.get(otn)?.attach,
      });
    }
    return realFetch(url, init); // localhost passthrough
  }) as any);
}

describe('E2E: WeChat-funded password-free balance payment', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-passwordless-'));
  const realFetch = globalThis.fetch;
  let b: Booted;
  let serverUrl: string;
  let client: MoltsPayClient;

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
        name: 'e2e-passwordless',
        wallet: '0x' + 'a'.repeat(40),
        chains: ['wechat', 'balance'],
        wechat: {
          mchid: '1900000001', appid: 'wx8888888888888888', serial_no: 'TESTSERIAL0001',
          private_key_path: keyPath, notify_url: 'https://example.com/wechat/notify',
        },
        balance: {
          db_path: ':memory:', currency: 'CNY', single_limit: '50.00', daily_limit: '200.00',
          topup_packs: ['20.00', '50.00'], default_pack: '20.00', auto_topup_max: '50.00',
        },
      },
      services: [{ id: 'ping', function: 'ping', price: 3.99, currency: 'CNY', input: {}, output: {}, balance: { price: '3.99' } }],
    };
    const manifestPath = path.join(dir, 'e2e.services.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const server = new MoltsPayServer(manifestPath, {});
    server.skill('ping', async () => ({ pong: 'ok' }));
    const handle = (server as any).handleRequest.bind(server);
    const http = createServer((req, res) => handle(req, res));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    b = { server, http, port: (http.address() as AddressInfo).port };
    serverUrl = `http://127.0.0.1:${b.port}`;
    client = new MoltsPayClient({ configDir: mkdtempSync(path.join(tmpdir(), 'e2e-client-')) });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((r) => b.http.close(() => r()));
  });

  it('scans once to fund, then pays password-free end to end', async () => {
    stubWechatGateway(realFetch, 2000); // pack pays 20.00 CNY

    const onTopupRequired = vi.fn();
    const onTopupCredited = vi.fn();
    const result = await client.pay(serverUrl, 'ping', {}, {
      rail: 'balance', buyerId: 'e2e-buyer', topupPollIntervalMs: 5,
      onTopupRequired, onTopupCredited,
    });

    // The skill ran, so the password-free retry succeeded after funding.
    expect(result).toEqual({ pong: 'ok' });
    expect(onTopupRequired).toHaveBeenCalledWith('20.00', 'weixin://wxpay/bizpayurl?pr=E2E');
    expect(onTopupCredited).toHaveBeenCalledWith('20.00');

    // Ledger reflects 20.00 funded minus the 3.99 deduct.
    const bal = await client.getBuyerBalance(serverUrl, 'e2e-buyer');
    expect(bal.balance).toBe('16.01');
    expect(bal.currency).toBe('CNY');
  });

  it('the next purchase is password-free with no new QR', async () => {
    stubWechatGateway(realFetch, 2000);
    const onTopupRequired = vi.fn();
    const result = await client.pay(serverUrl, 'ping', {}, {
      rail: 'balance', buyerId: 'e2e-buyer', topupPollIntervalMs: 5, onTopupRequired,
    });
    expect(result).toEqual({ pong: 'ok' });
    expect(onTopupRequired).not.toHaveBeenCalled(); // balance still sufficient
    const bal = await client.getBuyerBalance(serverUrl, 'e2e-buyer');
    expect(bal.balance).toBe('12.02'); // 16.01 - 3.99
  });
});
