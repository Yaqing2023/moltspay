# Alipay Payment Overall Processing-Time Assessment Report

**Project**: moltspay Discord bot Alipay `/buy` latency
**Date**: 2026-06-06
**Method**: SDK structured timing logs + observation-only CLI profiler (`scripts/cli-profile-hook.cjs`, splitting into three buckets: child_process / undici(fetch) / event-loop stalls) + real production payment-flow capture
**Related documents**: [ALIPAY-BOT-CLI-PERF-REQUEST](./ALIPAY-BOT-CLI-PERF-REQUEST-2026-06-06.md)

---

## 0. Conclusions at a Glance

1. **System processing time before the QR code**: cold **77.4s** → warm flow (cache hits) **48.4s** (−37%; the deployed caches are verified effective).
2. In the warm flow, **the 48.4s is almost 100% the single `402-buyer-pay` command** — everything the SDK side can cut (payment-intent / check-wallet / polling) has been cut.
3. Of `402-buyer-pay`'s ~40s, **81% is alipay-bot CLI per-process local computation** (device fingerprinting + native risk control + QR-code rendering); only **16%** is the real Alipay gateway.
4. **This local computation is highly sensitive to machine configuration/load**: the bot currently runs on a **2-core machine at load 9–16 (5–7× oversubscribed)**; measured, the same command at load 9→16 takes +67% longer, and all of the amplification is in local computation — network unchanged.
5. Only two paths remain for further compression: **(a) a stronger/less-loaded machine** (reduce load-queuing amplification), **(b) a vendor-provided CLI resident/daemon mode** (remove ~15–19s per-process cold initialization).

---

## 1. End-to-End Duration (real verification flows, 2026-06-06)

| Phase | Cold flow `discord-808ade4e` | Warm flow `discord-99fdfab4` |
|---|---|---|
| payment-intent | 9.9s (ran, wrote cache) | **0 (skipped ✅)** |
| check-wallet | 23.0s (ran, wrote cache) | **0 (skipped ✅)** |
| 402-buyer-pay | 39.1s | 48.3s |
| **Pre-QR total** | **77.4s** | **48.4s** |
| Afterwards | Buyer scans + pays (human, not counted as system latency) → fulfillment ack (warm flow verified settling successfully end-to-end) | |

> Both payments returned a valid 32-digit tradeNo, and the warm flow reached "✓ 发送买家履约回执成功" ("buyer fulfillment receipt sent successfully") — **the cache skips did not break payments**.
> The warm flow's 402-buyer-pay (48.3s) was actually ~9s slower than the cold flow's (39.1s) due to load jitter (see §3), eating into part of the cache gain; net pre-QR still dropped by 29s.

---

## 2. Breakdown of `402-buyer-pay`'s ~40s (clean capture pid551984, 40.3s)

| Bucket | Duration | Share | Nature |
|---|---|---|---|
| C native risk-control cold initialization (one solid block t=0.6→15s) | ~14s | 35% | Local; only a resident process can save it |
| C native per-payment (transaction signing + resvg QR rendering) | ~13s | 33% | Local; must be computed per payment |
| A device fingerprinting `general_external_id.js` | ~5s | 13% | Local; must be computed per spawn |
| B gateway network (4 requests) | ~6s | 16% | Truly external |

The 4 network requests: `aigw.alipay.com` (2.2s), `myip.ipip.net` (IP geolocation), `aicashier.alipay.com` (2.9s), `gw.alipayobjects.com/font` (1.1s, font downloaded on every payment). fetch does not fire until t=20s — the first 20s are entirely local.

---

## 3. Impact of System Configuration / Load on Duration (new assessment this round)

### 3.1 Machine Configuration

| Metric | Value |
|---|---|
| CPU | **2 cores** Intel Xeon @ 2.20GHz |
| Load averages (1/5/15min) | **9.5 / 11.7 / 14.9** — full utilization of 2 cores = 2.0, so **5–7× oversubscribed** |
| Memory | 15 GiB, ~10 GiB free, no swap (not a bottleneck) |
| Other workloads on the same machine | Multiple node + python processes at 23–29% CPU each |

### 3.2 Why Load Directly Amplifies Duration

81% of `402-buyer-pay` is **CPU-intensive local computation + spawning dozens of `node __internal-*` workers**. On a 2-core machine at load 10–15, every computation and every spawn must **queue for CPU time slices**; the higher the load, the longer the queuing, and local-computation time is amplified proportionally.

### 3.3 Measured Evidence: Same Command, Slower at Higher Load, and Only in Local Computation

`alipay-bot check-wallet` (read-only, no charge), two back-to-back runs:

| Run | Load at the time | wall | Fingerprinting (A) | Native (C) | Network (B) |
|---|---|---|---|---|---|
| run1 | ~9 | 14.7s | 3.6s | 7.9s | 2.5s |
| run2 | ~16 | **24.5s** | 5.2s | **14.8s** | **2.1s** |

Load 9→16, same command **+67%**; the amplification is almost entirely in native computation (7.9→14.8s, **doubled**); **network stays stable at ~2–2.5s, unaffected**. A further comparison with an earlier, quieter run of check-wallet at just **11.8s** — the same command swings between 11.8 / 14.7 / 24.5s, and the 2×+ variance comes entirely from the local-computation buckets.

### 3.4 Implications

- **Current durations are significantly amplified by this heavily overloaded 2-core machine**, and this amplification stacks on top of the vendor CLI's inherent cold computation.
- Part of the real gain from our caching optimizations (−29s) is masked by load noise (e.g. the warm flow's 402 going up by 9s).
- **Moving to a dedicated machine with more cores and load <1/core should visibly compress the ~32s local-computation portion of 402** (removing queuing amplification + parallel speedup); but the ~6s of network is configuration-independent, and the single-threaded native algorithms still have an inherent floor on a 2.2GHz single core.

---

## 4. Completed Optimizations (live + verified)

| Measure | Status | Gain |
|---|---|---|
| check-wallet cross-flow cache | ✅ live + verified over two flows | Warm flow saves the whole step, ~23s |
| payment-intent handshake-skip cache | ✅ live + verified with two real purchases (payments succeeded end-to-end) | Warm flow saves ~5–10s |
| Overlapping status polling | ✅ live | Reduces post-payment detection latency |
| ensure-cli cold-start cache | ✅ | Saves one cold start in-process |

Commits: `248973a` `7e8066e` `9ffa97d` `b929b1c` `438d86a` `0473911` (branch `feature/alipay`).

---

## 5. Remaining Levers (by impact)

1. **Runtime environment** (within our control, actionable now): migrate the bot to a ≥4-core, low-load dedicated machine; or reduce other workloads on the same machine. Expected to shave the "queuing amplification" portion of 402's local computation.
2. **Vendor CLI resident/daemon mode** (highest single-point impact; requires the alipay-bot team): remove the ~15–19s per-process cold initialization. A requirements document with full supporting data is ready ([ALIPAY-BOT-CLI-PERF-REQUEST](./ALIPAY-BOT-CLI-PERF-REQUEST-2026-06-06.md)).
3. **Per-payment native (~13s signing + rendering) + gateway (~6s)**: a hard floor that even a resident process cannot remove; only shrinks marginally with better single-core performance.

### Realistic Expectations (warm-flow pre-QR)

| Scenario | Estimated pre-QR |
|---|---|
| Current (2 cores / load 10–15) | ~48s |
| + dedicated machine (≥4 cores / low load) | Local-computation queuing amplification removed, est. ~25–35s (to be measured) |
| + vendor resident mode | Another ~15–19s of cold initialization removed, est. ~15–21s |

> The numbers contain estimated components; the load-latency relationship in §3.3 is measured; the exact gains of the dedicated machine and resident mode each need their own set of controlled measurements to confirm.
