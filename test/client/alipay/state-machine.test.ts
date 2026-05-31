import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  AlipayClient, resolveSessionId, assertTradeNo,
  parseTradeNo, parsePaymentUrl, extractMedia, extractBody, isWalletReady,
} from '../../../src/client/alipay/index.js';
import {
  AlipayProtocolError, NeedsWalletSetupError,
} from '../../../src/client/alipay/errors.js';
import type { CliRunner, RunCliResult } from '../../../src/client/alipay/cli.js';
import type { X402PaymentRequirements } from '../../../src/client/core/types.js';

const TRADE = '1'.repeat(32);
const ok = (lines: string[]): Promise<RunCliResult> => Promise.resolve({ exitCode: 0, lines });

const requirement: X402PaymentRequirements = {
  scheme: 'alipay-aipay', network: 'alipay', asset: 'CNY', amount: '1.00',
  maxTimeoutSeconds: 1800,
  extra: { payment_needed_header: 'BASE64URLHEADER', out_trade_no: 'VID123' },
};

/** A runner that answers each alipay-bot subcommand with canned output. */
function fakeRunner(overrides: Partial<Record<string, () => Promise<RunCliResult>>> = {}): CliRunner {
  const fn = vi.fn((args: string[], opts?: any) => {
    const cmd = args[0];
    // Forward lines so onLine / MEDIA-stripping is exercised.
    const run = (lines: string[]) => {
      lines.forEach((l) => opts?.onLine?.(l));
      return ok(lines);
    };
    const table: Record<string, () => Promise<RunCliResult>> = {
      'payment-intent': () => run(['intent ok']),
      'check-wallet': () => run(['wallet OPENED']),
      '402-buyer-pay': () => run([
        'MEDIA: /tmp/qr.png',
        `paymentUrl: https://qr.alipay.com/short/abc`,
        `tradeNo: ${TRADE}`,
      ]),
      '402-query-payment-status': () => run(['STATUS: TRADE_SUCCESS', 'BODY: {"result":{"url":"v.mp4"}}']),
      '402-buyer-fulfillment-ack': () => run(['ack ok']),
    };
    return (overrides[cmd] ?? table[cmd] ?? (() => ok([])))();
  });
  return fn as unknown as CliRunner;
}

describe('pure helpers', () => {
  it('resolveSessionId prefers explicit, then env, then a fresh UUID', () => {
    expect(resolveSessionId('exp', 'env')).toBe('exp');
    expect(resolveSessionId(undefined, 'env')).toBe('env');
    const gen = resolveSessionId(undefined, undefined);
    expect(gen).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('assertTradeNo enforces 32 digits', () => {
    expect(() => assertTradeNo(TRADE)).not.toThrow();
    expect(() => assertTradeNo('123')).toThrowError(AlipayProtocolError);
    expect(() => assertTradeNo('x'.repeat(32))).toThrowError(AlipayProtocolError);
  });

  it('parseTradeNo handles labeled and bare 32-digit forms', () => {
    expect(parseTradeNo([`trade_no=${TRADE}`])).toBe(TRADE);
    expect(parseTradeNo([`noise ${TRADE} noise`])).toBe(TRADE);
    expect(parseTradeNo(['nothing'])).toBeNull();
  });

  it('parsePaymentUrl separates the shortened URL', () => {
    const { paymentUrl, shortenUrl } = parsePaymentUrl([
      'pay here: https://render.alipay.com/full/xyz',
      'short: https://qr.alipay.com/s/abc',
    ]);
    expect(paymentUrl).toContain('render.alipay.com');
    expect(shortenUrl).toContain('qr.alipay.com');
  });

  it('extractMedia pulls the path out of a MEDIA: line', () => {
    expect(extractMedia('MEDIA: /tmp/qr.png')).toBe('/tmp/qr.png');
    expect(extractMedia('not media')).toBeNull();
  });

  it('extractBody prefers the BODY: marker', () => {
    expect(extractBody(['STATUS: ok', 'BODY: {"a":1}'])).toBe('{"a":1}');
    expect(extractBody(['plain content'])).toBe('plain content');
  });

  // Real alipay-bot 0.3.15 output formats (verified against the live binary).
  it('isWalletReady reads the JSON {code} shape — 500/未开通 is NOT ready', () => {
    expect(isWalletReady(['{"code":500,"message":"未开通","reason":"..."}'])).toBe(false);
    expect(isWalletReady(['{"code":200,"message":"ok"}'])).toBe(true);
    // exit code is unreliable (always 0); decision must come from `code`.
    expect(isWalletReady(['{', '  "code": 500,', '  "message": "未开通"', '}'])).toBe(false);
  });

  it('extractBody pulls the resource out of the CLI JSON envelope', () => {
    expect(extractBody(['{"code":200,"data":{"url":"v.mp4"}}'])).toBe('{"url":"v.mp4"}');
    expect(extractBody(['{"code":200,"result":"hi"}'])).toBe('hi');
  });
});

describe('AlipayClient.pay402 — 8-step state machine', () => {
  let configDir: string;
  beforeAll(() => { configDir = mkdtempSync(path.join(tmpdir(), 'alipay-sm-')); });

  it('drives all steps in order and returns the resource body', async () => {
    const runner = fakeRunner();
    const lines: string[] = [];
    const pending: any[] = [];
    const client = new AlipayClient({
      configDir, runner, getVersion: async () => 'alipay-bot v0.3.15', now: () => 0,
    });

    const result = await client.pay402({
      resourceUrl: 'http://x/execute',
      requirement,
      onLine: (l) => lines.push(l),
      onPaymentPending: (info) => pending.push(info),
    });

    // Step sequence: intent → check-wallet → buyer-pay → query → ack
    const calls = (runner as any).mock.calls.map((c: any[]) => c[0][0]);
    expect(calls).toEqual([
      'payment-intent', 'check-wallet', '402-buyer-pay',
      '402-query-payment-status', '402-buyer-fulfillment-ack',
    ]);

    // Step 1b sent the session id + the REQUIRED intent-summary + framework.
    const intentArgs = (runner as any).mock.calls[0][0];
    expect(intentArgs).toContain('--session-id');
    expect(intentArgs).toContain('--intent-summary');
    expect(intentArgs).toContain('--framework');
    // alipay-bot does not recognize a 'moltspay' framework.
    expect(intentArgs).not.toContain('moltspay');

    // Step 4 surfaced the payment URL + 32-digit tradeNo.
    expect(pending).toHaveLength(1);
    expect(pending[0].tradeNo).toBe(TRADE);
    expect(pending[0].shortenUrl).toContain('qr.alipay.com');

    // Step 7 returned the body.
    expect(result.body).toBe('{"result":{"url":"v.mp4"}}');
    expect(result.payment.tradeNo).toBe(TRADE);

    // MEDIA: line was stripped from the user stream but captured.
    expect(result.media).toEqual(['/tmp/qr.png']);
    expect(lines.some((l) => l.includes('MEDIA:'))).toBe(false);
  });

  it('Step 3 writes the Payment-Needed header to a tmp file', async () => {
    const runner = fakeRunner();
    const client = new AlipayClient({
      configDir, runner, getVersion: async () => 'v0.3.15', now: () => 0,
    });
    await client.pay402({ resourceUrl: 'http://x/execute', requirement });
    const file = path.join(configDir, 'alipay', '402_VID123.txt');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('BASE64URLHEADER');
  });

  it('throws NeedsWalletSetupError on the real "未开通" JSON (exit 0)', async () => {
    // Real alipay-bot output when no wallet: JSON code 500, process exits 0.
    const runner = fakeRunner({
      'check-wallet': () => Promise.resolve({
        exitCode: 0,
        lines: ['{"code":500,"message":"未开通","reason":"当前尚未开启支付宝支付能力"}'],
      }),
    });
    const client = new AlipayClient({
      configDir, runner, getVersion: async () => 'v0.3.15', now: () => 0,
    });
    await expect(client.pay402({ resourceUrl: 'http://x/execute', requirement }))
      .rejects.toBeInstanceOf(NeedsWalletSetupError);
  });

  it('throws AlipayProtocolError when buyer-pay returns no tradeNo', async () => {
    const runner = fakeRunner({ '402-buyer-pay': () => ok(['paymentUrl: https://qr.alipay.com/x']) });
    const client = new AlipayClient({
      configDir, runner, getVersion: async () => 'v0.3.15', now: () => 0,
    });
    await expect(client.pay402({ resourceUrl: 'http://x/execute', requirement }))
      .rejects.toBeInstanceOf(AlipayProtocolError);
  });

  it('throws AlipayProtocolError when the requirement lacks payment_needed_header', async () => {
    const client = new AlipayClient({
      configDir, runner: fakeRunner(), getVersion: async () => 'v0.3.15', now: () => 0,
    });
    await expect(client.pay402({
      resourceUrl: 'http://x/execute',
      requirement: { ...requirement, extra: {} },
    })).rejects.toBeInstanceOf(AlipayProtocolError);
  });
});
