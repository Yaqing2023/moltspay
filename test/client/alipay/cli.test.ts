import { describe, it, expect } from 'vitest';
import { filterEnv, runCli, ALLOWED_ENV } from '../../../src/client/alipay/cli.js';

describe('filterEnv', () => {
  it('keeps only the whitelisted vars', () => {
    const out = filterEnv({
      PATH: '/bin', HOME: '/home/x', AIPAY_MODEL: 'claude', AIPAY_SESSION_ID: 's1',
      SECRET: 'leak', AWS_KEY: 'leak', npm_token: 'leak',
    } as any);
    expect(out).toEqual({
      PATH: '/bin', HOME: '/home/x', AIPAY_MODEL: 'claude', AIPAY_SESSION_ID: 's1',
    });
  });

  it('whitelist is exactly the AIPAY_* channel vars + PATH/HOME', () => {
    expect([...ALLOWED_ENV].sort()).toEqual([
      'AIPAY_FRAMEWORK', 'AIPAY_MODEL', 'AIPAY_OS', 'AIPAY_OUTPUT_CHANNEL',
      'AIPAY_SESSION_ID', 'HOME', 'PATH',
    ]);
  });
});

describe('runCli', () => {
  it('forwards every stdout/stderr line verbatim and collects them', async () => {
    const seen: string[] = [];
    const { exitCode, lines } = await runCli(
      ['-e', 'process.stdout.write("line1\\nline2\\n"); process.stderr.write("err1\\n")'],
      { bin: 'node', onLine: (l) => seen.push(l) },
    );
    expect(exitCode).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(['line1', 'line2', 'err1']));
    expect(seen).toEqual(lines); // onLine saw exactly what was collected
  });

  it('reports a non-zero exit code', async () => {
    const { exitCode } = await runCli(['-e', 'process.exit(3)'], { bin: 'node' });
    expect(exitCode).toBe(3);
  });

  it('kills the child when the AbortSignal fires', async () => {
    const ac = new AbortController();
    const p = runCli(['-e', 'setTimeout(() => {}, 100000)'], { bin: 'node', signal: ac.signal });
    ac.abort();
    const { exitCode } = await p;
    expect(exitCode).not.toBe(0); // terminated by signal
  });
});
