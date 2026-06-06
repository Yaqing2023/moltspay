/**
 * alipay-bot shell-out (design §5.2.4).
 *
 * Hard constraints from the Alipay skill guide, implemented here so they hold
 * regardless of CLI version:
 *
 *   - **spawn, never exec** — the skill guide requires CLI output be forwarded
 *     to the user verbatim, line by line, with no wrapping/truncation. Only a
 *     streaming stdout API can do that, and `paymentUrl` carries a crypto
 *     signature that any truncation would invalidate.
 *   - **env whitelist** — only the AIPAY_* channel vars + a minimal survival
 *     set (PATH/HOME) are passed through; nothing else leaks into the child.
 */

import { spawn } from 'child_process';
import { alipayLog } from './log.js';

/** The only env vars allowed through to alipay-bot (skill guide §7). */
export const ALLOWED_ENV = new Set([
  'AIPAY_OUTPUT_CHANNEL',
  'AIPAY_SESSION_ID',
  'AIPAY_FRAMEWORK',
  'AIPAY_MODEL',
  'AIPAY_OS',
  // Minimal survival set for spawn to find the binary and a home dir.
  'PATH',
  'HOME',
]);

/** Project the environment down to the whitelist. */
export function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => ALLOWED_ENV.has(k)),
  ) as NodeJS.ProcessEnv;
}

export interface RunCliOptions {
  /** Called for every line of stdout/stderr, verbatim, in arrival order. */
  onLine?: (line: string) => void;
  /** Abort the run (sends SIGTERM to the child). */
  signal?: AbortSignal;
  /** Override the binary (default 'alipay-bot'); used by tests. */
  bin?: string;
  /** Extra env to merge on top of the whitelisted process env. */
  env?: NodeJS.ProcessEnv;
  /** Log label for this spawn (defaults to the first CLI arg / subcommand). */
  step?: string;
  /** Correlation id grouping this spawn with the rest of its payment flow. */
  flow?: string;
}

export interface RunCliResult {
  exitCode: number;
  /** Every stdout+stderr line, in arrival order (for parsing). */
  lines: string[];
}

/** Split a chunk into complete lines, keeping a remainder buffer per stream. */
function makeLineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buf = '';
  return (chunk: Buffer) => {
    buf += chunk.toString('utf-8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      onLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  };
}

/** The runCli signature, so higher modules can inject a fake in tests. */
export type CliRunner = (args: string[], opts?: RunCliOptions) => Promise<RunCliResult>;

/**
 * Spawn alipay-bot with the given args, forwarding every output line verbatim
 * and collecting them for the caller to parse. Resolves with the exit code.
 */
export const runCli: CliRunner = (args, opts = {}) => {
  const bin = opts.bin ?? 'alipay-bot';
  const step = opts.step ?? args[0] ?? '(no-arg)';
  const startedAt = Date.now();
  const lines: string[] = [];
  const collect = (line: string) => {
    lines.push(line);
    // Per-line timeline: offset (ms since spawn) + a short preview. At debug
    // level this cracks open an otherwise opaque spawn (e.g. 402-buyer-pay's
    // ~40s) into its progress timeline, revealing whether the time is one long
    // wait or many round-trips — without touching the real-charge call itself.
    alipayLog.debug('cli.line', {
      flow: opts.flow, step, ms: Date.now() - startedAt, preview: line.slice(0, 120),
    });
    opts.onLine?.(line);
  };

  alipayLog.debug('step.start', { flow: opts.flow, step });

  return new Promise<RunCliResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...filterEnv(process.env), ...(opts.env ?? {}) },
    });

    if (opts.signal) {
      if (opts.signal.aborted) child.kill('SIGTERM');
      opts.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    }

    // Raw chunk timeline (debug): catches output that never produces a newline
    // — spinners using '\r', or a CLI that buffers then flushes — which the
    // line splitter alone would miss. The first chunk's offset ≈ time-to-first
    // -byte (cold start + first round-trip); gaps between chunks = real waits.
    let sawByte = false;
    const onChunk = (stream: 'out' | 'err') => (chunk: Buffer) => {
      const ms = Date.now() - startedAt;
      if (!sawByte) {
        sawByte = true;
        alipayLog.debug('cli.firstbyte', { flow: opts.flow, step, ms });
      }
      alipayLog.debug('cli.chunk', { flow: opts.flow, step, ms, stream, bytes: chunk.length });
    };

    const onStdout = makeLineSplitter(collect);
    const onStderr = makeLineSplitter(collect);
    child.stdout?.on('data', onChunk('out'));
    child.stderr?.on('data', onChunk('err'));
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    child.on('error', (err) => {
      alipayLog.info('cli.exit', {
        flow: opts.flow, step, ms: Date.now() - startedAt, ok: false, err: err.message,
      });
      reject(err);
    });
    child.on('close', (code) => {
      alipayLog.info('cli.exit', {
        flow: opts.flow, step, ms: Date.now() - startedAt, ok: (code ?? 1) === 0, code: code ?? 1,
      });
      resolve({ exitCode: code ?? 1, lines });
    });
  });
};
