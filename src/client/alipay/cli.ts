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
  const lines: string[] = [];
  const collect = (line: string) => {
    lines.push(line);
    opts.onLine?.(line);
  };

  return new Promise<RunCliResult>((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...filterEnv(process.env), ...(opts.env ?? {}) },
    });

    if (opts.signal) {
      if (opts.signal.aborted) child.kill('SIGTERM');
      opts.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    }

    const onStdout = makeLineSplitter(collect);
    const onStderr = makeLineSplitter(collect);
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);

    child.on('error', reject);
    child.on('close', (code) => resolve({ exitCode: code ?? 1, lines }));
  });
};
