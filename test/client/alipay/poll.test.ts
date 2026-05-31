import { describe, it, expect, vi } from 'vitest';
import { pollUntil, parseStatus, POLL_INTERVAL_MS } from '../../../src/client/alipay/poll.js';
import {
  AlipayPaymentRejectedError, AlipayPaymentTimeoutError,
} from '../../../src/client/alipay/errors.js';
import type { CliRunner } from '../../../src/client/alipay/cli.js';

const ok = (lines: string[]): ReturnType<CliRunner> => Promise.resolve({ exitCode: 0, lines });

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
});

describe('pollUntil', () => {
  it('resolves paid once the status flips, after retrying on pending', async () => {
    const sleep = vi.fn(async () => {});
    const runner = vi.fn()
      .mockImplementationOnce(() => ok(['WAIT_BUYER_PAY']))
      .mockImplementationOnce(() => ok(['STATUS: TRADE_SUCCESS', 'BODY: {"url":"x"}']));
    const res = await pollUntil('1'.repeat(32), 'http://x/execute', {
      deadline: 1_000_000, now: () => 0, runner: runner as unknown as CliRunner, sleep,
    });
    expect(res.status).toBe('paid');
    expect(runner).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(POLL_INTERVAL_MS, undefined);
    // Polls the right subcommand.
    expect(runner.mock.calls[0][0]).toEqual(
      ['402-query-payment-status', '-t', '1'.repeat(32), '-r', 'http://x/execute'],
    );
  });

  it('throws AlipayPaymentRejectedError on a rejection status', async () => {
    const runner = vi.fn(() => ok(['TRADE_CLOSED']));
    await expect(pollUntil('2'.repeat(32), 'http://x', {
      deadline: 1_000_000, now: () => 0, runner: runner as unknown as CliRunner, sleep: async () => {},
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
    })).rejects.toBeInstanceOf(AlipayPaymentTimeoutError);
    expect(runner.mock.calls.length).toBe(3);
  });
});
