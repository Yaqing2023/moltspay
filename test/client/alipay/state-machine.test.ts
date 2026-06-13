import { describe, it, expect, vi, beforeAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  AlipayClient, resolveSessionId, assertTradeNo,
  parseTradeNo, parsePaymentUrl, extractMedia, extractBody, isWalletReady,
  resetWalletCache, resetIntentCache,
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

  it('extractBody prefers the structured resourceResponse field (alipay-bot ≥1.0.x)', () => {
    // The settled result wraps the bot's own x402 re-request HTTP body under
    // `resourceResponse` (see ALIPAY-RAIL.md §9.3). Surface its `.result`.
    expect(
      extractBody(['{"success":true,"tradeNo":"1","resourceResponse":{"result":{"url":"v.mp4"}}}']),
    ).toBe('{"url":"v.mp4"}');
    // A string resourceResponse is returned verbatim.
    expect(
      extractBody(['{"success":true,"resourceResponse":"hi"}']),
    ).toBe('hi');
    // resourceResponse wins over a sibling body report.
    expect(
      extractBody(['{"resourceResponse":{"result":"R"},"body":"**资源响应体**：\\n{\\"result\\":\\"OLD\\"}"}']),
    ).toBe('R');
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

  it('does NOT leak the resource into the user/log stream (§9.3)', async () => {
    // A realistic settled poll whose output embeds the delivered resource.
    const SECRET = 'data:video/mp4;base64,AAAACONFIDENTIALPAYLOAD';
    const runner = fakeRunner({
      '402-query-payment-status': () =>
        // Emitted as the bot's structured settled result with resourceResponse.
        Promise.resolve({
          exitCode: 0,
          lines: [`{"success":true,"tradeNo":"${TRADE}","resourceResponse":{"result":{"video":"${SECRET}"}}}`],
        }),
    });
    const lines: string[] = [];
    const client = new AlipayClient({
      configDir, runner, getVersion: async () => 'v1.0.14', now: () => 0,
    });

    const result = await client.pay402({
      resourceUrl: 'http://x/execute',
      requirement,
      onLine: (l) => lines.push(l),
    });

    // The deliverable IS returned via the typed result …
    expect(result.body).toBe(`{"video":"${SECRET}"}`);
    // … but it NEVER appears in the forwarded user/log stream.
    expect(lines.some((l) => l.includes(SECRET))).toBe(false);
    expect(lines.some((l) => l.includes('resourceResponse'))).toBe(false);
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

describe('checkWallet — process-level positive cache', () => {
  const TTL = 10 * 60 * 1000; // matches DEFAULT_WALLET_TTL_MS
  let configDir: string;
  let t: number;
  const now = () => t;
  const countWalletSpawns = (runner: CliRunner) =>
    (runner as any).mock.calls.filter((c: any[]) => c[0][0] === 'check-wallet').length;

  beforeAll(() => { configDir = mkdtempSync(path.join(tmpdir(), 'alipay-wc-')); });
  // Fresh cache per test; t reset each time.
  const mk = (extra?: Partial<Record<string, () => Promise<RunCliResult>>>) => {
    const runner = fakeRunner(extra);
    const client = new AlipayClient({
      configDir, runner, getVersion: async () => 'v0.3.15', now, cacheWallet: true,
    });
    return { runner, client };
  };

  it('skips the check-wallet spawn on the 2nd call within the TTL', async () => {
    resetWalletCache(); t = 0;
    const { runner, client } = mk();
    await client.checkWallet();
    await client.checkWallet();
    expect(countWalletSpawns(runner)).toBe(1); // 2nd was a cache hit
  });

  it('re-spawns once the TTL has elapsed', async () => {
    resetWalletCache(); t = 0;
    const { runner, client } = mk();
    await client.checkWallet();        // caches until t = TTL
    t = TTL + 1;                       // expire
    await client.checkWallet();        // must spawn again
    expect(countWalletSpawns(runner)).toBe(2);
  });

  it('never caches a NOT-ready verdict (each call re-spawns)', async () => {
    resetWalletCache(); t = 0;
    const notReady = () => Promise.resolve({
      exitCode: 0, lines: ['{"code":500,"message":"未开通"}'],
    });
    const { runner, client } = mk({ 'check-wallet': notReady });
    await expect(client.checkWallet()).rejects.toBeInstanceOf(NeedsWalletSetupError);
    await expect(client.checkWallet()).rejects.toBeInstanceOf(NeedsWalletSetupError);
    expect(countWalletSpawns(runner)).toBe(2);
  });

  it('resetWalletCache() forces the next call to spawn', async () => {
    resetWalletCache(); t = 0;
    const a = mk();
    await a.client.checkWallet();
    resetWalletCache();
    const b = mk();
    await b.client.checkWallet();
    expect(countWalletSpawns(b.runner)).toBe(1);
  });

  it('injected runners are NOT cached by default (cacheWallet defaults off)', async () => {
    resetWalletCache(); t = 0;
    const runner = fakeRunner();
    // No cacheWallet → defaults to !runner → false for an injected runner.
    const client = new AlipayClient({ configDir, runner, getVersion: async () => 'v0.3.15', now });
    await client.checkWallet();
    await client.checkWallet();
    expect(countWalletSpawns(runner)).toBe(2);
  });
});

describe('payment-intent — process-level handshake skip-cache', () => {
  const TTL = 10 * 60 * 1000; // matches DEFAULT_INTENT_TTL_MS
  let configDir: string;
  let t: number;
  const now = () => t;
  const countIntentSpawns = (runner: CliRunner) =>
    (runner as any).mock.calls.filter((c: any[]) => c[0][0] === 'payment-intent').length;
  const pay = (client: AlipayClient) =>
    client.pay402({ resourceUrl: 'http://x/execute', requirement });

  beforeAll(() => { configDir = mkdtempSync(path.join(tmpdir(), 'alipay-ic-')); });
  // cacheIntent + cacheWallet both on so only the intent count is under test.
  const mk = () => {
    const runner = fakeRunner();
    const client = new AlipayClient({
      configDir, runner, getVersion: async () => 'v0.3.15', now,
      cacheIntent: true, cacheWallet: true,
    });
    return { runner, client };
  };

  it('skips the payment-intent spawn on the 2nd payment within the TTL', async () => {
    resetIntentCache(); resetWalletCache(); t = 0;
    const a = mk();
    await pay(a.client);
    const b = mk();           // new client, same (configDir, framework)
    await pay(b.client);
    expect(countIntentSpawns(a.runner)).toBe(1);
    expect(countIntentSpawns(b.runner)).toBe(0); // 2nd payment skipped the handshake
  });

  it('re-spawns the handshake once the TTL has elapsed', async () => {
    resetIntentCache(); resetWalletCache(); t = 0;
    const a = mk();
    await pay(a.client);      // caches until t = TTL
    t = TTL + 1;              // expire
    const b = mk();
    await pay(b.client);
    expect(countIntentSpawns(b.runner)).toBe(1);
  });

  it('resetIntentCache() forces the next payment to handshake', async () => {
    resetIntentCache(); resetWalletCache(); t = 0;
    await pay(mk().client);
    resetIntentCache();
    const b = mk();
    await pay(b.client);
    expect(countIntentSpawns(b.runner)).toBe(1);
  });

  it('injected runners are NOT cached by default (cacheIntent defaults off)', async () => {
    resetIntentCache(); resetWalletCache(); t = 0;
    const runner = fakeRunner();
    // No cacheIntent → defaults to !runner → false for an injected runner.
    const client = new AlipayClient({ configDir, runner, getVersion: async () => 'v0.3.15', now });
    await pay(client);
    await pay(client);
    expect(countIntentSpawns(runner)).toBe(2);
  });
});
