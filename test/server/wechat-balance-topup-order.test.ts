/**
 * P1-4: WeChat-funded balance top-up via the server endpoints.
 *
 * Covers POST /balance/topup/order (buyer-bound Native order) and
 * POST /balance/topup/confirm (polling-fallback credit): the server verifies
 * the order with the gateway and credits the buyer bound in `attach` with the
 * gateway-confirmed payer_total -- never a client-declared amount.
 *
 * The stubbed gateway records the `attach` sent at order-create and echoes it
 * back on the order-query, so the buyer binding is exercised end-to-end. No
 * network, no money. CNY ledger: payer_total (fen) credits 1:1.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'node:crypto';
import { MoltsPayServer } from '../../src/server/index.js';

interface Booted { server: MoltsPayServer; http: Server; port: number; }

/**
 * Stub the WeChat gateway: order-create returns a code_url and records the
 * sent attach by out_trade_no; order-query echoes that attach with a SUCCESS
 * of `paidFen`. An out_trade_no containing "PENDING" queries as NOTPAY; one
 * containing "NOBINDING" queries SUCCESS but without attach.
 */
function stubGateway(realFetch: typeof fetch, paidFen: number): void {
  const orders = new Map<string, { attach?: string }>();
  const json = (body: unknown) => ({
    ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body),
  } as any);
  vi.stubGlobal('fetch', (async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes('/v3/pay/transactions/native')) {
      const body = JSON.parse(init.body);
      orders.set(body.out_trade_no, { attach: body.attach });
      return json({ code_url: 'weixin://wxpay/bizpayurl?pr=TEST01' });
    }
    if (u.includes('/v3/pay/transactions/out-trade-no/')) {
      const otn = decodeURIComponent(u.split('/out-trade-no/')[1].split('?')[0]);
      if (otn.includes('PENDING')) return json({ trade_state: 'NOTPAY' });
      const attach = otn.includes('NOBINDING') ? undefined : orders.get(otn)?.attach;
      return json({
        trade_state: 'SUCCESS',
        transaction_id: '4200TESTORDER0001',
        out_trade_no: otn,
        amount: { total: paidFen, payer_total: paidFen, currency: 'CNY' },
        attach,
      });
    }
    return realFetch(url, init);
  }) as any);
}

describe('WeChat-funded balance top-up (order + confirm)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wechat-topup-order-'));
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
        name: 'wechat-topup-order-test',
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
      services: [{ id: 'ping', function: 'ping', price: 3.99, currency: 'CNY', input: {}, output: {} }],
    };
    const manifestPath = path.join(dir, 'topup-order.services.json');
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
  afterEach(() => vi.unstubAllGlobals());

  const post = async (route: string, body: unknown) => {
    const res = await realFetch(`http://127.0.0.1:${b.port}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };
  const balanceOf = async (buyerId: string) => {
    const res = await realFetch(`http://127.0.0.1:${b.port}/balance?buyer_id=${buyerId}`);
    return (await res.json() as any).balance;
  };

  it('creates a buyer-bound order and credits payer_total on confirm', async () => {
    stubGateway(realFetch, 2000); // 20.00 CNY
    const order = await post('/balance/topup/order', { buyer_id: 'buyer-a', pack: '20.00' });
    expect(order.status).toBe(200);
    expect(order.body.code_url).toContain('weixin://');
    expect(order.body.pack).toBe('20.00');
    const otn = order.body.out_trade_no as string;

    const confirm = await post('/balance/topup/confirm', { out_trade_no: otn });
    expect(confirm.status).toBe(200);
    expect(confirm.body.credited).toBe(true);
    expect(confirm.body.buyer_id).toBe('buyer-a');
    expect(confirm.body.balance).toBe('20.00');
    expect(await balanceOf('buyer-a')).toBe('20.00');
  });

  it('confirm is idempotent on out_trade_no', async () => {
    stubGateway(realFetch, 2000);
    const order = await post('/balance/topup/order', { buyer_id: 'buyer-b', pack: '20.00' });
    const otn = order.body.out_trade_no as string;
    await post('/balance/topup/confirm', { out_trade_no: otn });
    const again = await post('/balance/topup/confirm', { out_trade_no: otn });
    expect(again.body.credited).toBe(true);
    expect(again.body.replayed).toBe(true);
    expect(await balanceOf('buyer-b')).toBe('20.00'); // not doubled
  });

  it('uses default_pack when none is given', async () => {
    stubGateway(realFetch, 2000);
    const order = await post('/balance/topup/order', { buyer_id: 'buyer-c' });
    expect(order.status).toBe(200);
    expect(order.body.pack).toBe('20.00');
  });

  it('reuses one pending order for the same buyer + pack', async () => {
    stubGateway(realFetch, 2000);
    const o1 = await post('/balance/topup/order', { buyer_id: 'buyer-d', pack: '20.00' });
    const o2 = await post('/balance/topup/order', { buyer_id: 'buyer-d', pack: '20.00' });
    expect(o2.body.out_trade_no).toBe(o1.body.out_trade_no);
  });

  it('rejects a pack that is neither offered nor within auto_topup_max', async () => {
    stubGateway(realFetch, 2000);
    const order = await post('/balance/topup/order', { buyer_id: 'buyer-e', pack: '99.00' });
    expect(order.status).toBe(400);
    expect(order.body.error).toMatch(/not an offered top-up pack/);
  });

  it('confirm returns pending (not an error) before payment', async () => {
    stubGateway(realFetch, 2000);
    const confirm = await post('/balance/topup/confirm', { out_trade_no: 'WXPENDINGorder01' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.credited).toBe(false);
    expect(confirm.body.pending).toBe(true);
  });

  it('confirm rejects a paid order with no buyer binding', async () => {
    stubGateway(realFetch, 2000);
    const confirm = await post('/balance/topup/confirm', { out_trade_no: 'WXNOBINDINGorder01' });
    expect(confirm.status).toBe(422);
    expect(confirm.body.error).toMatch(/buyer binding/);
  });
});
