#!/usr/bin/env node

/*
 * postinstall — greet, then provision the alipay-bot CLI.
 *
 * alipay-bot is a runtime dependency of the Alipay payment rail. It is NOT on
 * npm (Alipay distributes it from their own CDN) and is licensed UNLICENSED, so
 * it can neither be a package.json dependency nor be bundled into this package.
 * Instead, installing moltspay provisions it automatically by invoking the
 * @alipay/agent-payment helper's `install-cli`, which downloads the CLI directly
 * from Alipay's CDN onto THIS machine — we never redistribute it ourselves.
 *
 * The user opted into this by installing moltspay (alipay-bot is a declared
 * dependency of the Alipay rail), so provisioning it is part of that install.
 *
 * Best-effort by design: provisioning failure (offline / CDN unreachable) prints
 * an actionable notice but NEVER fails `npm install`. The runtime `ensureCli`
 * gate is the real enforcement point and re-states the one command to run.
 *
 * Opt out with MOLTSPAY_SKIP_CLI_INSTALL=1 (e.g. CI / sandboxes).
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const banner = `
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🎉  Thanks for installing MoltsPay!                        ║
║                                                              ║
║   Quick Start:                                               ║
║     npx moltspay init          # Setup wallet                ║
║     npx moltspay status        # Check balance               ║
║     npx moltspay validate .    # Validate service config     ║
║                                                              ║
║   📖 Docs: https://moltspay.com/docs                         ║
║   💬 Support: https://discord.gg/QwCJgVBxVK                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`;
console.log(banner);

const PROVISION_HINT = 'npx -y @alipay/agent-payment install-cli';

function warnManual(reason) {
  console.warn(
    `\n[moltspay] Could not install the alipay-bot CLI automatically (${reason}).\n` +
      `           The Alipay rail requires it. Install it manually before use:\n` +
      `             ${PROVISION_HINT}\n`,
  );
}

if (process.env.MOLTSPAY_SKIP_CLI_INSTALL === '1') {
  console.log('[moltspay] MOLTSPAY_SKIP_CLI_INSTALL=1 — skipping the alipay-bot install.');
  console.log(`[moltspay] Install it manually when needed: ${PROVISION_HINT}`);
  process.exit(0);
}

console.log(
  "[moltspay] Installing the alipay-bot CLI from Alipay's official CDN (required by the Alipay rail)…",
);

// Prefer the helper we already pulled in as a declared dependency (no extra
// network for the helper itself). Fall back to `npx` if it isn't resolvable
// (odd layout / installed with --ignore-scripts on the dep).
let result;
let helperCli = null;
try {
  const helperPkgJson = require.resolve('@alipay/agent-payment/package.json');
  const helperDir = path.dirname(helperPkgJson);
  const bin = JSON.parse(fs.readFileSync(helperPkgJson, 'utf8')).bin;
  const rel = typeof bin === 'string' ? bin : bin && bin['agent-payment'];
  if (rel) helperCli = path.join(helperDir, rel);
} catch {
  helperCli = null;
}

if (helperCli && fs.existsSync(helperCli)) {
  result = spawnSync(process.execPath, [helperCli, 'install-cli'], { stdio: 'inherit' });
} else {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  result = spawnSync(npx, ['-y', '@alipay/agent-payment', 'install-cli'], { stdio: 'inherit' });
}

if (!result || result.error || result.status !== 0) {
  warnManual(result && result.error ? result.error.message : 'offline or *.alipay.com unreachable');
} else {
  console.log('[moltspay] alipay-bot CLI installed.');
}

// Never block the install over an optional rail's provisioning.
process.exit(0);
