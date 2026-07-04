# Alipay `/buy` Latency Investigation Report

**Date:** 2026-06-05
**Scope:** moltspay Discord bot Alipay `/buy` slow to show the QR code (pre-QR ~74–84s)
**Code:** SDK `payment-agent` (`moltspay`, branch `feature/alipay`) · Bot `moltspay-discordbot`
**Underlying:** `alipay-bot` CLI v0.3.15 (`~/.local/share/alipay-bot-cli/runtime/dist/cli.js`)

---

## 1. Summary of Conclusions (TL;DR)

1. **The Alipay rail = a chain of `alipay-bot <subcommand>` subprocess spawns.** One complete payment has **8 spawns**: `ensure-cli` → `payment-intent` → `check-wallet` → `402-buyer-pay` (QR code appears here) → `query-payment-status` ×N (polling) → `402-buyer-fulfillment-ack`.

2. **Every command is "one long stall", not multiple gateway round trips.** The line-by-line timing probe proves it: for each spawn, **time to first byte ≈ total duration**, the CLI emits nothing the whole time, then dumps all results at once at the last instant and exits (drain takes only 0.5–1.2s). All output of `402-buyer-pay` appears at once **at 41578ms**, with no progress lines in between.

3. **Composition of the 74s before the QR code: `402-buyer-pay` 58% + `check-wallet` 31%.** Everything else (payment-intent, ensure-cli, local steps) totals about 11%.

4. **The ~42s of `402-buyer-pay` is inherent blocking inside the CLI/gateway** (order creation + QR generation); the Node side can neither subdivide it further nor change it; only ~6s of it is cold start, removable with a resident process.

5. **The ~23s of `check-wallet` is pure overhead** — wallet authorization state doesn't change between payments; once confirmed enabled, it need not be rerun per payment. **A cross-flow cache saves ~23s outright — the highest-ROI change right now.**

6. **The polling cadence is dragged down by the CLI itself:** each `query-payment-status` spawn blocks 25–36s on its own. The nominal 3s interval is meaningless — **after the user pays, detection can take up to ~36s**, stretching the perceived settle time. → **Mitigated by Rec #3 overlapping polling (see §5.1).**

---

## 2. Measurement Method (Probes)

On top of the structured-logging facility in `src/client/alipay/log.ts`, added **debug-level line/chunk timing** in `runCli` in `src/client/alipay/cli.ts` — all passive observation of real flows, **without touching the `402-buyer-pay` call itself, which really charges money**:

| Event | Meaning |
|---|---|
| `cli.firstbyte` | Time of the spawn's first byte (≈ cold start + first gateway round trip) |
| `cli.line` | Offset ms of each stdout/stderr line + 120-char preview |
| `cli.chunk` | Raw chunk arrival (including `\r` progress bars/buffered output that line splitting would miss) |
| `flow.pending` | Total duration before the QR code (`flow.start` → QR code displayable) |
| `flow.settled` | Duration from QR code to payment confirmation (includes user scanning) |

Enable with: `MOLTSPAY_ALIPAY_LOG=debug bash restart.sh`. The existing `ensure-cli` cache (per-process memo of the `--version` gate) is also in effect.

Environment limitation: this machine has no `strace`/`ltrace`/`/usr/bin/time`; further decomposition inside the CLI requires the CLI's own instrumentation or network capture.

---

## 3. Measured Data (one real payment, flow `discord-ecf318d0…`, 2026-06-05 14:53–14:57)

### 3.1 Pre-QR, step by step

| Step | First byte | Exit | Silent duration | Drain | Share of pre-QR |
|---|---|---|---|---|---|
| discover-services (local) | — | 28ms | — | — | <0.1% |
| challenge-402 (local) | — | 31ms | — | — | <0.1% |
| ensure-cli | — | 2588ms | (cold start) | — | 3.5% |
| payment-intent | 5298ms | 5799ms | 5.3s | 0.5s | 8% |
| **check-wallet** | **21953ms** | **22837ms** | **22s** | 0.9s | **31%** |
| **402-buyer-pay** | **41578ms** | **42807ms** | **41.6s** | 1.2s | **58%** |
| **Pre-QR total `flow.pending`** | | **74066ms** | | | 100% |

```
402-buyer-pay   42.8s  ████████████████████████  58%
check-wallet    22.8s  █████████████             31%
payment-intent   5.8s  ███                        8%
ensure-cli       2.6s  █                          3.5%
local steps      0.06s                            <0.1%
```

### 3.2 After the QR code (polling + wrap-up)

| Step | Per-spawn duration | Notes |
|---|---|---|
| query-payment-status tick1 | 28.8s | status=pending |
| query-payment-status tick2 | 25.7s | status=pending |
| query-payment-status tick3 | 25.0s | status=pending |
| query-payment-status tick4 | 36.5s | **status=paid** ✓ |
| `flow.settled` | **125035ms** | Includes user scanning + paying + detection latency |
| 402-buyer-fulfillment-ack | 28.6s | Fire-and-forget, doesn't block the user |

**Polling finding:** each `query-payment-status` blocks 25–36s on its own (first byte ≈ total duration — the same one-shot long stall). The nominal 3s interval is ineffective; the actual payment-detection granularity is ~25–36s.

### 3.3 Comparison with the two historical payments (total pre-QR duration)

| Payment | ensure-cli | payment-intent | check-wallet | 402-buyer-pay | pre-QR |
|---|---|---|---|---|---|
| Historical flow1 | 5943ms (cold) | 9546ms | 25567ms | 42126ms | 83210ms |
| Historical flow2 | 0ms (cache hit) | 7053ms | 24781ms | 46479ms | 78336ms |
| This run | 2588ms | 5799ms | 22837ms | 42807ms | 74066ms |

`check-wallet` (~23–26s) and `402-buyer-pay` (~42–46s) are highly stable across all three payments — structural costs; the `ensure-cli` cache hit only saves one cold start and has limited impact on the pre-QR total.

---

## 4. Analysis

- **"That 40s" is now characterized:** `402-buyer-pay` is a single, zero-output stall inside the CLI (order creation + gateway QR generation), not multiple round trips. The value of the line-by-line probe is precisely that it **ruled out the "multiple gateway round trips" hypothesis**. ≈ 6s cold start + ~35s inherent gateway stall, the latter inside the CLI/gateway.

- **Cold start vs gateway:** using `ensure-cli`/`--version` (pure cold start, zero network) as the baseline (~2.5–6s on this machine), the small command (payment-intent) is almost entirely cold start; the bulk of the two big commands (check-wallet, 402-buyer-pay) is in-command gateway/waiting, **not cold start**. This corrects the earlier judgment that "the bottleneck is all fingerprinting cold start".

- **Cold-start source (earlier profiling):** on every cold invocation the CLI runs a device-fingerprinting/telemetry subprocess chain (`general_external_id.js` ~5.8s + `ps` + macOS `system_profiler` (fails fast on Linux) + `__internal-refresh-claw-info-cache` / `__internal-log-worker`), zero network, ~1.15s CPU, the rest blocking wait. 0.3.15 has no `serve`/`daemon` subcommand.

- **8 spawns per payment**, each carrying its own cold start; a resident process could eliminate all cold-start overhead at once.

---

## 5. Recommendations (ROI, highest to lowest)

| # | Change | Expected gain | Risk/cost |
|---|---|---|---|
| **1** | ✅ **Implemented** `check-wallet` cross-flow cache/skip (commit 248973a) | **Saves ~23s per payment (31% of pre-QR)** | Low; pure overhead, controlled, small change |
| 2 | **Resident/pre-warmed CLI process**, eliminating the ~2.5–6s cold start per spawn (8 in this payment) | Pre-QR saves ~10–15s, more overall | Medium; CLI has no daemon subcommand — requires building our own resident host or pre-warming the claw-info cache |
| 3 | ✅ **Implemented** overlapping/non-blocking polling (see §5.1) | Payment-detection latency drops from ~(2×spawn+gap)≈50–60s to ~(cadence+1×spawn) | Medium; concurrent queries — see §5.1 for safety |
| 4 | The ~35s inherent gateway stall of `402-buyer-pay` | — | High/uncontrollable, unless alipay-bot provides a faster order-creation path |

**Next step: #2 (resident/pre-warmed CLI).** #1 and #3 have landed; what remains for eliminating cold starts is building our own resident host.

### 5.1 Rec #3 Implementation: Overlapping Polling (`src/client/alipay/poll.ts`)

Because a single `402-query-payment-status` spawn blocks 25–36s on its own (first byte ≈ total duration, not server-side long polling), the Node side cannot shorten a single call — but it can **launch overlapping polls on a fixed cadence** without waiting for the previous one to return:

- **Mechanism:** at most `POLL_MAX_INFLIGHT` (default 2) concurrent in-flight queries, refilling empty slots on the `POLL_INTERVAL_MS` (default 3s) launch cadence; the first to observe `paid` wins and immediately `internal.abort()`s the remaining sibling spawns.
- **Effect:** post-payment detection latency drops from "two spawns + gap" (~50–60s) to "launch cadence + one spawn".
- **Tunable:** `maxInflight` / `launchIntervalMs` (PollOptions), or env vars `MOLTSPAY_ALIPAY_POLL_MAX_INFLIGHT` / `MOLTSPAY_ALIPAY_POLL_LAUNCH_MS`; set `maxInflight=1` to fall back to strict sequential (old behavior).
- **Safety:** each concurrent query re-verifies fulfillment with a read-only verify (POST `/execute`); this is safe because (a) the moltspay checkout `/execute` handler is a no-op `{ok:true}`, and (b) actual fulfillment (e.g. the Discord role) is decoupled into the seller's single `onPaid`, which fires only once when this function resolves — never per-poll. Repeated/concurrent queries neither double-charge nor double-deliver.
- **Timeout semantics:** timeout is only declared when nothing is in-flight (an already-launched poll may return paid just after the deadline — consistent with the old loop's "check deadline only before spawning").
- **Tests:** `test/client/alipay/poll.test.ts`, 14 passing, including gate-runner verification of the real concurrency cap, first-paid-wins, and strict sequencing with `maxInflight=1`.

---

## 6. Reproduction and Operations

- **Enable timing:** `MOLTSPAY_ALIPAY_LOG=debug bash restart.sh` (debug floods `cli.line`; drop back to `info` after verifying).
- **Build + deploy:** `cd payment-agent && npm run build`, then `rsync -a --delete payment-agent/dist/ moltspay-discordbot/node_modules/moltspay/dist/` (⚠️ temporary; a bot `npm install` overwrites it — durability requires publish / workspace link). The bot must be restarted to load it.
- **Latency probe script:** `scripts/probe-alipay-cli.sh [runs]` (only tests `--version`/`--help`/`check-wallet`/`payment-intent`; **never** runs `402-buyer-pay` = a real charge).
- **Tests:** 204 tests passing (including `cli.test.ts`).
- **Pitfall:** do not inline `pkill -f "…dist…"` — it kills the current shell; use `restart.sh` (which uses `fuser -k 3402/tcp` internally).
