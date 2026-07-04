# Alipay Overlapping Polling (Rec #3) Real-Payment Test Report

**Date:** 2026-06-06
**Change under test:** `src/client/alipay/poll.ts` — overlapping/non-blocking polling (`POLL_MAX_INFLIGHT=2` enabled by default)
**Commit:** `7e8066e perf(alipay): overlapping status polls …`
**Environment:** moltspay Discord bot (PID 99752, `MOLTSPAY_ALIPAY_LOG=debug`) · SDK `moltspay@1.7.0` (built + rsynced into the bot's `node_modules/moltspay/dist`) · `alipay-bot` CLI v0.3.15
**Payment:** one real Alipay payment, flow `discord-c47b0da6…`, trade number `20260606008281111347110000048039`

---

## 1. Summary of Conclusions (TL;DR)

1. ✅ **Overlapping polling confirmed effective on the real rail.** During a real-money payment we observed **2 `402-query-payment-status` spawns in flight simultaneously** (launched on a ~3s cadence, concurrent for ~42s) — no longer the old serial "wait for one to finish before launching the next".

2. ✅ **"First paid wins" is correct.** `tick=1` got `status:"fulfilled"` → immediate `flow.settled`; the concurrent sibling `tick=2`, returning `unknown` ~1s later, was discarded without affecting the result.

3. ✅ **Concurrency safety holds against the real gateway (and for a stronger reason than the original comment).** When the sibling poll repeats the `/execute` request, Alipay rejects the second fulfillment with `40004 交易状态不允许履约` ("transaction state does not allow fulfillment") — **fulfillment is idempotent**: neither double-charging nor double-delivering. 40004 parses as `unknown` (not `rejected`), so the loser can never falsely terminate polling.

4. ✅ **End-to-end success**: buyer pays → role/resource delivered → `402-buyer-fulfillment-ack ok=true`.

5. ⚠️ **This payment could not quantify the "latency benefit"**: the buyer paid quickly, the first polling round (`tick=1`) already hit `paid`, and only one round ran. The latency benefit of overlapping only shows when the buyer pays **in a later polling cycle** (it shortens the interval between adjacent detection opportunities). Quantifying it requires a slow-payment test where the buyer deliberately waits 1–2 minutes. The multi-round benefit is currently still guaranteed by unit tests + reasoning.

6. 🔧 **Incidental correction**: the original code comment claimed `/execute` is a no-op `{ok:true}` — measured, it **drives Alipay's fulfillment confirmation and is not a no-op**. The safety comment was rewritten accordingly (rationale changed to "Alipay fulfillment is idempotent; a concurrent second fulfillment is rejected with 40004"). Comment-only change, no logic change.

---

## 2. Measured Data (flow `discord-c47b0da6…` / trade number `…048039`)

### 2.1 Pre-QR = 82.0s

| Step | Duration | ok | Notes |
|---|---|---|---|
| payment-intent | 9657ms | ✅ | |
| check-wallet | 22953ms | ✅ | **`hit=false`** (in-process cache empty after restart, so the first payment must run it; `cachedForMs=600000` was written — the next payment within 10min skips it) |
| 402-buyer-pay | 44600ms | ✅ | Inherent gateway stall (Rec #4, not changeable on the Node side) |
| **`flow.pending`** | **82011ms** | | QR code available for display |

Consistent with the three historical payments in [ALIPAY-LATENCY-REPORT.md](ALIPAY-LATENCY-REPORT.md) §3: `check-wallet` ~23s and `402-buyer-pay` ~45s are structural costs.

### 2.2 After the QR code (polling) — overlapping concurrency

```
03:13:30.685  flow.pending (polling starts)
03:13:30.7±   tick=1 launch ─┐
03:13:33.7±   tick=2 launch ─┤  ← two spawns concurrently in flight (cadence ~3s)
03:14:15.087  tick=1 exit 44377ms ok=true  code=0 → status=paid   ✅ winner
03:14:15.088  flow.settled 44391ms                                → immediate settle + onPaid fired (once)
03:14:16.053  tick=2 exit 41922ms ok=false code=1 → status=unknown  ← discarded sibling (40004)
```

| poll | Per-spawn duration | exit | Parsed status | Resource response |
|---|---|---|---|---|
| tick=1 | 44377ms | ok=true code=0 | **paid** | `"status":"fulfilled"` |
| tick=2 (concurrent sibling) | 41922ms | ok=false code=1 | unknown | `"status":"delivered_unconfirmed"`, `error: alipay fulfillment 40004: 交易状态不允许履约` |

- **Concurrency evidence**: the two spawns' `cli.line` output interleaves between `03:14:01` and `03:14:04`, each carrying a different `/execute` response body — proving both were **in flight simultaneously**, not serial.
- **Settle latency** `flow.settled = 44391ms`: roughly one spawn's duration. In this payment the buyer had already paid within the first polling window, so the first returning poll detected `paid` (in this case serial and overlapping take the same time — see §1.5).

### 2.3 Wrap-up

| Step | Duration | ok | Notes |
|---|---|---|---|
| 402-buyer-fulfillment-ack | 39831ms | ✅ | Fire-and-forget, does not block the user's settlement |

---

## 3. Comparison Against Design Expectations

| Design assertion (commit 7e8066e / poll.ts) | Measured | Verdict |
|---|---|---|
| At most `POLL_MAX_INFLIGHT=2` concurrent spawns | 2 observed concurrently | ✅ |
| First `paid` wins and aborts siblings | tick=1 paid → settled; tick=2 unknown discarded | ✅ |
| Concurrent queries neither double-charge nor double-deliver | Sibling `/execute` rejected by Alipay with 40004; onPaid fired exactly once | ✅ |
| Loser never falsely terminates polling | 40004 → `unknown` (not rejected), no termination | ✅ |
| Timeout fires only when nothing is in-flight | No timeout in this payment; logic covered by unit tests | ✅ (unit) |
| Multi-round scenario shortens detection latency ~(2×spawn+gap)→~(cadence+spawn) | Only 1 round in this payment; not triggered | ⏳ awaiting slow-payment test |

---

## 4. Findings and Follow-ups

1. **`/execute` is not a no-op (comment corrected).** The real safety guarantee is "Alipay fulfillment is idempotent + 40004 rejects a second fulfillment", which is both stronger and more accurate than the original "/execute is a no-op" comment. The `poll.ts` module header comment has been updated.

2. **The `check-wallet` cache is process-level and dies on restart.** This payment's `hit=false` was because the debug restart cleared the in-process cache. Rec #1 saves ~23s on "subsequent payments within the same process", but the first payment after every restart still reruns it. Reuse across restarts requires a persisted cache with TTL (`cachedForMs` is already reserved in the design).

3. **Outstanding: a slow-payment test** to quantify the multi-round overlapping latency benefit (buyer deliberately waits 1–2 minutes, triggering ≥2 polling rounds, comparing detection latency). This round confirmed mechanism/concurrency/safety/end-to-end, but not the latency numbers.

4. **Operations**: the test ran under `MOLTSPAY_ALIPAY_LOG=debug`; after verification run `bash restart.sh` (without debug) to drop back to info, avoiding `cli.line` flooding.

---

## 5. Raw Log Location

`~/clawd/projects/moltspay-discordbot/bot.log` (debug level; contains all `cli.line` / `poll.tick` / `flow.*` for this flow). Key-line filter:

```
grep -E "c47b0da6|048039" bot.log | grep -E "flow\.|poll.tick|cli.exit"
```
