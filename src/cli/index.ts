#!/usr/bin/env node

/**
 * MoltsPay CLI — entrypoint.
 *
 * Command groups live under ./commands/*; shared helpers under ./shared.ts.
 * This file only wires the program together and parses argv.
 */

// Polyfill crypto for Node.js 18
import { webcrypto } from 'crypto';
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

// Fiat-gateway IPv4 pinning. The fiat gateways (WeChat v3
// api.mch.weixin.qq.com, Alipay openapi.alipay.com) resolve AAAA-first; on a
// host whose IPv6 egress is a black hole, undici's fetch has no Happy-Eyeballs
// fallback and hangs (ETIMEDOUT) — net.setDefaultAutoSelectFamily does not
// reliably recover a no-RST IPv6 black hole. Pin DNS resolution to IPv4 for
// ONLY these gateway hostnames; all other traffic (crypto RPCs, CDP, Solana)
// keeps default dual-stack resolution. Harmless on IPv6-healthy hosts (the
// gateways have A records). Must run before any fetch().
import dns from 'dns';
const FIAT_IPV4_ONLY_HOSTS = new Set([
  'api.mch.weixin.qq.com',
  'openapi.alipay.com',
]);
const __realLookup = dns.lookup.bind(dns);
(dns as unknown as { lookup: typeof dns.lookup }).lookup = ((host: string, opts: unknown, cb: unknown) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  const o = (typeof opts === 'object' && opts !== null ? opts : {}) as Record<string, unknown>;
  const next = FIAT_IPV4_ONLY_HOSTS.has(host) ? { ...o, family: 4 } : o;
  return (__realLookup as unknown as (h: string, o: unknown, c: unknown) => unknown)(host, next, cb);
}) as typeof dns.lookup;

import { Command } from 'commander';
import { join } from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { DEFAULT_CONFIG_DIR } from './shared.js';
import { registerWallet } from './commands/wallet.js';
import { registerServer } from './commands/server.js';
import { registerPay } from './commands/pay.js';
import { registerFiat } from './commands/fiat.js';
import { registerBalance } from './commands/balance.js';
import { registerMisc } from './commands/misc.js';

// Read version from package.json at runtime
function getVersion(): string {
  const locations = [
    join(__dirname, '../../package.json'),
    join(__dirname, '../package.json'),
    join(process.cwd(), 'node_modules/moltspay/package.json'),
  ];
  for (const loc of locations) {
    try {
      if (existsSync(loc)) {
        const pkg = JSON.parse(readFileSync(loc, 'utf-8'));
        if (pkg.name === 'moltspay') return pkg.version;
      }
    } catch { /* ignore */ }
  }
  return '0.0.0'; // fallback
}

// Ensure config dir exists
if (!existsSync(DEFAULT_CONFIG_DIR)) {
  mkdirSync(DEFAULT_CONFIG_DIR, { recursive: true });
}

const program = new Command();
program
  .name('moltspay')
  .description('MoltsPay - Payment infrastructure for AI Agents')
  .version(getVersion());

registerWallet(program);
registerServer(program);
registerPay(program);
registerFiat(program);
registerBalance(program);
registerMisc(program);

program.parse();
