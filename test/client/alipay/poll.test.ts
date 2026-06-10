import { describe, it, expect, vi } from 'vitest';
import { pollUntil, parseStatus, POLL_INTERVAL_MS } from '../../../src/client/alipay/poll.js';
import {
  AlipayPaymentRejectedError, AlipayPaymentTimeoutError,
} from '../../../src/client/alipay/errors.js';
import type { CliRunner, RunCliResult } from '../../../src/client/alipay/cli.js';

const ok = (lines: string[]): ReturnType<CliRunner> => Promise.resolve({ exitCode: 0, lines });

/** Let pending microtasks + the (real) zero-delay timers settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('parseStatus', () => {
  it('detects terminal success markers (anchored, not bare words)', () => {
    expect(parseStatus(['STATUS: TRADE_SUCCESS'])).toBe('paid');
    expect(parseStatus(['TRADE_FINISHED'])).toBe('paid');
  });
  it('does NOT read plain "UNPAID" as paid (bare PAID would falsely match)', () => {
    expect(parseStatus(['TRADE_STATUS_UNPAID'])).toBe('pending');
  });
  it('detects rejection markers', () => {
    expect(parseStatus(['TRADE_CLOSED'])).toBe('rejected');
    expect(parseStatus(['user CANCEL'])).toBe('rejected');
  });
  it('detects pending and defaults unknown', () => {
    expect(parseStatus(['WAIT_BUYER_PAY'])).toBe('pending');
    expect(parseStatus(['random noise'])).toBe('unknown');
  });

  // Real alipay-bot JSON envelope (verified against alipay-bot-cli 0.3.15).
  it('reads the {code} envelope: 200=paid, non-200=pending, fail-msg=rejected', () => {
    expect(parseStatus(['{"code":200,"data":{"url":"v.mp4"}}'])).toBe('paid');
    expect(parseStatus(['{"code":500,"message":"未开通"}'])).toBe('pending');
    expect(parseStatus(['{"code":400,"message":"交易已关闭"}'])).toBe('rejected');
  });

  it('reads the {success,errorCode} envelope from 402-query-payment-status', () => {
    expect(parseStatus(['{"success":true,"result":{"url":"v.mp4"}}'])).toBe('paid');
    expect(parseStatus(['{"success":false,"errorCode":"TRADE_CLOSED"}'])).toBe('rejected');
  });

  // Regression (live 1-CNY E2E): an UNPAID trade must NOT be read as paid just
  // because the literal "success" key appears with value false.
  it('treats success:false TRADE_STATUS_UNPAID as pending, NOT paid', () => {
    expect(parseStatus([
      '{"success":false,"errorCode":"TRADE_STATUS_UNPAID","errorMsg":"交易未支付"}',
    ])).toBe('pending');
  });

  // Regression (live completed trade, tradeNo …065406, 2026-06-10): alipay-bot
  // 0.3.15 returns the SETTLED status as a `{body:"<markdown>"}` report, not the
  // bare A/B envelope. The old code returned `unknown` here, so the poll never
  // terminated after a successful scan+pay. Must read as `paid`.
  it('reads the Shape-C {body} markdown report of a settled trade as paid', () => {
    const report = JSON.stringify({
      body:
        '**✓ 查询支付状态成功并获取资源**\n\n**交易号**：' + '2'.repeat(32) +
        '\n**资源响应状态**：200\n**资源响应体**：\n' +
        '{\n  "success": true,\n  "result": { "video_url": "v.mp4" }\n}',
    });
    expect(parseStatus([report])).toBe('paid');
  });

  // The same {body} envelope while still unpaid (re-fetch 402) stays pending.
  it('keeps a Shape-C report pending when the resource re-fetch is unpaid', () => {
    const report = JSON.stringify({
      body: '**查询支付状态**\n**资源响应状态**：402\n交易未支付，等待付款',
    });
    expect(parseStatus([report])).toBe('pending');
  });
});

describe('pollUntil', () => {
  it('resolves paid once the status flips, after retrying on pending (sequential)', async () => {
    const sleep = vi.fn(async () => {});
    const runner = vi.fn()
      .mockImplementationOnce(() => ok(['WAIT_BUYER_PAY']))
      .mockImplementationOnce(() => ok(['STATUS: TRADE_SUCCESS', 'BODY: {"url":"x"}']));
    const res = await pollUntil('1'.repeat(32), 'http://x/execute', {
      deadline: 1_000_000, now: () => 0, runner: runner as unknown as CliRunner, sleep,
      maxInflight: 1, launchIntervalMs: 0,
    });
    expect(res.status).toBe('paid');
    expect(runner).toHaveBeenCalledTimes(2);
    // Polls the right subcommand.
    expect(runner.mock.calls[0][0]).toEqual(
      ['402-query-payment-status', '-t', '1'.repeat(32), '-r', 'http://x/execute'],
    );
  });

  it('throws AlipayPaymentRejectedError on a rejection status', async () => {
    const runner = vi.fn(() => ok(['TRADE_CLOSED']));
    await expect(pollUntil('2'.repeat(32), 'http://x', {
      deadline: 1_000_000, now: () => 0, runner: runner as unknown as CliRunner,
      sleep: async () => {}, maxInflight: 1, launchIntervalMs: 0,
    })).rejects.toBeInstanceOf(AlipayPaymentRejectedError);
  });

  it('throws AlipayPaymentTimeoutError when the deadline has passed', async () => {
    const runner = vi.fn(() => ok(['WAIT_BUYER_PAY']));
    await expect(pollUntil('3'.repeat(32), 'http://x', {
      deadline: 100, now: () => 200, runner: runner as unknown as CliRunner, sleep: async () => {},
    })).rejects.toBeInstanceOf(AlipayPaymentTimeoutError);
    expect(runner).not.toHaveBeenCalled(); // deadline checked before polling
  });

  it('times out after enough pending polls advance the clock', async () => {
    let t = 0;
    const now = () => t;
    const sleep = vi.fn(async () => { t += POLL_INTERVAL_MS; });
    const runner = vi.fn(() => ok(['PENDING']));
    await expect(pollUntil('4'.repeat(32), 'http://x', {
      deadline: POLL_INTERVAL_MS * 3, now, runner: runner as unknown as CliRunner, sleep,
      maxInflight: 1, launchIntervalMs: POLL_INTERVAL_MS,
    })).rejects.toBeInstanceOf(AlipayPaymentTimeoutError);
    expect(runner.mock.calls.length).toBe(3);
  });

  it('rejects immediately if the caller signal is already aborted', async () => {
    const runner = vi.fn(() => ok(['PENDING']));
    await expect(pollUntil('5'.repeat(32), 'http://x', {
      deadline: 1_000_000, now: () => 0, runner: runner as unknown as CliRunner,
      sleep: async () => {}, signal: AbortSignal.abort(),
    })).rejects.toThrow(/abort/i);
    expect(runner).not.toHaveBeenCalled();
  });

  // A "gate" runner: each call parks until the test releases it, so we can
  // observe true concurrency (the real CLI blocks ~25-36s per spawn).
  function gateRunner() {
    let active = 0;
    let maxActive = 0;
    const gates: Array<(lines: string[]) => void> = [];
    const runner = vi.fn(
      () => new Promise<RunCliResult>((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        gates.push((lines) => { active -= 1; resolve({ exitCode: 0, lines }); });
      }),
    );
    return { runner, gates, peak: () => maxActive };
  }

  it('overlaps up to maxInflight concurrent polls; first "paid" wins', async () => {
    const { runner, gates, peak } = gateRunner();
    const p = pollUntil('6'.repeat(32), 'http://x', {
      deadline: 1e9, now: () => 0, runner: runner as unknown as CliRunner,
      sleep: async () => {}, maxInflight: 2, launchIntervalMs: 0,
    });
    await flush();
    // Both slots filled, capped at 2.
    expect(peak()).toBe(2);
    expect(gates.length).toBe(2);

    // First poll comes back pending → a fresh poll refills the freed slot.
    gates[0](['WAIT_BUYER_PAY']);
    await flush();
    expect(gates.length).toBe(3);
    expect(peak()).toBe(2); // never exceeded the cap

    // Third poll observes paid → the whole thing resolves (sibling left running).
    gates[2](['TRADE_SUCCESS']);
    await expect(p).resolves.toMatchObject({ status: 'paid' });
  });

  it('maxInflight:1 stays strictly sequential (never 2 concurrent spawns)', async () => {
    const { runner, gates, peak } = gateRunner();
    const p = pollUntil('7'.repeat(32), 'http://x', {
      deadline: 1e9, now: () => 0, runner: runner as unknown as CliRunner,
      sleep: async () => {}, maxInflight: 1, launchIntervalMs: 0,
    });
    await flush();
    expect(gates.length).toBe(1);
    gates[0](['PENDING']);
    await flush();
    expect(gates.length).toBe(2); // only after the first finished
    expect(peak()).toBe(1);
    gates[1](['TRADE_SUCCESS']);
    await expect(p).resolves.toMatchObject({ status: 'paid' });
  });
});
