# Distribution Test Procedure (pre-release builds not yet published to npmjs)

How to distribute a test build of `moltspay` to other machines and verify installation **before** publishing to npmjs.
Running `npm test` in the dev repo **cannot validate distribution behavior** — the postinstall auto-provision, the `files` allowlist, and the tarball contents only take effect on a "pack → clean-environment install" path, so you must go pack → transfer → clean install.

Applicable version: `moltspay@1.7.0` (branch `feature/alipay`).

---

## Overview

```
Dev machine                               Target machine (e.g. openclaw deploy)
┌──────────────────────┐                 ┌──────────────────────────┐
│ npm run build        │                 │ npm install <tgz>        │
│ npm pack  ─► .tgz    │ ── scp/rsync ─► │  └ postinstall:          │
│ (verify tarball)     │                 │     provision alipay-bot │
└──────────────────────┘                 │ smoke test / real path   │
                                         └──────────────────────────┘
```

---

## 1. Build + pack

```bash
cd ~/clawd/projects/payment-agent
npm run build          # tsup; prebuild runs rm -rf dist first
npm pack               # produces moltspay-<version>.tgz, honoring the files allowlist in package.json
```

> `npm pack` does **not** run `prepublishOnly` (typecheck + build + verify:web) — that only triggers on `npm publish`.
> To fully simulate a release, run manually first: `npm run typecheck && npm run verify:web`.

**Verify the tarball contents** (key artifacts must be present):

```bash
npm pack --dry-run 2>&1 | grep -iE "postinstall|dist/|schemas|README|LICENSE|total files"
```

Expected to include: `scripts/postinstall.js`, `dist/`, `schemas/`, `.env.example`, `README.md`, `LICENSE`
(1.7.0 measured: 77 files / package ~1.4MB / unpacked ~5.9MB).
`scripts/postinstall.js` must be on the list — this is what the `d99e760` fix guarantees; without it there is no auto-provision.

---

## 2. Distribute to the target machine

The pack artifact is equivalent to what `npm publish` uploads, so just transfer the `.tgz`:

```bash
# scp
scp -i ~/.ssh/<key>.pem moltspay-1.7.0.tgz <user>@<host>:~/moltspay/

# or rsync (checksummed, incremental)
rsync -avh -e "ssh -i ~/.ssh/<key>.pem" \
  moltspay-1.7.0.tgz <user>@<host>:~/moltspay/
```

After transfer, **verify integrity** (sha1 should match on both ends):

```bash
# local machine
sha1sum moltspay-1.7.0.tgz
# target machine
ssh -i ~/.ssh/<key>.pem <user>@<host> "sha1sum ~/moltspay/moltspay-1.7.0.tgz"
```

> One verified run: `ubuntu@ec2-44-220-151-119.compute-1.amazonaws.com` (pem `~/.ssh/zen7.pem`),
> sha1 on both ends = `02d95f2dc8e92cbbe73e069487e0c422ca2edc35`.
> Note the EC2 username: this machine is `ubuntu` (not `ec2-user`); the pem must be `chmod 600` or SSH refuses.

**Other distribution methods** (by scenario):
- **Git install** `npm i git+https://…#feature/alipay` — ⚠️ the repo currently has **no `prepare` script** and `dist/` is not in git, so an install gets no build artifacts; **unusable** (unless `prepare` is added first). Also, the `origin` remote embeds a plaintext PAT; never include it in commands.
- **Private registry (Verdaccio)** `npx verdaccio` → `npm publish --registry http://host:4873` → on the target `npm i moltspay --registry …`. Suited to multi-machine/CI repeated pulls, or when you need to test `moltspay@version` version resolution. Unnecessary for a one-off test.
- **npm link** is a local same-machine symlink only; unusable across machines.

---

## 3. Install on the target machine and verify postinstall

Install the tarball in a clean directory:

```bash
mkdir ~/molt-test && cd ~/molt-test && npm init -y
npm install ~/moltspay/moltspay-1.7.0.tgz
```

(For a global install, `sudo` is required when the npm prefix is `/usr/local`.)

**All three postinstall paths must be verified**:

| Scenario | Command | Expected |
|---|---|---|
| Online, normal | `npm install <tgz>` | Prints banner → installs alipay-bot from the `*.alipay.com` CDN → `[moltspay] alipay-bot CLI installed.` |
| Offline / CDN unreachable | (with network down) `npm install <tgz>` | Does **not block** `npm install`; prints `[moltspay] Could not install the alipay-bot CLI automatically (…)` followed by the manual command `npx -y @alipay/agent-payment install-cli` |
| Explicit skip | `MOLTSPAY_SKIP_CLI_INSTALL=1 npm install <tgz>` | `[moltspay] MOLTSPAY_SKIP_CLI_INSTALL=1 — skipping the alipay-bot install.` then the manual command (for CI/sandbox) |

> Exit code is `0` in all three paths — provisioning an optional rail must never fail `npm install`.

> alipay-bot (`0.3.x`) is not on npm, license `UNLICENSED`, distributed via the Alipay CDN; the only thing that goes into package.json is the installer `@alipay/agent-payment` (same model as Chromium under Puppeteer: downloaded at install time, never redistributed).

---

## 4. Smoke test (no real money)

```bash
node -e "require('moltspay'); console.log('require ok')"   # entry point usable
moltspay --help
moltspay --version                                     # expect 1.7.0
```

The Alipay rail additionally needs `alipay-bot` on the PATH (usually `~/.local/bin`, not on the default PATH):

```bash
export PATH=$HOME/.local/bin:$PATH
alipay-bot --version        # expect 0.3.x
```

**Offline verification of payment logic** (inside the dev repo, no network, no charges):

```bash
npm run verify:alipay:offline   # offline E2E: keys/signing/signature verification
npm run verify:alipay:http      # HTTP 402 dual-emit
```

### Live test endpoint

Live reference provider (actually in use, **not** the README example domain `moltspay.com/a/zen7`):

```
https://juai8.com/zen7
```

Confirm the service is up without spending (should return `status: healthy`, `facilitators.alipay.healthy=true`):

```bash
curl -s https://juai8.com/zen7/health | jq .   # all 5 rails cdp/tempo/bnb/solana/alipay healthy
```

Hit the Alipay rail (real small-amount charge; run only after confirming the config is correct):

```bash
PATH=$HOME/.local/bin:$PATH \
  moltspay pay https://juai8.com/zen7 text-to-video --rail alipay \
  --prompt "a happy cat" --config-dir ~/.moltspay
```

> Network is Base mainnet (`eip155:8453`); `/execute` reads `service`/`prompt` from the body and returns `400` when parameters are missing.

The real `/pay` path charges real money; run only after the config is confirmed correct. Timing logs (for latency troubleshooting) must be set **inline** as `MOLTSPAY_ALIPAY_LOG=debug` (putting it in `~/.moltspay/.env` has no effect, because module loading happens before env is read).

---

## 5. Architecture notes / known issues

- **No AgentPayGuard prebuilt binaries for linux-arm64 (aarch64)**: the Alipay native risk-control plugins `apguard`/`blueshield` ship only four platforms — `linux-x64` / `darwin-arm64` / `darwin-x64` / `win32-x64` — **`linux-arm64` is missing** (confirmed empirically on an x64 machine). So on an aarch64 target AgentPayGuard **init always fails** (`AGENT_PAY_GUARD_INIT_FAILED`, non-fatal, **payment still succeeds**), but every cold invocation writes `code:"999"` failure telemetry into `~/.alipay-bot-cli/monitor-queue/` that is never uploaded (86k files / 346MB observed once). Safe to clean with `rm -rf ~/.alipay-bot-cli/monitor-queue/*`; a TTL/cron is recommended. The long-term fix requires Alipay to ship a linux-arm64 prebuilt.
  > ⚠️ **Critical for distribution testing**: a clean install-and-test on a local x64 machine ≠ a working ARM target — the AgentPayGuard issue only surfaces on linux-arm64, so be sure to verify on a real aarch64 machine.
- **A sudo global install** may put alipay-bot into root's home directory, so a service running as a regular user cannot find the CLI. Recommended to split into two steps: "install the SDK globally" + "run `npx -y @alipay/agent-payment install-cli` separately as the runtime user".
- The egress firewall only needs to allow `*.alipay.com` (incl. the CDN).

---

## 6. Upgrade / redistribute

```bash
# dev machine: repack after bumping the version
npm run build && npm pack

# sync-overwrite the target machine
rsync -avh -e "ssh -i ~/.ssh/<key>.pem" moltspay-<ver>.tgz <user>@<host>:~/moltspay/

# target machine: reinstall + restart consumers (openclaw / bot)
npm install ~/moltspay/moltspay-<ver>.tgz
```

---

## Related docs

- [`ALIPAY-RAIL.md`](./ALIPAY-RAIL.md) — the Alipay payment rail / alipay-bot dependency and license model
- [`../CHANGELOG.md`](../CHANGELOG.md) — 2.0.0 release notes (config examples and test scripts)
