#!/usr/bin/env node

/**
 * MoltsPay MCP Server — stdio entrypoint.
 *
 * Usage:
 *   moltspay-mcp                           # Connect over stdio
 *   moltspay-mcp --dry-run                 # moltspay_pay previews only, never signs
 *   moltspay-mcp --config-dir /path/to/dir # Override ~/.moltspay location
 *
 * Wallet must exist at ~/.moltspay/wallet.json. Create one with `moltspay init`.
 */

import { webcrypto } from 'crypto';
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMoltsPayMcpServer } from './server.js';

function parseArgs(argv: string[]): { dryRun: boolean; configDir?: string } {
  const args = argv.slice(2);
  let dryRun = false;
  let configDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--config-dir') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--config-dir requires a path argument');
      }
      configDir = next;
      i++;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  return { dryRun, configDir };
}

async function main(): Promise<void> {
  const { dryRun, configDir } = parseArgs(process.argv);

  const server = createMoltsPayMcpServer({ dryRun, configDir });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr only — stdout carries the JSON-RPC stream.
  process.stderr.write(`moltspay-mcp ready${dryRun ? ' (dry-run)' : ''}\n`);
}

main().catch((e) => {
  process.stderr.write(
    `moltspay-mcp failed to start: ${e instanceof Error ? e.message : String(e)}\n`
  );
  process.exit(1);
});
