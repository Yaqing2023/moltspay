/**
 * Payment-status poller (design §5.2.3 Step 5).
 *
 * Wraps the user's long-tail "open Alipay, scan, confirm" behavior into a
 * single awaitable that resolves with a terminal PaymentResult — aligning the
 * Alipay rail to the EVM "await settle" semantics so callers need no special
 * code. Polls `alipay-bot 402-query-payment-status` every 3s until paid,
 * rejected, the `pay_before` deadline elapses, or the AbortSignal fires.
 */

import type { CliRunner } from './cli.js';
import { runCli } from './cli.js';
import { AlipayPaymentRejectedError, AlipayPaymentTimeoutError } from './errors.js';

export const POLL_INTERVAL_MS = 3_000;

export type PaymentStatus = 'paid' | 'rejected' | 'pending' | 'unknown';

/**
 * Classify a status poll's output lines.
 *
 * alipay-bot emits JSON `{code, message, reason}` (observed on 0.3.15): code
 * 200 = resource delivered (paid); a non-200 code with a "waiting"-style
 * message is still pending; an explicit close/fail/reject message is terminal.
 * Falls back to textual markers for non-JSON output. Defaults to 'pending' for
 * a non-200/unknown poll so a not-yet-terminal status keeps waiting.
 */
export function parseStatus(lines: string[]): PaymentStatus {
  const raw = lines.join('\n').trim();
  try {
    const json = JSON.parse(raw);
    if (json && typeof json.code !== 'undefined') {
      if (Number(json.code) === 200) return 'paid';
      const msg = `${json.message ?? ''}${json.reason ?? ''}`;
      if (/关闭|失败|拒绝|取消|超时|已撤销/.test(msg)) return 'rejected';
      return 'pending'; // non-200, not explicitly terminal → keep polling
    }
  } catch {
    // Not JSON — fall through to textual markers.
  }
  const text = raw.toUpperCase();
  if (/\b(TRADE_SUCCESS|TRADE_FINISHED|SUCCESS|PAID|FULFILL)\b/.test(text)) return 'paid';
  if (/\b(TRADE_CLOSED|REJECTED|CANCEL|REFUSE|FAIL)\b/.test(text)) return 'rejected';
  if (/\b(WAIT_BUYER_PAY|PENDING|WAITING)\b/.test(text)) return 'pending';
  return 'unknown';
}

export interface PollOptions {
  /** Hard deadline (epoch ms) from the challenge's `pay_before`. */
  deadline: number;
  /** Abort the poll loop (e.g. caller cancellation). */
  signal?: AbortSignal;
  /** Forward each status-poll line to the user. */
  onLine?: (line: string) => void;
  /** Injectable CLI runner (default: real spawn). */
  runner?: CliRunner;
  /** Injectable sleep (default: real timer that also rejects on abort). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable clock (default: Date.now). */
  now?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export interface PollResult {
  status: 'paid';
  /** All lines from the final (paid) status poll, for body extraction. */
  lines: string[];
}

/**
 * Poll until the payment reaches a terminal state.
 * @throws AlipayPaymentRejectedError if the buyer/Alipay rejects the charge.
 * @throws AlipayPaymentTimeoutError  if `deadline` elapses while still pending.
 */
export async function pollUntil(
  tradeNo: string,
  resourceUrl: string,
  opts: PollOptions,
): Promise<PollResult> {
  const runner = opts.runner ?? runCli;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  for (;;) {
    if (now() >= opts.deadline) {
      throw new AlipayPaymentTimeoutError(
        `Payment ${tradeNo} not completed before pay_before deadline`,
      );
    }

    const { lines } = await runner(
      ['402-query-payment-status', '-t', tradeNo, '-r', resourceUrl],
      { onLine: opts.onLine, signal: opts.signal },
    );
    const status = parseStatus(lines);
    if (status === 'paid') return { status: 'paid', lines };
    if (status === 'rejected') {
      throw new AlipayPaymentRejectedError(`Payment ${tradeNo} was rejected`);
    }

    // pending / unknown → wait and retry (sleep rejects if aborted).
    await sleep(POLL_INTERVAL_MS, opts.signal);
  }
}
