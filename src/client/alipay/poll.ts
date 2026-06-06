/**
 * Payment-status poller (design §5.2.3 Step 5).
 *
 * Wraps the user's long-tail "open Alipay, scan, confirm" behavior into a
 * single awaitable that resolves with a terminal PaymentResult — aligning the
 * Alipay rail to the EVM "await settle" semantics so callers need no special
 * code. Polls `alipay-bot 402-query-payment-status` until paid, rejected, the
 * `pay_before` deadline elapses, or the AbortSignal fires.
 *
 * OVERLAPPING POLLS (latency optimization, Rec #3): each
 * `402-query-payment-status` spawn is itself a SINGLE long blocking call —
 * measured ~25–36s (CLI cold start + one gateway snapshot query; first-byte ≈
 * total, NOT a server-side long-poll). A naive "spawn → await full → wait →
 * spawn" loop therefore detects a payment up to ~(spawn + gap + spawn) ≈ 50–60s
 * after the buyer actually pays. We can't shrink a single spawn from Node, but
 * we CAN launch the next poll on a fixed cadence WITHOUT waiting for the prior
 * one to finish, capped at {@link POLL_MAX_INFLIGHT} concurrent in-flight polls.
 * The first poll to observe "paid" wins. This bounds the post-payment detection
 * lag to roughly (launch cadence + one spawn) instead of (two spawns + gap).
 *
 * SAFETY: this issues concurrent `402-query-payment-status` calls, each of which
 * re-requests the resource (POST `/execute`) — and `/execute` DOES drive Alipay
 * fulfillment confirmation, it is not a no-op. Concurrency is nonetheless safe
 * because (a) Alipay fulfillment is IDEMPOTENT: the buyer already paid, so no
 * concurrent call double-charges, and the first `/execute` to reach the gateway
 * fulfills (`status:"fulfilled"`) while any concurrent sibling is rejected with
 * `40004 交易状态不允许履约` ("trade state does not allow fulfillment") — observed
 * live 2026-06-06, flow …048039. A 40004 sibling parses to `unknown` (NOT
 * `rejected`), so a loser never terminates the poll falsely. (b) Actual delivery
 * (e.g. the Discord role) is decoupled into the seller's single `onPaid`, fired
 * ONCE when this function resolves — never per-poll. So repeated/concurrent calls
 * neither double-charge nor double-deliver. Set concurrency to 1 to restore
 * strict sequential polling.
 */

import type { CliRunner } from './cli.js';
import { runCli } from './cli.js';
import { AlipayPaymentRejectedError, AlipayPaymentTimeoutError } from './errors.js';
import { alipayLog } from './log.js';

/** Minimum gap (ms) between successive poll LAUNCHES (the cadence floor). */
export const POLL_INTERVAL_MS = 3_000;

/** Default max concurrent in-flight status polls (1 = strict sequential). */
export const POLL_MAX_INFLIGHT = 2;

/** Resolve max in-flight polls: opts > env > default. `1` disables overlap. */
function resolveMaxInflight(override?: number): number {
  if (override !== undefined) return Math.max(1, Math.floor(override));
  const raw = process.env.MOLTSPAY_ALIPAY_POLL_MAX_INFLIGHT;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return POLL_MAX_INFLIGHT;
}

/** Resolve the launch-cadence gap (ms): opts > env > default. */
function resolveLaunchGap(override?: number): number {
  if (override !== undefined) return Math.max(0, override);
  const raw = process.env.MOLTSPAY_ALIPAY_POLL_LAUNCH_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return POLL_INTERVAL_MS;
}

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
  // alipay-bot 0.3.15's `402-query-payment-status` renders a human markdown
  // report (not the bare JSON envelope), so JSON.parse above misses. When the
  // payment is settled the report embeds the re-fetched resource, whose body
  // carries our server's `"payment": { "status": "fulfilled" }`. That marker is
  // anchored + quoted and only appears after the facilitator verified the
  // payment, so it's a safe "paid" signal (unlike a bare "SUCCESS").
  if (/TRADE_SUCCESS|TRADE_FINISHED|"STATUS":\s*"FULFILLED"/.test(text)) return 'paid';
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
  /**
   * HTTP method + body for the resource re-fetch, mirrored from the buyer-pay
   * step. Required so `402-query-payment-status` re-requests the resource the
   * SAME way it was paid (POST + body). Without these it defaults to GET, which
   * 404s against a POST-only `/execute` and leaves the trade undetectable as paid.
   */
  method?: string;
  data?: string;
  /**
   * Max concurrent in-flight status polls. Overrides
   * `MOLTSPAY_ALIPAY_POLL_MAX_INFLIGHT` / {@link POLL_MAX_INFLIGHT}. `1` =
   * strict sequential (legacy behavior).
   */
  maxInflight?: number;
  /**
   * Minimum gap (ms) between successive poll launches. Overrides
   * `MOLTSPAY_ALIPAY_POLL_LAUNCH_MS` / {@link POLL_INTERVAL_MS}.
   */
  launchIntervalMs?: number;
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

type TickResult = { status: PaymentStatus; lines: string[] };

/** Sentinel raced against in-flight polls to signal "cadence elapsed, launch". */
const LAUNCH = Symbol('launch');

/**
 * Poll until the payment reaches a terminal state. Launches up to `maxInflight`
 * overlapping `402-query-payment-status` spawns on a fixed launch cadence; the
 * first to observe "paid" wins (see the module header for why and why it's safe).
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
  const maxInflight = resolveMaxInflight(opts.maxInflight);
  const launchGap = resolveLaunchGap(opts.launchIntervalMs);
  const args = [
    '402-query-payment-status', '-t', tradeNo, '-r', resourceUrl,
    ...(opts.method ? ['-m', opts.method] : []),
    ...(opts.data ? ['-d', opts.data] : []),
  ];

  // Internal abort cancels leftover sibling polls the moment we settle (so a
  // "paid" result stops the other in-flight spawns instead of letting them burn
  // a full gateway round-trip). Merged with the caller's signal so either source
  // tears the whole loop down.
  const internal = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, internal.signal]) : internal.signal;

  let tick = 0;
  let lastLaunch = -Infinity;
  const inflight = new Set<Promise<TickResult>>();

  const launch = (): void => {
    tick += 1;
    const myTick = tick;
    lastLaunch = now();
    const run = (async (): Promise<TickResult> => {
      const { lines } = await runner(args, {
        onLine: opts.onLine, signal, step: 'query-payment-status', flow: tradeNo,
      });
      const status = parseStatus(lines);
      alipayLog.debug('poll.tick', { flow: tradeNo, tick: myTick, status });
      return { status, lines };
    })();
    // Track the .finally-wrapped promise so a settled poll frees its slot
    // before we race again. The value passes through unchanged.
    const tracked: Promise<TickResult> = run.finally(() => { inflight.delete(tracked); });
    inflight.add(tracked);
  };

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new Error('aborted');
      const expired = now() >= opts.deadline;
      // Timeout only once nothing is still in flight — an already-launched poll
      // may yet return "paid" just past the deadline (matches the legacy loop,
      // which checked the deadline only before each spawn).
      if (expired && inflight.size === 0) {
        throw new AlipayPaymentTimeoutError(
          `Payment ${tradeNo} not completed before pay_before deadline`,
        );
      }

      // Fill open slots while the cadence allows (and we're not past deadline).
      while (!expired && inflight.size < maxInflight && now() - lastLaunch >= launchGap) {
        launch();
      }

      const waiters: Array<Promise<TickResult | typeof LAUNCH>> = [...inflight];
      if (!expired && inflight.size < maxInflight) {
        // Wait out the remaining cadence gap, then loop back to launch.
        const untilNext = Math.max(0, launchGap - (now() - lastLaunch));
        // On abort the launch timer rejects; resolve it to LAUNCH instead so an
        // abandoned timer (the poll won this race) never becomes an unhandled
        // rejection. Real aborts still propagate via the in-flight runner / the
        // signal.aborted check at the top of the loop.
        waiters.push(sleep(untilNext, signal).then(() => LAUNCH, () => LAUNCH));
      }

      // waiters is non-empty: either something is in flight, or we just queued a
      // launch timer. (If expired with nothing in flight we returned above.)
      const winner = await Promise.race(waiters);
      if (winner === LAUNCH) continue;
      if (winner.status === 'paid') return { status: 'paid', lines: winner.lines };
      if (winner.status === 'rejected') {
        throw new AlipayPaymentRejectedError(`Payment ${tradeNo} was rejected`);
      }
      // pending / unknown → the slot is freed; loop to relaunch.
    }
  } finally {
    // Cancel any siblings still running, and swallow their resulting rejections
    // so an aborted spawn never surfaces as an unhandled promise rejection.
    internal.abort();
    for (const p of inflight) p.catch(() => undefined);
  }
}
