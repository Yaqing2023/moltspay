# alipay-bot CLI Performance Request: Per-Process Cold Start Accounts for ~80% of Payment Latency

**To**: alipay-bot CLI team
**From**: moltspay integrator
**Date**: 2026-06-06
**CLI version**: alipay-bot-cli 0.3.15 (`bin: ./dist/cli.js`)
**Environment**: Linux x64, Node v22.22.0

## One Sentence

Using a Node preload hook (hooking `child_process` / `undici(fetch)` / event-loop stalls), we profiled real payment flows and found that **of the ~40 seconds `402-buyer-pay` takes before showing the QR code, about 81% is local computation the CLI redoes from scratch in every process (device fingerprinting + native risk-control initialization + QR-code rendering), and only ~16% is the actual Alipay gateway round trips**. Every `alipay-bot <step>` command spawns a brand-new process and pays this cold start again, with no caching whatsoever between processes. **We kindly request a resident/daemon mode (or lazy native initialization + fingerprint reuse), which would save ~15–19 seconds per payment.**

## Measurement Method

- Observation-only `--require` preload hook: buffers in memory, flushes to disk at exit; changes no behavior, never touches stdout.
- Three buckets: A = synchronous subprocesses (`child_process.execFileSync`), B = network (undici/`fetch` `diagnostics_channel` + `net` connect), C = event-loop stalls minus A (= native synchronous computation).
- Captured on real production payment flows (not dry runs).

## Key Data

### 1) Cold start is not cacheable (3 sequential `--version` runs, zero network)

| Run | wall | Fingerprinting (A) `general_external_id.js` | Native (C) |
|---|---|---|---|
| run1 | 6680ms | 3361ms | 2868ms |
| run2 | 8860ms | 4404ms | 4005ms |
| run3 | 8515ms | 4672ms | 3503ms |

→ Every new process recomputes ~3–5s of fingerprinting + ~3–4s of native initialization, with **zero cross-process caching** (repeated back-to-back runs do not get faster). `--version` uses zero network throughout.

### 2) Real breakdown of `402-buyer-pay` (40.3s, single real payment)

| Bucket | Duration | Share |
|---|---|---|
| C native risk-control cold initialization (one solid stall t=0.6→15s) | ~14s | 35% |
| C native per-payment (transaction signing + `@resvg/resvg-js` QR rendering) | ~13s | 33% |
| A device fingerprinting `general_external_id.js` | ~5s | 13% |
| B gateway network (see below, 4 requests total) | ~6s | 16% |

Timeline highlight: fetch **does not fire for the first time until t=20.2s** — the first ~20 seconds are entirely local fingerprinting + native initialization + spawning dozens of `node cli.js __internal-*` workers.

### 3) Those 4 Network Requests

| # | t start | Target | Duration | Notes |
|---|---|---|---|---|
| 1 | 20.2s | `aigw.alipay.com/api/gateway/invoke` | 2.2s | Core gateway |
| 2 | 23.5s | `myip.ipip.net/` | — | **Third-party IP geolocation, fetched on every payment** |
| 3 | 25.8s | `aicashier.alipay.com/openclawpay/agent/v1/pay` | 2.9s | Checkout creation |
| 4 | 34.0s | `gw.alipayobjects.com/hrn/font?...AlipayWeiXiaoTiMedium` | 1.1s | **Font downloaded on every payment to render the QR-code image** |

## Concrete Requests (ordered by impact)

1. **[Highest] A resident/daemon mode**, or a long-lived interface that can reuse an already-initialized native runtime (stdin command loop / local socket / a `node-api` require-able module). Let device fingerprinting + apguard/blueshield native initialization happen once per process lifetime instead of per command. Estimated saving of **~15–19s** per payment (the cold-initialization portion).
2. **On-disk fingerprint/device-token cache** (with TTL): if the results of `general_external_id.js` (~5s) and native device attestation could be reused across processes, that alone would save ~5s/spawn.
3. **Static-asset caching**: bundle the font (`gw.alipayobjects.com/hrn/font`) with the package or add HTTP caching; make the IP geolocation (`myip.ipip.net`) cacheable/disableable — both are re-fetched on every payment.
4. **Lazy initialization**: read-only commands (e.g. `check-wallet`, `--version`) should not need the full native risk-control initialization.

## Mitigations We Have Done Ourselves (symptomatic only)

- `check-wallet` cross-flow cache (account-level, TTL) — warm flows skip the whole ~20s step.
- `payment-intent` handshake-skip cache (account-level, TTL) — warm flows skip ~5–9s.
- Overlapping status polling — reduces post-payment detection latency.

These only reduce the number of spawns; **the one unavoidable `402-buyer-pay` command still carries ~19s of uncacheable cold start, and only resident/reuse on the CLI side can fix that.**

## Appendix

Full profiler and timelines are in the moltspay repository: `scripts/cli-profile-hook.cjs`, `docs/ALIPAY-SLOWNESS-REPORT-2026-06-06.md`. Raw per-event JSON available on request.
