# WeChat + Balance Password-Free Payments (免密支付) — Design

> **Target**: `moltspay@2.3.0`
> **Status**: Proposed (2026-07-12)
> **Scope**: Fuse the WeChat Native scan-to-pay rail (2.1.0) with the custodial balance rail (2.2.0) so a buyer scans **once** to load a balance pack, then spends **password-free** from that balance until it runs low.
> **Supersedes**: nothing — extends `WECHAT-RAIL-DESIGN.md` and `BALANCE-RAIL-DESIGN.md`; where either disagrees, this document is authoritative for the fused flow.
> **Related**: `WECHAT-RAIL-DESIGN.md`, `BALANCE-RAIL-DESIGN.md`, `CHANGELOG.md` [2.1.0]/[2.2.0], the WeChat topup amount-spoofing fix (`fix(balance): credit WeChat-verified paid amount`).

## TL;DR

| Aspect | Value |
|---|---|
| Goal | "Scan once, then password-free" — WeChat funds a prepaid balance; balance is the spend rail |
| Honest framing | WeChat has **no autonomous payer**; a human always scans to fund. "Password-free" lives entirely on the **balance deduction** side (no re-scan per purchase) |
| Roles | **WeChat = funding entry** (scan-to-topup) · **Balance = spending exit** (免密 deduct) |
| Ledger currency | **CNY** (`provider.balance.currency: "CNY"`). Units = **fen** (整数分). WeChat `payer_total` (fen) credits **1:1**, no FX |
| Top-up model | **Fixed packs** (`topup_packs`, e.g. `["20.00","50.00"]`) + `default_pack` + `auto_topup_max` |
| Auto-credit | **Callback-primary, polling-fallback** — `notify_url` (apiv3 AES-256-GCM decrypt + platform-cert verify) is authoritative; server polling backs it up; both idempotent on `out_trade_no` |
| Buyer binding | WeChat `attach` carries `{ buyer_id, nonce }` so an anonymous Native order credits the **correct** balance |
| Amount integrity | Server credits **only** the gateway-verified `payer_total`; client-declared amount is never trusted (structural, not a patch) |
| Idempotency | Top-up credit idempotent on `wechat:<out_trade_no>`; deduction idempotent on `request_id` |
| Breaking changes | None. Existing WeChat (per-tx) and balance rails keep working; the fused flow is opt-in via config + client behavior |

---

## 1. Motivation

Today the three pieces exist but are **disjoint manual steps**:

```
moltspay wechat start <server> <service>                       # QR, user scans, pays exact price
moltspay balance topup <server> <amt> --rail wechat --out-trade-no WX...   # manual credit (amount spoofable)
moltspay pay <server> <service> --rail balance                 # password-free deduct
```

Problems:
- **Manual `out_trade_no` plumbing** between steps; no automation.
- **Client-declared top-up amount** — the amount-spoofing vulnerability (pay 0.07 CNY, declare 1.00, mint the difference). Fixed reactively; this design makes it structural.
- **No auto-crediting** — the WeChat callback path was Phase 2; crediting required a manual command.
- **Anonymous top-up order** — `wechat start` mints a payer-agnostic order with no buyer binding, so auto-crediting has no one to credit.
- **Scan every purchase** — no "recharge once, spend many" UX.

This design fuses them into one automatic chain: **WeChat funds the balance; the balance spends password-free.**

## 2. What "password-free" actually means here

WeChat Pay's standard merchant API assumes a human scans a QR or confirms in the WeChat app; there is **no autonomous payer product** (unlike Alipay AI Pay). So a truly signature-free per-transaction WeChat charge is impossible.

The honest, shippable interpretation:

> **The FIRST purchase that finds an empty/low balance requires one scan** — but that scan buys a *pack* (e.g. 20.00), not a single item. Every subsequent purchase deducts from the balance **with no scan, no password, no per-tx confirm**, until the balance drops below the next price and one more scan tops it up.

"免密" = prepaid balance + scan-free spend. Set expectations accordingly in UX copy.

## 3. Architecture fit

The fused flow adds **no new rail** — it choreographs the two existing rails:

```
             fund (scan once)                spend (免密, N times)
  WeChat Native  ─────────────►  Balance ledger (CNY)  ─────────────►  paid service
  (funding entry)                (spending exit)
```

- **Balance rail** owns the 402 decision and the deduction (pure verify + atomic settle, already immune to the double-charge class).
- **WeChat rail** owns order creation, callback decryption/verification, and order-query — reused as a **funding source**, not a per-tx charger.
- The only genuinely new server surface: a **top-up order endpoint** and a **callback endpoint**; everything else is reuse.

## 4. Sequence

### 4.1 The unified 402 decision (balance-first)

```
Buyer requests a paid service
   │  402 → accepts[] = [ balance (CNY), wechatpay-native, ... ]
   ▼
Client (buyer_id configured): GET /balance?buyer_id
   │
   ├─ balance ≥ price ──► X-Payment { scheme:"balance", buyer_id, request_id }
   │                      /execute: verify(funds) → settle(atomic deduct, idempotent/request_id) → deliver   ✅ [免密, no QR]
   │
   └─ balance < price ──► top-up pack (the only scan branch)
        POST /balance/topup/order { buyer_id, pack? }             ← NEW
          · pick pack (default_pack; enforce ≤ auto_topup_max)
          · WeChat Native order, attach = { buyer_id, nonce }, reuse pending-order cache (key = buyer_id + pack)
          · return { code_url, out_trade_no, pack }
        → render QR once, human scans & pays
        ┌─ WeChat POST notify_url ─► decrypt(apiv3) + verify(platform cert) ─┐
        │                                                                     ├─► atomic credit payer_total (fen),
        └─ server polls order → trade_state === SUCCESS ────────────────────┘    idempotent on wechat:<out_trade_no>,
                                                                                  attach.buyer_id → correct wallet
        → client auto-retries the original request → balance ≥ price → deduct → deliver   ✅
        → subsequent purchases take the "免密, no QR" branch until balance < next price
```

### 4.2 Client-side state machine (auto-retry)

```
PAY(service):
  q = GET /balance?buyer_id
  if q.balance >= price:
      return deductAndExecute(request_id = uuid())          # 免密
  else:
      pack = choose(default_pack, price, auto_topup_max)
      o = POST /balance/topup/order {buyer_id, pack}
      renderQR(o.code_url)
      awaitCredit(o.out_trade_no)   # poll GET /balance until credited, or SSE/callback signal; bounded by order time_expire
      if credited && balance >= price:
          return deductAndExecute(request_id = uuid())      # 免密 from here on
      else:
          surface timeout / underpaid / cancelled
```

`awaitCredit` polls `GET /balance?buyer_id` (cheap) rather than the WeChat order directly, so the client observes the *ledger* result regardless of which crediting path (callback vs server-poll) won.

## 5. Configuration

`moltspay.services.json` — additive, all opt-in:

```jsonc
"provider": {
  "balance": {
    "currency": "CNY",                    // was effectively USD; CNY makes WeChat fen 1:1 with the ledger
    "db_path": "/abs/path/to/balance.sqlite",
    "single_limit": "50.00",              // per-deduction ceiling (yuan)
    "daily_limit": "200.00",              // per-buyer per-day (yuan)
    "topup_packs": ["20.00", "50.00"],    // NEW: offered recharge amounts (yuan)
    "default_pack": "20.00",              // NEW: pack chosen when the client doesn't specify
    "auto_topup_max": "50.00"             // NEW: max amount the client may auto-topup without human pack selection
  },
  "wechat": {
    "mchid": "...", "appid": "...", "serial_no": "...",
    "private_key_path": "/abs/apiclient_key.pem",
    "notify_url": "https://<host>/wechat/notify",   // MUST resolve publicly for the callback path
    "platform_public_key_path": "/abs/wechat_platform_cert.pem",  // REQUIRED for callback verify
    "apiv3_key": "<32-byte apiv3 key>"              // REQUIRED for callback decrypt
  }
}
```

Notes:
- `currency: "CNY"` is the pivot: ledger unit becomes **fen**, and WeChat `payer_total` credits 1:1. Service prices that fund via WeChat should be authored in CNY (yuan strings).
- The callback path **requires** `apiv3_key` + `platform_public_key_path`. Without them, only the polling-fallback path is available (still safe, just higher latency).

## 6. Server integration (`src/server/index.ts`)

### 6.1 New: `POST /balance/topup/order`
Create a buyer-bound WeChat Native top-up order.
- Body: `{ buyer_id, pack? }`. Resolve `pack` → must be in `topup_packs` (or ≤ `auto_topup_max`); else 400.
- Call `wechatFacilitator.createPaymentRequirements({ priceCny: pack, description, attach: { buyer_id, nonce }, outTradeNo })`.
- Reuse the existing pending-order cache, **re-keyed to `sha256(buyer_id | pack)`** (buyer funds a pack, not a service+params tuple), so concurrent requests for the same buyer+pack share one in-flight order — the double-charge protection carries over.
- Return `{ code_url, out_trade_no, pack, expires_at }`.

### 6.2 New: `POST /wechat/notify` (the `notify_url` target)
Authoritative auto-credit.
1. Read `Wechatpay-Timestamp/Nonce/Signature/Serial` headers; verify signature against the platform cert (`timestamp\nnonce\nbody\n`). Reject on mismatch → 401.
2. Decrypt `resource` with apiv3 key (**AES-256-GCM**: key + nonce + associated_data + auth tag).
3. Parse the decrypted order: `out_trade_no`, `trade_state`, `amount.payer_total`, `attach`.
4. `trade_state === 'SUCCESS'` → read `buyer_id` from `attach` → **atomic credit** `amount.payer_total` fen, idempotent on `wechat:<out_trade_no>`.
5. Respond `{ code: "SUCCESS" }` (ack) even on a duplicate (idempotent), so WeChat stops retrying.

### 6.3 Polling fallback
The SDK session already polls the order; when the server observes `SUCCESS` for a top-up order it performs the **same** `credit(payer_total, wechat:<out_trade_no>, attach.buyer_id)`. Because both paths key on `out_trade_no`, whichever arrives first wins and the other is a no-op.

### 6.4 Existing `POST /balance/topup` (manual)
Kept for operator/recovery use, already hardened to credit `payer_total` only (never the client-declared amount). Documented as a fallback, not the primary path.

### 6.5 `/execute` dispatch (unchanged)
`scheme === 'balance'` → `handleBalanceExecute` (verify funds → atomic deduct → run skill → refund on failure). The fused flow changes *how the balance got funded*, not how it is spent.

## 7. Facilitator changes

`src/facilitators/wechat.ts`:
- `createPaymentRequirements(opts)` gains `attach?: Record<string,string>` → passed through to the Native order body (WeChat echoes `attach` back in the order query and callback).
- New `decryptCallback(headers, rawBody)`: platform-cert signature verify + apiv3 AES-256-GCM decrypt → typed order object. Pure-ish (crypto only, no network).
- `verify()`/`settle()` unchanged (still order-query based).

`src/facilitators/balance.ts`:
- Single crediting entry `credit({ buyerId, amountFen, externalRef, description })`, idempotent on `externalRef`. Both callback and poll paths call it.
- Ledger currency-aware formatting (CNY): `fromFen`/`toFen` replace the USD-cent helpers when `currency === "CNY"` (still integer minor units, 1:1).

## 8. SDK client / CLI

- `MoltsPayClient`:
  - `pay()` — when a 402 offers `balance` and a `buyer_id` is configured: balance-first; on insufficient funds, auto-create a top-up order, surface the QR via the existing session hooks, await credit, auto-retry. New hooks `onTopupRequired(pack, codeUrl)`, `onTopupCredited(balance)`.
  - `topupBalancePack(opts)`, `getBalance(buyerId)`, `listBalanceTransactions(buyerId)`.
- CLI:
  - `moltspay pay <server> <service>` — password-free when balance suffices; otherwise prints the pack QR, waits, then completes. One command, no `out_trade_no` plumbing.
  - `moltspay balance topup --pack 20` — explicit pack top-up.
  - `moltspay balance` — balance + limits + today's spend.

## 9. Security

1. **Amount integrity (structural)** — only `payer_total` from a **verified** source credits: callback (decrypt + platform-cert verify) or order-query (`trade_state === SUCCESS`). Client-declared amounts never touch the ledger. This closes the spoofing class by construction, not by check.
2. **Buyer binding trust** — `attach.buyer_id` is set server-side at order creation and echoed by WeChat; the callback credits whatever `attach` says. Since the server minted `attach`, it is trustworthy for the callback path. (Do **not** let a client pass an arbitrary `buyer_id` into an *already-paid* order after the fact.)
3. **`buyer_id` is a bearer identifier** — whoever holds it spends the balance. Password-free means balance sits pre-funded, enlarging the blast radius. **Recommendation: promote signed buyer tokens (Phase 2 in `BALANCE-RAIL-DESIGN.md`) to a fast-follow**, at least gating `POST /balance/topup/order` and deductions.
4. **`auto_topup_max`** — bounds how much a (possibly compromised) client can pull from the user's WeChat without an explicit human pack choice. Amounts above it require deliberate `--pack` selection.
5. **Limits** — single/daily deduction limits stay enforced on the spend side.
6. **Public callback dependency** — `/wechat/notify` must be reachable over public HTTPS. The 2026-07-11 test found nginx returning 404 for `/balance` on the old GCE host; **verify nginx forwards `/wechat/notify` and `/balance*` before relying on the callback path** (polling-fallback covers the gap meanwhile).
7. **Refund direction** — skill failure refunds to the **balance**, never back to WeChat (matches existing `refund`).
8. **Replay / duplicate credit** — callback + poll may both fire; `out_trade_no` idempotency de-dupes. WeChat retries the callback until acked; always return `SUCCESS` on a duplicate.

## 10. Edge cases

| Case | Handling |
|---|---|
| User scans but underpays / overpays | Credit exactly `payer_total`; never the requested pack. Ledger reflects reality. |
| Order expires before payment | `time_expire` lapses; no credit; client surfaces timeout and may re-issue a pack. |
| Callback arrives after poll already credited | Idempotent no-op; ack `SUCCESS`. |
| Callback never arrives (network) | Polling-fallback credits on next `SUCCESS` observation. |
| Concurrent 402s for same buyer+pack | Pending-order cache shares one in-flight order (double-charge safe). |
| Balance just below price after credit (underpaid) | Deduction `verify` fails (insufficient); client re-prompts a top-up. |
| Server restart mid-flow | In-memory pending cache lost → at worst one extra *unpaid* order expires server-side; credited balances are durable in SQLite. |

## 11. Storage

- SQLite via `node:sqlite` (Node ≥ 22.5 when the balance rail is enabled), WAL mode, integer minor units (fen for CNY).
- Transactions table records `topup` (with `external_ref = wechat:<out_trade_no>`, `payer_total`, `attach.buyer_id`) and `deduct` (with `request_id`) rows — fully auditable, reconcilable against WeChat by `out_trade_no`.

## 12. Phasing

- **Phase 1 (core fused flow)** — CNY ledger, `topup_packs`/`default_pack`/`auto_topup_max`, `POST /balance/topup/order` with `attach` binding, **polling-fallback crediting**, client balance-first + auto-topup + auto-retry, CLI. Ships the UX end-to-end without depending on public callback wiring.
- **Phase 2 (authoritative callback)** — `POST /wechat/notify`, apiv3 decrypt + platform-cert verify, nginx wiring verified. Callback becomes primary; polling stays as fallback.
- **Phase 3 (hardening)** — signed buyer tokens gating topup/deduct; limit-management surface; optional FX ledger if a USD-denominated deployment is needed later.

## 13. File change list

| Layer | File | Change |
|---|---|---|
| Schema | `schemas/moltspay.services.schema.json` | `balance.currency` CNY support; `topup_packs`/`default_pack`/`auto_topup_max` |
| Facilitator | `src/facilitators/wechat.ts` | `attach` passthrough; `decryptCallback` (apiv3 + platform-cert) |
| Facilitator | `src/facilitators/balance.ts` | `credit()` single entry; CNY (fen) helpers |
| Server | `src/server/index.ts` | `POST /balance/topup/order`; `POST /wechat/notify`; polling-fallback credit; pending-cache re-key |
| Client | `src/client/wechat/index.ts`, client balance logic | balance-first `pay()`; auto-topup + auto-retry; `onTopupRequired`/`onTopupCredited` |
| CLI | `src/cli/index.ts` | `pay` passwordless UX; `balance topup --pack`; `balance` view |
| Tests | `test/server/`, `test/facilitators/` | topup-order binding; callback decrypt/verify; poll vs callback idempotency; auto-retry; amount integrity (extends the existing spoofing regression) |
| Docs | this file; `CHANGELOG.md` [2.3.0]; `README.md` balance section | — |

## 14. Open items

- **Signed buyer tokens**: strongly recommended before wide password-free rollout (bearer `buyer_id` is the main residual risk).
- **nginx**: confirm `/wechat/notify` + `/balance*` forward correctly on the current host (Tencent Cloud 硅谷 `43.162.105.191`, post-migration) before enabling callback-primary.
- **Pack UX**: whether to let channels present multiple packs to the user or always auto-pick `default_pack`.

## 15. Implementation change path

Concrete, code-grounded, bottom-up. Change on `feature/balance`. Each step has a verification gate; do not proceed until it passes. Ships in three phases; Phase 1 is end-to-end without any public callback.

### Key finding: `sat` is already `fen` — no money-math change

`toSat("20.00")` in `src/facilitators/balance/ledger.ts:115` returns `2000` (`whole*100 + frac`), and WeChat `payer_total` for ¥20.00 is `2000` fen. The ledger's minor unit (`*_sat`) is "1/100 of the quote currency" — **cents for USD, fen for CNY** — so `payer_total` maps to `amount_sat` **1:1 with no FX**. The already-shipped fix (`amountSat = paidFen`) is correct as-is. Switching to CNY is therefore a **label change**, not an accounting change. The only real risk is re-interpreting an existing USD ledger as CNY (same `7` sat means `$0.07` vs `¥0.07`) — hence the P0 guard.

### P0 — Ledger currency guard (`src/facilitators/balance/ledger.ts`)

Prevents opening a USD ledger under a CNY config (or vice versa).
- Add `CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)` in the init block (near `ledger.ts:154`).
- `BalanceLedger` takes `currency`; on first init write `ledger_meta('currency', <currency>)`; if a row exists and differs, **throw** (`ledger currency mismatch: db=<X> config=<Y>`).
- `BalanceFacilitator` (`balance.ts:99`) passes `this.currency` through.
- **Gate**: USD db + CNY config -> startup error; empty db + CNY -> `ledger_meta.currency='CNY'`. Production switch is an ops action (new `db_path` for CNY, freeze the old USD db); code only enforces the guard.

### P1-1 — Schema (`schemas/moltspay.services.schema.json`)

- Allow `provider.balance.currency: "CNY"`.
- Add `topup_packs` (array of amount strings, minItems 1), `default_pack` (string, must be in `topup_packs`), `auto_topup_max` (string, >= max pack).
- **Gate**: `moltspay validate` passes for old and new configs; missing/out-of-set `default_pack` fails.

### P1-2 — Unified credit entry (`src/facilitators/balance.ts`)

- Wrap the existing `ledger.topup()` (`ledger.ts:304`, already idempotent on `external_ref`) as `credit({ buyerId, amountSat, externalRef, description })` so callback / poll / manual paths share one entry.
- **Gate**: unit test — same `externalRef` credited twice returns `replayed:true`, balance unchanged.

### P1-3 — WeChat `attach` passthrough (`src/facilitators/wechat.ts:124`)

- `createPaymentRequirements(opts)` accepts `attach?: Record<string,string>`; serialize into the Native order `body.attach` (`wechat.ts:145`) as JSON (<=128 bytes). WeChat echoes `attach` in order-query and callback; parse with `JSON.parse`.
- **Gate**: unit test — order created with attach; mocked gateway echoes it; `buyer_id` parsed back.

### P1-4 — Server: top-up order + polling-fallback credit (`src/server/index.ts`)

- New `POST /balance/topup/order` (route block near `index.ts:673`, mirror `/balance/topup`): validate `pack in topup_packs || pack <= auto_topup_max` (else 400); call `wechatFacilitator.createPaymentRequirements({ priceCny: pack, description, attach: { buyer_id, nonce } })`; reuse `wechatPendingChallenges` (`index.ts:288`) **re-keyed to `sha256(buyer_id|pack)`**; return `{ code_url, out_trade_no, pack, expires_at }`.
- Polling fallback: when a session poll observes a top-up order `SUCCESS`, extract `attach.buyer_id` + `payer_total` and call `credit(externalRef = "wechat:" + out_trade_no)`. Factor the `payer_total` extraction out of the existing `handleBalanceTopup` (`index.ts:1484`) into a shared helper.
- **Gate**: integration test (stubbed gateway) — order -> mock SUCCESS -> poll -> `GET /balance` reflects `payer_total`, credited to the correct buyer.

### P1-5 — Client orchestration (`src/client/wechat/index.ts` + client `pay()`)

- `pay()`: when a 402 offers `balance` and a `buyer_id` is set, `GET /balance`; if sufficient, deduct (password-free); else pick a pack, `POST /balance/topup/order`, surface the QR via the existing session hooks, poll `GET /balance` until credited or the order expires, then auto-retry the original request.
- Add hooks `onTopupRequired(pack, codeUrl)` / `onTopupCredited(balance)`.
- **Gate**: client test — sufficient balance -> no QR; insufficient -> one QR -> credited -> auto-retry succeeds.

### P1-6 — CLI (`src/cli/index.ts`)

- `moltspay pay`: transparent password-free when funded; otherwise print the pack QR, wait, complete — no manual `out_trade_no`.
- `moltspay balance topup --pack 20`; `moltspay balance` (balance + limits + today's spend).
- **Gate**: CLI smoke — one `pay` runs "first top-up -> subsequent password-free".

### P1-7 — Tests (`test/`)

- Extend `test/server/wechat-balance-topup.test.ts` to cover `topup/order`, polling credit, `attach` binding, pack validation, and client auto-retry.
- **Gate**: `npm run test:run` new cases green; the 11 pre-existing unrelated failures do not grow.

**Phase 1 exit**: `typecheck` + tests green + `build` + local (`127.0.0.1:8402`) end-to-end "scan once, then password-free".

### Phase 2 — Authoritative callback

1. Verify nginx forwards `/wechat/notify` + `/balance*` on Tencent Cloud `43.162.105.191` (the 2026-07-11 report saw `/balance` 404 on the old host).
2. `decryptCallback(headers, rawBody)` in `wechat.ts` / `wechat/sign.ts`: platform-cert signature verify + apiv3 **AES-256-GCM** decrypt.
3. `POST /wechat/notify`: verify -> decrypt -> on `SUCCESS`, `credit(payer_total, "wechat:"+out_trade_no, attach.buyer_id)` -> ack `{code:"SUCCESS"}` (idempotent on duplicates; callback vs poll de-duped by `out_trade_no`).
- **Gate**: callback-first credits; poll-after is a no-op; results identical.

### Phase 3 — Hardening

Signed buyer tokens gating `topup/order` and deductions; operator-tunable `auto_topup_max`; optional FX ledger only if a USD deployment is later required.

### Execution order (TL;DR)

```
P0   ledger_meta + currency guard
P1-1 schema: CNY + topup_packs/default_pack/auto_topup_max
P1-2 balance.ts: unified credit()
P1-3 wechat.ts: attach passthrough
P1-4 server: POST /balance/topup/order + polling-fallback credit + cache re-key
P1-5 client: balance-first + auto-topup + auto-retry + hooks
P1-6 cli: passwordless pay + balance topup --pack + balance view
P1-7 tests                                            -> Phase 1 exit
P2   nginx check -> decryptCallback -> POST /wechat/notify
P3   signed buyer tokens + limits
```

## 16. Recoverable top-up for chat channels (topup-order / topup-confirm)

**Added 2026-07-12 (target 2.5.0).** Splits the blocking auto-topup into a recoverable, non-blocking `topup-order` + `topup-confirm` pair, mirroring the WeChat rail's `start`/`status`/`fulfill` sessions.

### Why

The 2.3 auto-topup (`pay --rail balance`, `balance topup-pack`) is a **single blocking command**: create the pack order, then poll `/balance/topup/confirm` for up to ~5 minutes until the scan credits, then retry. Fine at a terminal; broken in a **turn-based agent** channel.

The SDK's Discord/WebChat path is **openclaw running the CLI** (openclaw is the agent in the channel and executes `moltspay` commands per the skill; the standalone `moltspay-discordbot` is an unrelated bot, out of scope). openclaw is turn-based: it shows the QR, ends the turn, and cannot hold a 5-minute foreground command across the human scan (exec tools time out). So it degrades to "show QR -> end turn -> user says 已支付 -> re-run" -- but the balance path had **no confirm-by-out_trade_no command**, so the agent improvised with "已支付" wording and often re-issued a fresh order (new QR), losing the association. The WeChat per-tx rail already solved this with recoverable sessions; the balance-topup path never got it.

### Server: no change

Both endpoints already exist (see §6.1/§6.2) and are the right shape. `POST /balance/topup/confirm` is already a **single-shot check** (`{credited:true,...}` vs `{credited:false,pending:true,reason}`), idempotent on `wechat:<out_trade_no>`. So this is a pure client/CLI packaging change.

### SDK (`src/client/node/index.ts`)

Split the blocking `topupBalancePack()` into two composable, non-blocking methods; keep the blocking one as a terminal wrapper built on them:

```ts
createBalanceTopupOrder(serverUrl, { pack?, buyerId?, context? })
  -> { outTradeNo, codeUrl, pack, maxTimeoutSeconds }   // create + persist session, return at once
confirmBalanceTopup(serverUrl, outTradeNo, { buyerId? })
  -> { credited, pending?, balance?, txId?, reason? }    // one-shot, no loop; updates session on credit
topupBalancePack(...)   // re-implemented = create + poll(confirm) until credited/expired (unchanged signature)
```

`payViaBalance()` keeps blocking auto-topup as default and gains `--topup-mode manual` (§ below).

### Session persistence (`<configDir>/balance-topup-sessions`)

Mirror `<configDir>/wechat-sessions`. On `createBalanceTopupOrder`, persist a JSON session so `topup-confirm` (and an agent that only kept the `out_trade_no`) can recover across turns / restarts:

```json
{ "out_trade_no": "WX...", "buyer_id": "<id>", "pack": "2.00", "server_url": "...",
  "code_url": "weixin://...", "status": "pending|credited|expired",
  "created_at": "ISO", "expires_at": "ISO",
  "context": { "channel": "discord", "user_id": "...", "service": "ping" } }
```

Recoverable by `out_trade_no`; `confirm` flips `status`. Client-side recovery state only (server's in-memory cache is unaffected).

### `pay --rail balance` non-blocking mode

- `--topup-mode auto` (default, unchanged): block through topup + retry (terminal).
- `--topup-mode manual`: on insufficient balance, **create the order, surface the QR + out_trade_no, and return a `topup_required` result without polling** -- the agent confirms + retries in later turns.

`--json` result: `{ "status": "topup_required", "out_trade_no": "WX...", "code_url": "weixin://...", "pack": "2.00", "server_url": "..." }`.

### CLI (`src/cli/index.ts`) -- mirrors `wechat start/status/...`

| Command | Behavior |
|---|---|
| `balance topup-order <server> [--pack] [--buyer]` | Create order, emit `MEDIA:` QR PNG + terminal QR + `out_trade_no`, persist session, **exit immediately**. |
| `balance topup-confirm <out_trade_no> [--buyer] [--wait <s>]` | Confirm once (default) or bounded-poll for `--wait` seconds; prints credited/balance or "not paid yet". |
| `balance topup-status <out_trade_no>` | Read the persisted session (status/pack/expiry) without hitting the gateway. |
| `balance topup-list` | List persisted balance-topup sessions. |

`balance topup-pack` (blocking) stays as the terminal one-shot wrapper.

### Agent / Discord flow (openclaw)

```
insufficient balance
  -> `pay --rail balance --topup-mode manual`  (or `balance query` -> low -> `balance topup-order`)
  -> topup_required + out_trade_no + code_url
     -> render QR as a Discord image ATTACHMENT (better than a /tmp path), remember out_trade_no, END TURN
  -> user scans, pays, says "已支付"
  -> `balance topup-confirm <out_trade_no>`   (credited -> continue; pending -> tell user, keep waiting)
  -> `pay --rail balance`  -> password-free -> deliver
```

"已支付" now maps to a real `topup-confirm`, and the QR is never re-minted by accident (same `out_trade_no`).

### Skill updates

Add the recoverable commands to the table + a "balance top-up in a chat channel" section parallel to the WeChat `start/status/fulfill` one: on insufficient balance use `topup-order` (show the QR attachment, end the turn); on "已支付" run `topup-confirm <out_trade_no>` then `pay --rail balance` -- never re-issue a new order just because the user says paid. Reuse the WeChat QR-handling rules.

### Backward compatibility & scope

Additive only: server unchanged; `topupBalancePack` / `pay --rail balance` defaults unchanged (still blocking for terminal use); new SDK methods, new CLI subcommands, `--topup-mode manual`, and a new session directory. Out of scope: server callback (`/wechat/notify`, Phase 2), auto-detect without a confirm step, the standalone `moltspay-discordbot`.

### Implementation plan

| Step | File | Change |
|---|---|---|
| 1 | `src/client/node/index.ts` | `createBalanceTopupOrder()` + `confirmBalanceTopup()`; re-implement `topupBalancePack()` on top; `--topup-mode manual` path in `payViaBalance()`. |
| 2 | client session store | `<configDir>/balance-topup-sessions` read/write (mirror `wechat-sessions`). |
| 3 | `src/cli/index.ts` | `balance topup-order` / `topup-confirm` / `topup-status` / `topup-list`; `pay --topup-mode`. |
| 4 | Tests | order-then-confirm (stubbed gateway): pending -> credited; idempotent confirm; session persisted + recovered by out_trade_no; `pay --topup-mode manual` returns `topup_required`. |
| 5 | Docs | `moltspay-skill` recoverable balance section; `CHANGELOG.md` [2.5.0]; README. |

---
*Authored 2026-07-12. Decisions locked: CNY ledger (1:1 fen), fixed top-up packs, callback-primary + polling-fallback. Section 16 (recoverable top-up) added 2026-07-12 for 2.5.0.*
