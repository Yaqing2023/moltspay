/**
 * Alipay rail log management (design §5.2 observability).
 *
 * The Alipay rail's latency lives in a chain of `alipay-bot` subprocess spawns
 * and gateway round-trips that, in production, are invisible: the only output is
 * the verbatim CLI passthrough the skill guide mandates on stdout. This module
 * adds a structured, opt-in log channel so every node of the `pay402` state
 * machine — and how long it took — can be observed and routed into the host
 * app's log pipeline, WITHOUT changing default behavior or polluting stdout.
 *
 * Usage (host app):
 *   import { setAlipayLogLevel, setAlipayLogSink } from 'moltspay';
 *   setAlipayLogLevel('info');                       // or env MOLTSPAY_ALIPAY_LOG=info
 *   setAlipayLogSink((line) => myLogger.info(line));  // default: process.stderr
 *
 * Levels: 'off' (default) < 'info' (node timings + flow totals) < 'debug'
 * (adds per-spawn start/exit and per-poll ticks). The level is read from
 * MOLTSPAY_ALIPAY_LOG at load and can be overridden at runtime.
 */

export type AlipayLogLevel = 'off' | 'info' | 'debug';

/** A single structured log record. The sink receives both the line and this. */
export interface AlipayLogEvent {
  /** ISO-8601 timestamp. */
  ts: string;
  level: 'info' | 'debug';
  /** Event name: flow.start | flow.pending | flow.settled | flow.failed |
   *  step.start | step.end | cli.exit | poll.tick. */
  event: string;
  /** Correlation id grouping all lines of one payment flow (session/tradeNo). */
  flow?: string;
  /** Node/step name, e.g. 'ensure-cli', 'payment-intent', '402-buyer-pay'. */
  step?: string;
  /** Elapsed milliseconds (on *.end / *.exit / flow.* total events). */
  ms?: number;
  [k: string]: unknown;
}

export type AlipayLogSink = (line: string, event: AlipayLogEvent) => void;

const RANK: Record<AlipayLogLevel, number> = { off: 0, info: 1, debug: 2 };

function normalizeLevel(v: string | undefined): AlipayLogLevel {
  const s = (v ?? '').toLowerCase();
  return s === 'info' || s === 'debug' ? s : 'off';
}

let level: AlipayLogLevel = normalizeLevel(process.env.MOLTSPAY_ALIPAY_LOG);

// Default sink: stderr, so structured logs never corrupt the verbatim CLI
// stdout stream the skill guide requires.
let sink: AlipayLogSink = (line) => {
  process.stderr.write(line + '\n');
};

/** Set the verbosity at runtime (overrides the MOLTSPAY_ALIPAY_LOG env). */
export function setAlipayLogLevel(next: AlipayLogLevel): void {
  level = next;
}

/** Current effective level. */
export function getAlipayLogLevel(): AlipayLogLevel {
  return level;
}

/** Route alipay log lines anywhere (host log pipeline, file, collector, …). */
export function setAlipayLogSink(fn: AlipayLogSink): void {
  sink = fn;
}

function enabledFor(want: 'info' | 'debug'): boolean {
  return RANK[level] >= RANK[want];
}

function render(event: string, fields: Record<string, unknown>): string {
  const parts = ['[moltspay:alipay]', String(fields.ts), event];
  if (fields.flow) parts.push(`flow=${fields.flow}`);
  if (fields.step) parts.push(`step=${fields.step}`);
  if (typeof fields.ms === 'number') parts.push(`${fields.ms}ms`);
  for (const [k, v] of Object.entries(fields)) {
    // ts/level/event are already in the prefix; flow/step/ms rendered above.
    if (['ts', 'level', 'event', 'flow', 'step', 'ms'].includes(k)) continue;
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.join(' ');
}

function emit(lvl: 'info' | 'debug', event: string, fields: Record<string, unknown>): void {
  if (!enabledFor(lvl)) return;
  const full: AlipayLogEvent = { ts: new Date().toISOString(), level: lvl, event, ...fields };
  try {
    sink(render(event, full), full);
  } catch {
    // A broken sink must never break a payment.
  }
}

export const alipayLog = {
  info: (event: string, fields: Record<string, unknown> = {}): void => emit('info', event, fields),
  debug: (event: string, fields: Record<string, unknown> = {}): void => emit('debug', event, fields),
  /** True if anything at all would be logged (cheap guard for hot paths). */
  enabled: (): boolean => level !== 'off',
};

/**
 * Time one async node of the flow: logs `step.start` (debug) then `step.end`
 * (info) with elapsed ms and ok/err, and re-throws on failure. Returns fn's
 * value unchanged, so it wraps a call transparently:
 *
 *   await timeStep('ensure-cli', flow, () => ensureCli(getVersion));
 */
export async function timeStep<T>(
  step: string,
  flow: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!alipayLog.enabled()) return fn();
  const t0 = Date.now();
  alipayLog.debug('step.start', { flow, step });
  try {
    const out = await fn();
    alipayLog.info('step.end', { flow, step, ms: Date.now() - t0, ok: true });
    return out;
  } catch (err) {
    alipayLog.info('step.end', {
      flow,
      step,
      ms: Date.now() - t0,
      ok: false,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
