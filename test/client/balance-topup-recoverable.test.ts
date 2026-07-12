/**
 * 2.5: recoverable balance top-up (createBalanceTopupOrder / confirmBalanceTopup)
 * and pay(--topup-mode manual). fetch is stubbed to emulate the server; no
 * network, no money. Sessions persist under a temp configDir.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { MoltsPayClient } from '../../src/client/node/index.js';

const SERVER = 'http://server.test';

function makeClient(): MoltsPayClient {
  const dir = mkdtempSync(path.join(tmpdir(), 'moltspay-recov-'));
  return new MoltsPayClient({ configDir: dir });
}

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as any);

describe('recoverable balance top-up', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('createBalanceTopupOrder is non-blocking and persists a recoverable session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      if (String(url).endsWith('/balance/topup/order')) {
        return json(200, { code_url: 'weixin://P', out_trade_no: 'WXrec1', pack: '2.00', max_timeout_seconds: 300 });
      }
      throw new Error(`unexpected ${url}`);
    }));

    const client = makeClient();
    const order = await client.createBalanceTopupOrder(SERVER, { buyerId: 'b1' });
    expect(order.outTradeNo).toBe('WXrec1');
    expect(order.codeUrl).toBe('weixin://P');

    // Session persisted + recoverable by out_trade_no.
    const s = client.getBalanceTopupSession('WXrec1');
    expect(s?.status).toBe('pending');
    expect(s?.buyer_id).toBe('b1');
    expect(s?.server_url).toBe(SERVER);
    expect(client.listBalanceTopupSessions().length).toBe(1);
  });

  it('confirmBalanceTopup: pending before payment, credited after; updates the session', async () => {
    let paid = false;
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/balance/topup/order')) {
        return json(200, { code_url: 'weixin://P', out_trade_no: 'WXrec2', pack: '2.00', max_timeout_seconds: 300 });
      }
      if (u.endsWith('/balance/topup/confirm')) {
        return paid
          ? json(200, { credited: true, buyer_id: 'b1', balance: '2.00', tx_id: 'btx_9' })
          : json(200, { credited: false, pending: true, reason: 'NOTPAY' });
      }
      throw new Error(`unexpected ${u}`);
    }));

    const client = makeClient();
    await client.createBalanceTopupOrder(SERVER, { buyerId: 'b1' });

    // Recover by out_trade_no alone (server_url from the persisted session).
    const pending = await client.confirmBalanceTopup('WXrec2');
    expect(pending.credited).toBe(false);
    expect(pending.pending).toBe(true);

    paid = true;
    const credited = await client.confirmBalanceTopup('WXrec2');
    expect(credited.credited).toBe(true);
    expect(credited.balance).toBe('2.00');
    expect(client.getBalanceTopupSession('WXrec2')?.status).toBe('credited');
  });

  it('confirm returns a reason when no server URL and no session exist', async () => {
    const client = makeClient();
    const r = await client.confirmBalanceTopup('WXunknown');
    expect(r.credited).toBe(false);
    expect(r.reason).toMatch(/No server URL/);
  });

  it('pay(--topup-mode manual) returns topup_required without polling', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/services')) return json(200, { services: [] });
      if (u.endsWith('/execute')) return json(402, { error: 'Insufficient balance', code: 'insufficient_balance' });
      if (u.endsWith('/balance/topup/order')) {
        return json(200, { code_url: 'weixin://P', out_trade_no: 'WXrec3', pack: '2.00', max_timeout_seconds: 300 });
      }
      throw new Error(`unexpected ${u}`);
    }));

    const client = makeClient();
    const onTopupRequired = vi.fn();
    const result: any = await client.pay(SERVER, 'ping', {}, {
      rail: 'balance', buyerId: 'b1', topupMode: 'manual', onTopupRequired,
    });

    expect(result.status).toBe('topup_required');
    expect(result.out_trade_no).toBe('WXrec3');
    expect(onTopupRequired).toHaveBeenCalledWith('2.00', 'weixin://P');
    // Manual mode never polls confirm.
    expect(calls.some(c => c.endsWith('/balance/topup/confirm'))).toBe(false);
    // Session persisted for later recovery.
    expect(client.getBalanceTopupSession('WXrec3')?.status).toBe('pending');
  });
});
