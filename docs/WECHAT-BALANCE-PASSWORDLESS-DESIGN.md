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

---
*Authored 2026-07-12. Decisions locked: CNY ledger (1:1 fen), fixed top-up packs, callback-primary + polling-fallback.*
