# Root-Cause Analysis and Optimization Report for Slow Alipay `/buy`

**Project**: moltspay Discord bot Alipay payment speedup
**Code**: `~/clawd/projects/payment-agent` (branch `feature/alipay`, package name `moltspay`); bot at `~/clawd/projects/moltspay-discordbot`
**Report date**: 2026-06-06
**Bot runtime state**: PID 99752, `MOLTSPAY_ALIPAY_LOG=debug`

---

## 1. Problem

Alipay `/buy` takes about **78–84 seconds** from the user placing an order to the QR code appearing (the "pre-QR" window) — a very poor experience. We need to break down where the time goes and compress it as much as possible.

## 2. Investigation Method

- Added **structured timing logs** to the SDK (`MOLTSPAY_ALIPAY_LOG=info|debug`): `flow.start / flow.pending / step.end / cli.exit / poll.tick`, where `flow.pending` = total pre-QR duration.
- Added **line-by-line CLI timeline** instrumentation (debug level): `cli.firstbyte` (time to first byte), `cli.line`, `cli.chunk`, used to split the black-box time inside a single command into "one long stall" vs "many round trips".
- Used bash `time` + a Node `--require` preload hook (hooking `dns/net/tls/http/child_process/setTimeout`) to separate **CPU / blocking wait / network** (this machine has no strace/ltrace/`/usr/bin/time`).

## 3. Pre-QR Time Breakdown (two real production flows, measured)

The SDK implements the Alipay rail as a chain of `alipay-bot <step>` subprocess invocations:
`ensure-cli(--version)` → `payment-intent` → `check-wallet` → `402-buyer-pay`, followed by polling.

| Step | flow1 (ms) | flow2 (ms) | Notes |
|---|---|---|---|
| ensure-cli (`--version`) | 5943 | 0 (cache hit) | CLI cold-start gate |
| payment-intent | 9546 | 7053 | Almost entirely cold start |
| check-wallet | 25567 | 24781 | Wallet authorization check |
| **402-buyer-pay** | **42126** | **46479** | **Create transaction + fetch QR code (largest single item)** |
| discover-services / challenge-402 | ~80 each | ~80 each | Local, negligible |
| **Pre-QR total (`flow.pending`)** | **83210** | **78336** | |

> Polling `query-payment-status` (40927/88661ms) and `402-buyer-fulfillment-ack` (31387/34874ms) **include the user's scan-and-pay time** and are not part of pre-QR.

## 4. Root Causes

### 4.1 ~6–12s CLI cold start on every invocation (verified)
`alipay-bot` (`~/.local/bin/alipay-bot` → `node …/runtime/dist/cli.js`, v0.3.15) takes ~9–14s even just to run `--version`. Preload-hook profiling:
- **12s wall clock, but only 1.15s CPU and 0 network** → ~11s is **blocking wait**, not computation and not the gateway.
- The source is a **device-fingerprinting/telemetry subprocess chain run on every cold start**: `general_external_id.js` (~5.8s, obfuscated), `ps`, macOS `system_profiler` (fails fast on Linux), then spawning `__internal-refresh-claw-info-cache` and `__internal-log-worker`.
- In other words: the slowness is the **CLI fingerprinting the machine**, not the Alipay gateway, and not bot code.
- The CLI's own `native/` directory contains **`apguard.node` + `blueshield.node`/`libblueshield.so`** — Alipay device-security/risk-control native libraries; `cli.js` strings are heavily obfuscated, so the gateway interface cannot be read out statically.

Each pre-QR window has 4 spawns, each carrying its own ~6s cold start.

### 4.2 The two big commands are dominated by "in-command waiting" (verified)
After subtracting the ~6s cold-start baseline:
- **check-wallet ≈ 6s cold start + ~19s in-command waiting/gateway**
- **402-buyer-pay ≈ 6s cold start + ~40s in-command waiting/gateway**

### 4.3 The shape of 402-buyer-pay's 40s (verified, but composition not yet decomposed)
Line-by-line instrumentation of a real flow at 03:14 on 2026-06-06:
```
step.start    402-buyer-pay         03:12:46.083
cli.firstbyte 402-buyer-pay  43115ms   ← silent for 43 seconds after launch before first byte
cli.line      "✓ 支付待确认" + QR code + trade number  (all emitted at once at 43115~43117ms)
cli.exit                      44600ms  ok=true
```
**Shape conclusion**: the CLI is silent for 43s, then dumps all output in one shot → this is **one long stall** (create transaction → fetch QR code), not many small round trips.

> ⚠️ **Honesty statement (important)**: this 43s has **not yet been broken down into components**. It mixes at least three parts: (1) cold start + device fingerprinting ~6s (measured); (2) apguard/blueshield risk-control native-library local computation (**not measured** — possibly zero-network CPU stall); (3) the actual Alipay gateway order-creation round trip (**not measured**).
> The earlier claim that "402-buyer-pay is Alipay gateway blocking and nothing can be done on the Node side" **was an estimate, not a measurement**. If (2) is the dominant share, it is **pre-warmable/cacheable** just like the cold start, and "nothing can be done" does not hold. **Only (3) is truly externally uncontrollable.**

### 4.4 Breakthrough: the CLI profiler decomposed that 40s (measured 2026-06-06)

Added `scripts/cli-profile-hook.cjs` (an observation-only `--require` preload hook) that splits each spawn into A) childSync fingerprinting chain, B) network gateway in-flight, C) nativeStall native risk-control computation. **Key fix**: the CLI spawns many `node cli.js __internal-*` background workers, which inherit the same `MOLTSPAY_CLI_PROFILE_OUT` and overwrite the real command's file → changed to per-pid output files + recording argv to identify the real command; also added an undici `diagnostics_channel` hook (the CLI uses `fetch()`, which bypasses `http.request`).

**Clean check-wallet measurement (run manually, no charge, 11.8s):**

| Bucket | Duration | Share | Nature |
|---|---|---|---|
| A. childSync fingerprinting (`general_external_id.js`) | 3320ms | 28% | **Local, pre-warmable** |
| C. nativeStall native risk control (`apguard`/`blueshield`) | 6075ms | 51% | **Local, pre-warmable** |
| **B. Gateway network (`aigw.alipay.com/api/gateway/invoke`)** | **1874ms** | **16%** | **Truly external, uncontrollable** |

Timeline: fetch **does not start until t=8.6s** (everything before that is fingerprinting + native + spawning dozens of node workers); the gateway round trip is only ~1.9s.

> **Original conclusion overturned**: at least for check-wallet, ~80% is local and pre-warmable; only ~16% is the real gateway. "Gateway blocking, nothing can be done on the Node side" does not hold — the real lever is **Rec #2 pre-warmed/resident CLI** (eliminating fingerprinting + native cold computation), not the gateway.
>
> ⚠️ The 40s shape of `402-buyer-pay` is **strongly presumed to be the same** (same CLI, same fetch path), but it creates a real transaction and its gateway leg may be heavier — **to be captured with the fixed harness on the next real `/buy`** (harness is fixed and validated on check-wallet). Note: production check-wallet ~21s vs manual 11.8s; the difference is machine-load fluctuation in the fingerprinting/native parts, but the shape "network is only a small share" holds.

## 5. Completed Optimizations (live, committed)

| Measure | Rec | Status | Effect (measured) |
|---|---|---|---|
| ensure-cli cold-start cache | — | ✅ | From the second payment in-process, saves one cold start: 5943ms → 0ms |
| **check-wallet cross-flow cache** | #1 | ✅ deployed + verified over two flows | flow2 skips the check-wallet spawn entirely; pre-QR 68109→54420ms (net −13.7s) |
| **Overlapping status polling** | #3 | ✅ committed + measured | 2 concurrent polls, fastest responder wins; payment-detection latency tightened from ~50–60s to ~(cadence + 1 spawn) |
| Timing logs + line-by-line CLI timeline instrumentation | — | ✅ | Makes black-box time decomposable |

**Implementation notes**
- **check-wallet cache** (`alipay/index.ts`): process-level positive cache `walletReadyUntil`, keyed by `${configDir}::${framework}`, default TTL 10min (`MOLTSPAY_ALIPAY_WALLET_TTL_MS`); caches only "ready", and only for the default runner; `resetWalletCache()` clears it on bind/unbind.
- **Overlapping polling** (`alipay/poll.ts`): fixed cadence (`POLL_INTERVAL_MS`=3s) with at most `POLL_MAX_INFLIGHT` (default 2) concurrent `402-query-payment-status`; the first one to see `paid` wins and aborts the rest. A single spawn blocks ~25–36s with first byte ≈ total duration (not server-side long polling), so the old serial loop could discover payment up to ~50–60s late in the worst case.
- **Key finding**: the `/execute` inside polling is **not a no-op** (it drives Alipay fulfillment). Repeated execute is **idempotently rejected** by Alipay with `40004 交易状态不允许履约` ("transaction state does not allow fulfillment"); `40004` parses as `unknown` (not `rejected`), so the loser never falsely terminates, and delivery via the seller's `onPaid` fires only once — safe.

**Commits**: `248973a` (check-wallet cache + instrumentation), `7e8066e` (overlapping polling), `9ffa97d` (test report + SAFETY comment correction).
**Tests**: 57 alipay cases pass (11 AuditLog/PaymentAgent/chains failures are **pre-existing** and unrelated to this work).
**Deployment method**: `npm run build` (tsup) → `rsync -a --delete payment-agent/dist/ moltspay-discordbot/node_modules/moltspay/dist/` → restart the bot. ⚠️ rsync is a temporary measure — a bot `npm install` will overwrite it; the durable path = publish/`npm pack`/workspace link.

## 6. Remaining Levers

| Rec | Content | Magnitude | Difficulty |
|---|---|---|---|
| **#2** | Resident/pre-warmed CLI, eliminating ~6s×N cold starts | ~24s across the full flow | Structural; v0.3.15 has no daemon subcommand — requires building our own resident process or pre-warming the fingerprint cache |
| **#4** | 402-buyer-pay's ~40s | Largest single item (~55%) | **Decompose first**, then judge: if it's local risk-control computation → pre-warmable; if it's gateway network → needs cooperation from the Alipay side |

## 7. TODO (Next Steps)

1. **Decompose 402-buyer-pay's 40s** (highest value): on the next **real** `/buy`, attach the network/CPU preload hook to that step's CLI process to distinguish socket waiting (gateway) vs zero-network stalls (local risk-control computation). ⚠️ This step really creates a transaction order — it cannot be dry-run probed, only captured on a real payment.
2. **Quantify the multi-round benefit of overlapping polling**: in the last measured payment the buyer paid instantly and it settled at tick=1, so the multi-round latency benefit is **not yet quantified**; needs one "slow payment" test (buyer waits 1–2 minutes to force ≥2 rounds).
3. Evaluate feasibility of the Rec #2 resident-CLI approach.

## 8. Related Documents

- `docs/ALIPAY-LATENCY-REPORT.md` — raw latency measurement data
- `docs/ALIPAY-OVERLAP-POLL-TEST-2026-06-06.md` — real-payment validation of overlapping polling
- `docs/ALIPAY-RAIL.md` / `ALIPAY-INTEGRATION-DESIGN.md` / `ALIPAY-INTEGRATION-PLAN.md` — rail and integration design
