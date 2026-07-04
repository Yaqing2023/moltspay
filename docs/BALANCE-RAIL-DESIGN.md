# Password-Free Payment (Custodial Balance Rail) — Design

> **Status (2026-07-04)**: **Implemented** on the `2.2.0` code path — see the "SDK integration design" section at the end of this document for the shipped shape (x402 `balance` scheme, `BalanceFacilitator`, `provider.balance` config, `/balance` endpoints, `pay --rail balance`). Originally this document was migrated from a standalone design (`webchatpay-design.md`) written for an **independent WebchatPay service (port 4402) — that route was abandoned** in favor of unifying the rail into the MoltsPay SDK as a third payment mode alongside crypto (per-transaction signing) and the fiat QR rails (Alipay/WeChat, per-transaction scan-to-pay). The data model, API semantics, and security design below remain valid as background; where the historical sections disagree with the "SDK integration design" section, the latter is authoritative. See also `README.md` § "Balance Rail (Password-Free Payments)" and `CHANGELOG.md` [2.2.0].

## Goal

Let a user top up once, then have subsequent purchases auto-deducted — no signing or password entry per transaction. The experience mirrors Alipay's password-free payment (免密支付).

---

## Core architecture

```
User → webchat → Zen7 Agent
                      ↓
                 Balance API (balance check / deduct)
                      ↓
                 Balance service (SQLite)
                      ↓
                 Top-up entry points (USDC / Alipay)
```

User funds are custodied server-side at all times. The agent calls an internal API to deduct from the balance — no on-chain transaction, no user signature required.

---

## Data model

### `users` table
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,              -- UUID
  webchat_session_id TEXT UNIQUE,   -- OpenClaw session ID
  display_name TEXT,
  deposit_address TEXT,             -- USDC deposit address (Base)
  alipay_user_id TEXT,              -- Alipay binding (optional)
  balance_sat INTEGER DEFAULT 0,    -- balance in cents (1 USDC = 100)
  total_topup_sat INTEGER DEFAULT 0,
  total_spent_sat INTEGER DEFAULT 0,
  daily_limit_sat INTEGER DEFAULT 1000,   -- daily limit: 10 USDC
  single_limit_sat INTEGER DEFAULT 500,   -- per-transaction limit: 5 USDC
  status TEXT DEFAULT 'active',          -- active / frozen / banned
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### `transactions` table
```sql
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,              -- UUID
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,                -- topup / deduct / refund
  amount_sat INTEGER NOT NULL,       -- positive integer
  service TEXT,                      -- text-to-video / image-to-video / etc
  description TEXT,
  tx_hash TEXT,                      -- on-chain tx (top-up)
  alipay_trade_no TEXT,              -- Alipay order number (top-up)
  status TEXT DEFAULT 'completed',  -- pending / completed / failed / refunded
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### Design notes
- Amounts are integers (sat = cent) to avoid floating-point precision issues
- Every transaction has its own record — fully auditable
- Limits are configurable, defaults are conservative (5 USDC per transaction, 10 USDC per day)

---

## API design

### Infrastructure
- Service: standalone Node.js process, port 4402 *(superseded — hosts inside `MoltsPayServer` per the status note above)*
- Storage: SQLite
- Auth: webchat session ID as the identity key

### Endpoints

#### 1. Query balance
```
GET /balance?session_id=<webchat_session_id>

Response:
{
  "balance": 3.99,        // USDC
  "daily_limit": 10.00,
  "single_limit": 5.00,
  "today_spent": 0.00
}
```

#### 2. Deduct (called by the agent)
```
POST /deduct
{
  "session_id": "<webchat_session_id>",
  "amount": 3.99,
  "service": "text-to-video",
  "description": "prompt: a dragon flying over mountains"
}

Response (success):
{ "success": true, "tx_id": "xxx", "balance": 0.00 }

Response (insufficient balance):
{ "success": false, "error": "insufficient_balance", "balance": 1.50, "required": 3.99 }

Response (over limit):
{ "success": false, "error": "exceeds_limit", "limit_type": "single", "limit": 5.00 }
```

#### 3. Top-up (USDC, on-chain)
```
POST /topup
{
  "session_id": "<webchat_session_id>",
  "tx_hash": "0xabc...",
  "amount": 10.00,
  "chain": "base"
}

→ server verifies the on-chain transaction → credits the balance
```

#### 4. Top-up (Alipay)
```
POST /topup/alipay
{
  "session_id": "<webchat_session_id>",
  "trade_no": "2026...",
  "amount": 10.00
}

→ server verifies the Alipay callback → credits the balance
```

#### 5. Refund
```
POST /refund
{
  "tx_id": "<original transaction ID>",
  "reason": "service_failed"
}
```

#### 6. Transaction history
```
GET /transactions?session_id=<id>&limit=20&offset=0
```

---

## Top-up flows

### Option 1: USDC on-chain top-up

1. On first interaction, the backend generates a dedicated Base deposit address (HD-wallet derived)
2. Show the address + QR code to the user
3. Backend polls (or uses a webhook) for the incoming transfer
4. On confirmation, credit the balance and notify the user

```
User:  "Generate a video"
Agent: checks balance → 0
Agent: "Insufficient balance, please top up. Your dedicated deposit address:
       0xABC... (USDC on Base)
       Let me know once you've sent it and I'll confirm."
User:  [transfers 10 USDC]
User:  "Done"
Agent: [calls /topup to verify the tx] → credited → "10 USDC received, generating your video!"
```

### Option 2: Alipay top-up (via the existing skill)

1. Agent calls the Alipay skill to generate a collection QR code
2. User scans and pays
3. Alipay callback → backend credits the balance
4. Or: user reports the order number → backend verifies → credits

### Option 3: Quick top-up (users who already have a wallet)

1. User already has a MetaMask/Coinbase wallet
2. The webchat frontend opens wallet connect
3. User signs a USDC transfer to the custodial address
4. Backend detects the transfer → credits the balance

---

## Agent integration (core flows)

### Purchase flow (agent side)

```
User: "Generate a video of a dragon flying over mountains"

→ Agent calls GET /balance?session_id=xxx
← { "balance": 5.00, ... }

→ Balance sufficient; agent deducts first
→ Agent calls POST /deduct
   { "session_id": "xxx", "amount": 3.99, "service": "text-to-video" }
← { "success": true, "tx_id": "abc", "balance": 1.01 }

→ Deduction succeeded; run video generation
→ [video_gen skill generates the video]

→ Return the video to the user
→ "Your video is ready! Charged 3.99 USDC, 1.01 remaining."
```

### Insufficient balance

```
→ Agent calls GET /balance
← { "balance": 1.00 }

→ Agent: "Balance is 1.00, not enough for video generation (needs 3.99).
   Deposit address: 0xABC... (Base USDC)
   Or scan this Alipay QR to top up [QR code]
   Let me know once done."
```

### Refund on service failure

```
→ Deduction succeeded → video generation failed
→ Agent calls POST /refund { "tx_id": "abc", "reason": "video_gen_failed" }
← { "success": true, "balance": 5.00 }
→ Agent: "Video generation failed — refunded 3.99 USDC."
```

---

## Security design

### 1. Spending limits
- Per-transaction limit: 5 USDC by default, adjustable
- Daily cumulative limit: 10 USDC by default, adjustable
- Deductions over the limit are rejected and the user is notified

### 2. Atomic deduction
```sql
-- balance check + deduction in a single transaction
BEGIN;
UPDATE users SET balance_sat = balance_sat - 399
  WHERE id = ? AND balance_sat >= 399 AND status = 'active';
-- affected_rows = 0 → insufficient balance or abnormal status
COMMIT;
```

### 3. Replay protection
- Every deduction has a unique tx_id (UUID)
- The agent only runs the service after receiving `success`
- Service failure → automatic refund

### 4. Auditing
- All transaction records are kept permanently
- Queryable by user, time, and type
- Periodic reconciliation (on-chain top-ups vs balance changes)

### 5. User identity binding
- The webchat session_id is the primary identity
- Optional binding to a phone number / Alipay account for cross-device recognition
- Deposit addresses are bound per user to prevent cross-crediting

---

## Integration with existing systems

### video_gen skill

Add a payment pre-check to the existing skill:

```javascript
// Existing flow: generate the video directly
// New flow: deduct first → then generate

async function handleVideoRequest(sessionId, prompt) {
  // 1. Check balance
  const balance = await balancePay.getBalance(sessionId);
  if (balance < 3.99) {
    return { error: 'insufficient_balance', ... };
  }

  // 2. Deduct
  const deduct = await balancePay.deduct(sessionId, 3.99, 'text-to-video');
  if (!deduct.success) {
    return { error: deduct.error, ... };
  }

  // 3. Generate the video
  try {
    const video = await generateVideo(prompt);
    return { success: true, video, balance: deduct.balance };
  } catch (e) {
    // 4. Refund on failure
    await balancePay.refund(deduct.tx_id, 'video_gen_failed');
    return { error: 'generation_failed', refunded: true };
  }
}
```

### OpenClaw Agent (SOUL.md / AGENTS.md)

Agent behavior changes:
- On a video request → check balance → sufficient → deduct → generate → return
- Insufficient balance → guide the user to top up → wait for confirmation → continue
- Boss (Zen7) → whitelisted, skips deduction

### Alipay skill reuse

The top-up path reuses the existing Alipay skill:
- Generate the collection QR code
- Confirm the payment
- No double-spend protection needed (top-up only adds funds)

---

## Implementation plan

### Phase 1: MVP
- SQLite database + core APIs (balance, deduct, top-up, history)
- USDC on-chain top-up (user reports tx_hash → verify → credit)
- Agent integration: deduct before video requests
- Estimated effort: 1–2 days

### Phase 2: Alipay top-up
- Hook into the Alipay skill to generate collection QR codes
- Auto-credit from the Alipay callback
- Estimated effort: 1 day

### Phase 3: Automation
- Automatic on-chain top-up detection (polling/webhook)
- Notify the user when a top-up lands
- Limit-management UI
- Estimated effort: 1–2 days

### Phase 4: Hardening
- Complete the refund flow
- Transaction history query API
- Reconciliation script
- Estimated effort: 1 day

---

## Key decisions

| Decision | Recommended | Alternative | Rationale |
|------|------|------|------|
| Storage | SQLite | PostgreSQL | Small user base; SQLite is enough |
| Amount unit | integer (sat) | float | Avoid precision issues |
| Deposit address | HD-wallet derived | fixed address + memo | Derived addresses distinguish users |
| Limits | server-side hard limits | agent self-discipline | Prevent a bug from over-deducting |
| Refunds | automatic | manual | Service failures should auto-refund |
| Boss free tier | hard-coded whitelist | config file | Simple and direct |

---

## Risks and mitigations

| Risk | Mitigation |
|------|------|
| Custodial fund safety | Multisig wallet / hot-cold separation |
| Agent bug causing wrong deductions | Server-side limits + transaction audit + auto-refund |
| Deposit address leak | Per-user isolated addresses; no cross-impact |
| Service outage | SQLite backups + fast recovery |
| Exit-scam concerns | Transparent reconciliation; users can query their own records |

---

## Relationship to MoltsPay

> **Superseded** — see the status note at the top. The balance layer now lives *inside* the MoltsPay SDK rather than as a standalone upper-layer service. Kept for historical context:

The balance system was originally positioned as an application on top of MoltsPay:
- MoltsPay = on-chain payment infrastructure (signing, settlement, multi-chain)
- Balance service = custodial balance system for the webchat scenario

Users would top up via MoltsPay (on-chain transfer) and spend via the balance service (internal deduction), avoiding an on-chain transaction per purchase.

The original plan noted a future merge — "MoltsPay adds a `/balance` layer supporting custodial balance mode" — with the standalone build chosen for short-term speed. That future merge is now the chosen direction.

---

## SDK integration design (2026-07-04, supersedes the standalone-service sections above)

This section defines how the custodial balance rail lives *inside* the MoltsPay SDK, replacing the standalone port-4402 service. It follows the same shape as the Alipay/WeChat rails (facilitator + provider config + 402 challenge + `/execute` dispatch).

### x402 scheme

- **Scheme**: `balance` — **Network**: `balance` (registered in `src/chains` beside `alipay`/`wechat`, excluded from EVM chain iteration the same way).
- 402 `accepts[]` entry:
  ```json
  {
    "scheme": "balance",
    "network": "balance",
    "asset": "USD",
    "amount": "3.99",
    "payTo": "custodial",
    "maxTimeoutSeconds": 30,
    "extra": { "topup": { "hint": "POST /balance/topup" } }
  }
  ```
  Building this challenge is **pure** (no network call, no order minted) — the double-charge class of bug from the WeChat rail cannot occur here.
- Client `X-Payment` payload:
  ```json
  {
    "x402Version": 1,
    "scheme": "balance",
    "network": "balance",
    "payload": { "buyer_id": "<id>", "request_id": "<uuid>" }
  }
  ```
  `request_id` (client-generated UUID) makes the deduction idempotent: replaying the same request never double-deducts.

### Identity: generic buyer account

`webchat_session_id` generalizes to an opaque **`buyer_id`** — the SDK does not know or care whether it is a webchat session, a device id, or an API key. The `users` table becomes `buyers` (`buyer_id TEXT PRIMARY KEY` replacing `webchat_session_id`). Channel runtimes (webchat/Zen7) map their own session ids to `buyer_id` at the application layer.

> Trust model (MVP): `buyer_id` is a bearer identifier — anyone who presents it can spend that balance. Acceptable for channel-mediated use (the channel runtime holds the id); signed buyer tokens can be added later without schema changes.

### Whitelist / free tier

**Stays in the application layer.** The SDK has no concept of "Boss free" — a channel that wants to skip payment for a user simply doesn't route that request through the paid path.

### Facilitator mapping

`BalanceFacilitator implements Facilitator` (name `balance`), backed by a SQLite ledger:

| Interface method | Balance rail semantics |
|---|---|
| `createPaymentRequirements()` | pure — formats the `accepts[]` entry (no I/O) |
| `verify()` | read-only precheck: buyer exists + `status='active'` + balance ≥ amount + within single/daily limits |
| `settle()` | **the atomic deduction** — single SQL transaction (`UPDATE ... WHERE balance_sat >= ?`), records a `deduct` transaction row, returns its `tx_id` as `transaction`. Idempotent on `request_id`: a replay returns the original `tx_id` without deducting again |
| `refund(txId, reason)` | extra method (not on the interface): reverses a deduct, used by the server on skill failure |
| `healthCheck()` | DB open + `PRAGMA integrity_check` quick form |

**Execution order differs from the QR rails** — deduct *before* running the skill, refund on failure:

```
QR rails:      verify(paid?) → run skill → settle (confirm, fire-and-forget)
Balance rail:  verify(funds?) → settle (atomic deduct) → run skill → [failure → refund]
```

### Server integration

- **Provider config** (`moltspay.services.json`): `provider.balance = { "db_path": "./data/balance.sqlite", "currency": "USD", "daily_limit": "10.00", "single_limit": "5.00" }` — opt-in like `provider.alipay`/`provider.wechat`.
- **Per-service config**: `services[].balance = { "price": "3.99" }` (defaults to the service's USD price when omitted).
- **`/execute` dispatch**: `scheme === 'balance'` → `handleBalanceExecute` (verify → deduct → run → refund-on-failure).
- **Balance management endpoints** (mounted on the same HTTP server, replacing the standalone API):
  - `GET  /balance?buyer_id=` — balance + limits + today's spend
  - `POST /balance/topup` — `{buyer_id, rail: "crypto"|"alipay"|"wechat", tx_hash?|trade_no?|out_trade_no?, amount}`; the server verifies via the corresponding existing facilitator, then credits
  - `POST /balance/refund` — `{tx_id, reason}` (operator/agent use)
  - `GET  /balance/transactions?buyer_id=&limit=&offset=`

### Storage

- SQLite via **`node:sqlite`** (built-in, zero new dependencies). Requires Node ≥ 22.5 **only when the balance rail is enabled** — checked at rail init with a clear error; other rails keep working on Node 18.
- DB file at `provider.balance.db_path`, created on first init with WAL mode.
- Amounts stored as integer cents (`*_sat` columns, 1 USD = 100), matching the original design.

### SDK client / CLI

- `MoltsPayClient`: `getBalance(buyerId)`, `topupBalance(opts)`, `listBalanceTransactions(buyerId)`; `pay()` gains automatic balance-rail selection when the 402 offers `balance` and a `buyer_id` is configured.
- CLI: `moltspay balance [--buyer <id>]`, `moltspay balance topup --rail <r> ...`, `moltspay balance transactions`.

### Out of scope for the MVP (Phase 2+)

HD-wallet per-buyer deposit addresses and automatic on-chain detection; automatic Alipay/WeChat callback crediting (MVP verifies operator/user-reported `tx_hash`/`trade_no`); signed buyer tokens; limit-management UI.
