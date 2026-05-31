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
 * alipay-bot 402-query-payment-status emits a JSON envelope. Two observed
 * shapes (verified live against 0.3.15):
 *   - `{success: boolean, errorCode, errorMsg}` — success:false +
 *     errorCode TRADE_STATUS_UNPAID is STILL PENDING (the buyer hasn't paid
 *     yet); success:true means the resource was delivered.
 *   - `{code, message, reason}` — code 200 = delivered.
 *
 * NOTE: we must NOT text-match bare words like "SUCCESS"/"PAID" — the literal
 * JSON key `"success"` appears even when `success:false` (TRADE_STATUS_UNPAID),
 * which a naive regex misread as paid and returned an unpaid trade as success
 * (caught by the live 1-CNY E2E). So classify off the parsed fields only, and
 * fall back to anchored status tokens for non-JSON output.
 */
export function parseStatus(lines: string[]): PaymentStatus {
  const raw = lines.join('\n').trim();
  try {
    const json = JSON.parse(raw);
    if (json && typeof json === 'object') {
      // Shape A: {success, errorCode, errorMsg}
      if (typeof json.success === 'boolean') {
        if (json.success) return 'paid';
        const err = String(json.errorCode ?? '').toUpperCase();
        if (/UNPAID|WAIT|PENDING|PROCESS|NOTPAY/.test(err)) return 'pending';
        if (/CLOSED|CANCEL|FAIL|REJECT|REFUSE|TIMEOUT|EXPIRE/.test(err)) return 'rejected';
        return 'pending'; // non-terminal error → keep waiting
      }
      // Shape B: {code, message, reason}
      if (typeof json.code !== 'undefined') {
        if (Number(json.code) === 200) return 'paid';
        const msg = `${json.message ?? ''}${json.reason ?? ''}`;
        if (/关闭|失败|拒绝|取消|超时|已撤销/.test(msg)) return 'rejected';
        return 'pending';
      }
    }
  } catch {
    // Not JSON — fall through to anchored textual markers.
  }
  const text = raw.toUpperCase();
  if (/TRADE_SUCCESS|TRADE_FINISHED/.test(text)) return 'paid';
  if (/TRADE_CLOSED|REJECTED|REFUSE|CANCEL/.test(text)) return 'rejected';
  if (/WAIT_BUYER_PAY|UNPAID|PENDING|WAITING/.test(text)) return 'pending';
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
