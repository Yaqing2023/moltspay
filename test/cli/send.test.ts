/**
 * Regression for the `moltspay send` command's argument validation.
 *
 * Runs the CLI from source via tsx with `--json` and asserts the structured
 * error for each bad-input branch. These paths are pure validation (chain /
 * token / amount / address / wallet presence) and never touch the network or
 * broadcast a transaction. The successful-transfer path needs a live/mocked
 * chain and is covered by manual/testnet verification (see
 * docs/SEND-COMMAND-DESIGN.md).
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'src/cli/index.ts');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');
const DEAD = '0x000000000000000000000000000000000000dEaD';

/** Run `moltspay send ...` from source; return parsed JSON output. */
async function send(args: string[]): Promise<any> {
  try {
    const { stdout } = await execFileP(TSX, [CLI, 'send', ...args, '--json'], { timeout: 30_000 });
    return JSON.parse(stdout.trim().split('\n').pop() as string);
  } catch (e: any) {
    // Non-zero exit still prints the JSON error on stdout.
    const out = (e.stdout || '').trim().split('\n').pop();
    return out ? JSON.parse(out) : { success: false, error: e.message };
  }
}

describe('moltspay send -- argument validation', () => {
  it('rejects a malformed destination address', async () => {
    const r = await send(['0xNOTANADDR', '5']);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Invalid destination address/);
  });

  it('rejects a non-USDC/USDT token', async () => {
    const r = await send([DEAD, '5', '--token', 'ETH']);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/USDC or USDT/);
  });

  it('rejects a non-numeric amount', async () => {
    const r = await send([DEAD, 'abc']);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Invalid amount/);
  });

  it('rejects a zero amount', async () => {
    const r = await send([DEAD, '0']);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Invalid amount/);
  });

  it('rejects an unknown chain', async () => {
    const r = await send([DEAD, '5', '--chain', 'fantom']);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Unknown chain/);
  });

  it('rejects a Solana chain (not supported yet)', async () => {
    const r = await send([DEAD, '5', '--chain', 'solana']);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Solana send is not supported/);
  });

  it('fails when the wallet is not initialized', async () => {
    const r = await send([DEAD, '5', '--config-dir', '/tmp/moltspay-does-not-exist-xyz']);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Wallet not initialized/);
  });
});
