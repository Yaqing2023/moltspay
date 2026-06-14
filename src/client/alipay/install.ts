/**
 * alipay-bot presence + version gate (design §5.2.4).
 *
 * alipay-bot is a runtime dependency of the Alipay payment rail. It is NOT on
 * npm (Alipay distributes it from their own CDN) and is licensed UNLICENSED, so
 * it can neither be a package.json dependency nor be bundled into this package.
 * Installing moltspay provisions it automatically via the @alipay/agent-payment
 * helper's `install-cli` (see scripts/postinstall.js) — the user opted into it
 * by installing this SDK, so provisioning a declared rail dependency is part of
 * that install (this supersedes the older 1.6.0 "never touch the user's machine"
 * stance for the specific case of an explicitly-installed rail dependency).
 *
 * This gate is the runtime safety net for when that provisioning did not run or
 * finish (`npm install --ignore-scripts`, or offline at install time): we fail
 * with a clear, actionable error telling the user the one command to run.
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

/** Run the gate once, no caching (the original logic). */
async function ensureCliUncached(getVersion: VersionGetter): Promise<string> {
  let stdout: string;
  try {
    stdout = await getVersion();
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      throw new AlipayCliNotFoundError(
        'alipay-bot not installed. Run: npx -y @alipay/agent-payment install-cli',
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

// Process-level memo for the real-CLI path. The installed alipay-bot version is
// immutable for a process's lifetime, yet `pay402` re-runs the gate on EVERY
// payment — and spawning `alipay-bot --version` measured ~3.8s each (a pure-
// overhead cold start). Cache the first SUCCESS so subsequent payments skip the
// spawn entirely. We never cache failures (a transient/ENOENT stays retryable),
// and only cache the DEFAULT getter so injected (test/DI) getters run uncached.
let cachedVersion: string | null = null;
let inflight: Promise<string> | null = null;

/** Clear the cached version gate (tests / after a CLI upgrade). */
export function resetCliVersionCache(): void {
  cachedVersion = null;
  inflight = null;
}

/**
 * Ensure alipay-bot is installed and new enough. Throws:
 *   - AlipayCliNotFoundError if the binary is missing (ENOENT)
 *   - AlipayCliVersionError  if older than {@link MIN_CLI_VERSION}
 *
 * Memoized per process for the default getter: only the first call spawns
 * `alipay-bot --version`; later calls return the cached version immediately.
 * Concurrent first calls share a single in-flight spawn.
 */
export async function ensureCli(getVersion: VersionGetter = defaultGetVersion): Promise<string> {
  // Injected getters (tests/DI) bypass the cache so each call observes the fake.
  if (getVersion !== defaultGetVersion) {
    return ensureCliUncached(getVersion);
  }
  if (cachedVersion) return cachedVersion;
  if (!inflight) {
    inflight = ensureCliUncached(getVersion)
      .then((v) => {
        cachedVersion = v;
        return v;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
