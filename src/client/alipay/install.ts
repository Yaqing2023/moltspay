/**
 * alipay-bot presence + version gate (design §5.2.4).
 *
 * We never auto-`npm install` — that mutates the user's environment, which
 * the 1.6.0 "don't silently change the user's machine" principle forbids.
 * Instead we fail with a clear, actionable error and let the user opt in.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { AlipayCliNotFoundError, AlipayCliVersionError } from './errors.js';

const execFileAsync = promisify(execFile);

/** Minimum alipay-bot version with the 402-buyer-* subcommands this client drives. */
export const MIN_CLI_VERSION = '0.3.15';

/** Compare two `major.minor.patch` strings. Returns true iff a < b. */
export function semverLt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Pull a `x.y.z` out of an `alipay-bot --version` line (handles a leading `v`). */
export function parseVersion(stdout: string): string | null {
  return stdout.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

/** Injectable for tests: returns the raw `alipay-bot --version` stdout. */
export type VersionGetter = () => Promise<string>;

const defaultGetVersion: VersionGetter = async () => {
  const { stdout } = await execFileAsync('alipay-bot', ['--version']);
  return stdout;
};

/**
 * Ensure alipay-bot is installed and new enough. Throws:
 *   - AlipayCliNotFoundError if the binary is missing (ENOENT)
 *   - AlipayCliVersionError  if older than {@link MIN_CLI_VERSION}
 */
export async function ensureCli(getVersion: VersionGetter = defaultGetVersion): Promise<string> {
  let stdout: string;
  try {
    stdout = await getVersion();
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      throw new AlipayCliNotFoundError(
        'alipay-bot not installed. Run: ' +
          'npm install @alipay/agent-payment@1.0.9 && ' +
          'npx @alipay/agent-payment@1.0.9 install-cli',
      );
    }
    throw e;
  }

  const version = parseVersion(stdout);
  if (!version || semverLt(version, MIN_CLI_VERSION)) {
    throw new AlipayCliVersionError(
      `alipay-bot ${version ?? '?'} found, need ≥ ${MIN_CLI_VERSION}. ` +
        'Run: npx -y @alipay/agent-payment@latest update',
    );
  }
  return version;
}
