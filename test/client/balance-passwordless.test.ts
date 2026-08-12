/**
 * P1-5: client password-free orchestration for the balance rail.
 *
 * - sufficient balance: one deduct, no QR, no top-up call.
 * - insufficient balance: deduct 402 -> auto top-up pack (QR surfaced) ->
 *   confirm credited -> retry deduct -> success. Hooks fire.
 * - autoTopup: false: insufficient fails fast, no top-up.
 *
 * fetch is stubbed to emulate the server; no network, no wallet, no money.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { MoltsPayClient } from '../../src/client/node/index.js';

const SERVER = 'http://server.test';

function makeClient(): MoltsPayClient {
  const dir = mkdtempSync(path.join(tmpdir(), 'moltspay-client-'));
  return new MoltsPayClient({ configDir: dir });
}

const json = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
} as any);

describe('balance rail password-free orchestration', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('deducts without a QR when the balance is sufficient', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      calls.push(`${init?.method || 'GET'} ${u}`);
      if (u.endsWith('/services')) return json(200, { services: [] });
      if (u.endsWith('/execute')) return json(200, { result: { pong: 'ok' } });
      throw new Error(`unexpected ${u}`);
    }));

    const client = makeClient();
    const onTopupRequired = vi.fn();
    const result = await client.pay(SERVER, 'ping', {}, { rail: 'balance', buyerId: 'b1', onTopupRequired });

    expect(result).toEqual({ pong: 'ok' });
    expect(onTopupRequired).not.toHaveBeenCalled();
    expect(calls.some(c => c.includes('/balance/topup/order'))).toBe(false);
  });

  it('auto-tops-up on insufficient balance, then retries password-free', async () => {
    let executeHits = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.endsWith('/services')) return json(200, { services: [] });
      if (u.endsWith('/execute')) {
        executeHits++;
        if (executeHits === 1) return json(402, { error: 'Balance deduction failed: Insufficient balance (have 0.00)' });
        return json(200, { result: { pong: 'ok' } });
      }
      if (u.endsWith('/balance/topup/order')) {
        return json(200, { code_url: 'weixin://PACK', out_trade_no: 'WXpack01', pack: '20.00', max_timeout_seconds: 300 });
      }
      if (u.endsWith('/balance/topup/confirm')) {
        return json(200, { credited: true, buyer_id: 'b1', balance: '20.00', tx_id: 'btx_1' });
      }
      throw new Error(`unexpected ${u}`);
    }));

    const client = makeClient();
    const onTopupRequired = vi.fn();
    const onTopupCredited = vi.fn();
    const result = await client.pay(SERVER, 'ping', {}, {
      rail: 'balance', buyerId: 'b1', topupPollIntervalMs: 5, onTopupRequired, onTopupCredited,
    });

    expect(result).toEqual({ pong: 'ok' });
    expect(onTopupRequired).toHaveBeenCalledWith('20.00', 'weixin://PACK', 'WXpack01');
    expect(onTopupCredited).toHaveBeenCalledWith('20.00');
    expect(executeHits).toBe(2); // failed once, retried once after credit
  });

  it('waits through a pending confirm before crediting', async () => {
    let confirmHits = 0;
    let executeHits = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/services')) return json(200, { services: [] });
      if (u.endsWith('/execute')) {
        executeHits++;
        return executeHits === 1
          ? json(402, { error: 'Insufficient balance' })
          : json(200, { result: { ok: true } });
      }
      if (u.endsWith('/balance/topup/order')) {
        return json(200, { code_url: 'weixin://P', out_trade_no: 'WX1', pack: '20.00', max_timeout_seconds: 300 });
      }
      if (u.endsWith('/balance/topup/confirm')) {
        confirmHits++;
        return confirmHits < 3
          ? json(200, { credited: false, pending: true })
          : json(200, { credited: true, balance: '20.00' });
      }
      throw new Error(`unexpected ${u}`);
    }));

    const client = makeClient();
    const result = await client.pay(SERVER, 'ping', {}, { rail: 'balance', buyerId: 'b1', topupPollIntervalMs: 5 });
    expect(result).toEqual({ ok: true });
    expect(confirmHits).toBe(3);
  });

  it('fails fast on insufficient balance when autoTopup is false', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/services')) return json(200, { services: [] });
      if (u.endsWith('/execute')) return json(402, { error: 'Insufficient balance (have 0.00)' });
      throw new Error(`unexpected ${u}`);
    }));

    const client = makeClient();
    await expect(
      client.pay(SERVER, 'ping', {}, { rail: 'balance', buyerId: 'b1', autoTopup: false }),
    ).rejects.toThrow(/insufficient/i);
    expect(calls.some(c => c.includes('/balance/topup/order'))).toBe(false);
  });
});
