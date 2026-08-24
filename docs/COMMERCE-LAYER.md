# MoltsPay Commerce Layer

Turn MoltsPay from a payment rail into an **agent commerce layer** — a two-sided
control plane for an AI agent that both **spends** and **earns**:

- **Spend side (buy):** discover, buy, and settle paid services on its own —
  under a programmable budget and approval policy the model **cannot** talk its
  way past.
- **Earn side (sell):** publish its own services to the registry, receive
  payment, and fulfill — under a *symmetric* fulfillment policy and the same
  hash-chained audit.

The two halves **compose but stay orthogonal**: spend controls (budget/approval)
never touch the earn path, and earn controls (fulfillment policy) never touch
spend. A resale/value-add agent runs both — it publishes a service (earn) and,
to fulfill it, buys upstream services (spend) under its task budget.

Built on top of the custodial **balance rail** (`docs/BALANCE-RAIL-DESIGN.md`).
The payment mechanics are unchanged; this layer adds the *control* around them:
per-task budgets, an explainable audit trail, a spend policy, human approval,
and a 402-intercepting middleware.

> Design principle (product doc §13): **budget and approval rules live outside
> the model**. They are enforced in the ledger/facilitator (server-side) and in
> the transport middleware — never left to the agent's discretion.

---

## Spend side (buy) — what it gives you

| Capability | Where it's enforced | Bypassable by the model? |
|---|---|---|
| Per-transaction & daily spend limits | balance ledger (SQLite, atomic) | No |
| **Per-task budget** (cap total spend on a task) | TaskBudgetMeter (SQLite, atomic) | No |
| **Explainable audit trail** (hash-chained) | server, on every payment | No |
| Provider allow/deny list | PolicyEngine (payer side) | No |
| Auto-pay vs human-approval thresholds | PolicyEngine + ApprovalStore | No |
| **402 auto-intercept → pay → retry** | CommerceMiddleware | No |

### Rail coverage — one budget, one audit, across rails

The per-task budget is a **rail-agnostic meter** keyed by `task_id`: whichever
rail pays, the charge reserves against the SAME ceiling, so "budget $5 for this
task" holds across currencies.

| Rail | Per-task budget enforced | Audited |
|---|---|---|
| Custodial balance (prepaid; funded by USDC / WeChat / Alipay top-up) | ✅ | ✅ |
| USDC / crypto direct (x402) | ✅ | ✅ |
| Alipay direct (per-call, CNY) | via balance top-up¹ | ✅ |
| WeChat direct (per-call, CNY) | via balance top-up¹ | ✅ |

¹ Direct **per-call fiat** charges are audited but not summed into a task budget
denominated in a different currency (that needs FX and is out of MVP scope).
The common path — top up the balance with WeChat/Alipay, then spend from it — is
fully budget-enforced, so fiat funds are covered. USDC ≈ USD is treated 1:1.

---

## Earn side (sell) — publish, receive, fulfill

The mirror image of the spend side: instead of governing money going **out**, it
governs value going out and money coming **in**. Same principle — the controls
live outside the model and are enforced server-side, so a seller's agent cannot
talk its way past them either.

| Capability | Status | Where |
|---|---|---|
| **Publish / list** a service to the registry (wallet-signed; no account, no API key) | ✅ done | `moltspay publish` → `POST /registry/publish` |
| **Unpublish** (soft-delete a listing) | ✅ done | `moltspay unpublish` → `DELETE /registry/publish/:id` |
| **Platform hosting — Tier 1 (proxy)**: platform hosts the x402 shell, forwards paid calls to your own API | ✅ done | `moltspay publish --proxy --upstream <api>` |
| **Inbound audit**: every received payment on the same hash-chained trail | ✅ done | `MoltsPayServer.recordCommerceAudit` (`payment_settled` / `payment_refunded`, `provider_id` = you) |
| **Fulfillment policy**: buyer allow/deny, min-price floor, auto-fulfill vs approval | ✅ done (all rails) | `FulfillmentPolicy` (commerce-core) + `provider.fulfillment`; enforced in `MoltsPayServer` before running/charging |
| **Earn-side approval hold**: `require_approval` parks the fulfillment for seller sign-off | ✅ done | `ApprovalStore` (reused) + operator-gated `GET/POST /fulfillment/approvals[/:id/approve\|reject]` |
| Platform hosting — Tier 2/3 (run code / sandbox) | ⏳ planned | `PUBLISH-FLOW-PLAN.md` §6 |

### Symmetry with the spend side

| Spend side (out) | Earn side (in) |
|---|---|
| `PolicyEngine.decide` → `auto_pay` / `require_approval` / `deny` | `FulfillmentPolicy.decide` → `fulfill` / `require_approval` / `deny` |
| provider allow/deny | buyer allow/deny |
| per-transaction ceiling | min-price floor |
| auto-pay below threshold | auto-fulfill below threshold |
| `ApprovalStore` (approve a spend) | `ApprovalStore` (approve a fulfillment) — reused |
| audit `action: payment_settled`, `agent_id` = payer | audit `action: payment_settled`, `provider_id` = you |

Both are **pure functions of config + intent** (no I/O, no model influence), invoked
server-side before value moves — symmetric to the spend-side design principle.

### Earn-side status

- ✅ **Fulfillment policy engine** (`FulfillmentPolicy`) — the reusable decision
  primitive mirroring `PolicyEngine`, with unit tests.
- ✅ **Server enforcement (balance + x402 rails)** — `MoltsPayServer` consults
  `FulfillmentPolicy` **before running or charging** on the custodial balance rail
  (before deduct) and the direct/x402 rail (after verify, before execute/settle;
  buyer identity = the x402 payer). A denied / underpriced request is refused and
  never settled — no refund needed. Denials are written to the audit trail
  (`action: fulfillment_denied`).
- ✅ **Earn-side approval hold** — `require_approval` parks the fulfillment in
  `ApprovalStore` and returns `402 fulfillment_pending_approval`. The seller
  approves/rejects via operator-gated `GET /fulfillment/approvals` and
  `POST /fulfillment/approvals/:id/approve|reject`; a buyer retry with the same
  request_id then proceeds (approved) or gets `403 fulfillment_rejected`. Parked
  requests are audited (`action: fulfillment_pending`).
- ✅ **Direct-fiat rails (Alipay / WeChat)** — gated at the **challenge** stage, not
  the settle path: fiat facilitators have no refund, so by verify time the buyer
  has already paid. The server therefore offers a fiat rail **only when the policy
  would auto-fulfill** the request — deny / require_approval / below-floor withholds
  the Alipay/WeChat entry from the 402 (the buyer falls back to the balance/crypto
  rails, which refuse before charging or hold safely). Crypto entries are never
  affected. Buyer allow/deny is **not** applied to fiat (no persistent payer
  identity at challenge time) — a documented rail limitation.

### Where each check runs (by rail)

| Rail | Enforcement point | buyer allow/deny | min-price | require_approval |
|---|---|---|---|---|
| Custodial balance | before deduct (buyer known) | ✅ | ✅ | ✅ hold |
| Direct / x402 | after verify, before execute/settle (payer known) | ✅ | ✅ | ✅ hold |
| Alipay / WeChat | at challenge, before the gateway order (pre-payment) | ➖ n/a | ✅ withhold | ✅ withhold |

---

## 1. Per-task budget (cross-rail)

A task can be given a total budget; every charge tagged with that `task_id`
`reserve()`s against the **`TaskBudgetMeter`** — one authoritative SQLite store
keyed by `task_id` alone, so spend on a task is capped no matter which rail pays
(USDC, fiat top-up, or balance). The reservation is atomic (check-and-insert in
one transaction); the payer supplies only the `task_id` — it selects *which*
ceiling applies, it can never raise one. Budgets are registered out-of-band by
the operator.

A charge is reserved *before* settlement and **released** if settlement or
delivery fails, so a failed request does not consume budget; releases are
idempotent, so spend→fail→retry cannot inflate the ceiling.

**Register a budget** (operator-gated):
```bash
curl -X POST "$SERVER/balance/task-budget" \
  -H "Authorization: Bearer $OPERATOR_KEY" -H 'Content-Type: application/json' \
  -d '{"buyer_id":"alice","task_id":"research-1","budget":"2.00"}'
```

**Check spend / remaining** (read-only):
```bash
curl "$SERVER/balance/task-budget?buyer_id=alice&task_id=research-1"
# → { "budget":"2.00", "spent":"1.50", "remaining":"0.50" }
```

A charge that would exceed the budget is rejected with `402` /
`code: "exceeds_task_budget"` — even when the wallet balance and daily limit
still allow it.

## 2. Explainable audit trail

Every balance payment is appended to a **hash-chained** audit log so a spend can
be explained after the fact. Each entry covers all of its fields plus the
previous entry's hash; tampering with any field breaks the chain, which
`verify()` detects.

Fields captured (product doc §11): `agent_id`, `task_id`, `session_id`,
`tool_call_id`, `service_id`, `provider_id`, `payment_id`, `receipt_id`,
`amount`, `currency`, `payment_channel`, `result_hash`, `verification_status`,
plus `timestamp` / `hash` / `prev_hash`.

Enable on-disk persistence via config:
```jsonc
"provider": {
  "audit": { "dir": "./audit" }   // audit_<YYYY-MM-DD>.jsonl, hash-chained
}
```

**Query** (operator-gated):
```bash
curl "$SERVER/audit?task_id=research-1" -H "Authorization: Bearer $OPERATOR_KEY"
# → { "integrity_ok": true, "entries": [ { action:"payment_settled", ... } ] }
```

The audit write never blocks the money path — a write failure is logged, not
surfaced, so it can neither hold up a delivery nor trigger a spurious refund.

## 3. Spend policy (commerce-core)

`PolicyEngine` is a pure, model-free decision for one payment intent:

- **provider allow / deny** (deny wins; case-insensitive)
- **per-transaction hard cap** → deny
- **auto-pay vs approval threshold**: below `autoPayBelow` → `auto_pay`,
  otherwise `require_approval`

```ts
import { PolicyEngine } from 'moltspay';

const policy = new PolicyEngine({
  providers: { allow: ['verified'] },
  budgets: { perTransactionSat: 100 },     // 1.00 (integer minor units)
  approval: { autoPayBelowSat: 50 },       // auto-pay under 0.50
});
policy.decide({ amountSat: 49, providerId: 'verified' }); // { action: 'auto_pay' }
policy.decide({ amountSat: 80, providerId: 'verified' }); // { action: 'require_approval' }
policy.decide({ amountSat: 10, providerId: 'unknown'  }); // { action: 'deny', code: 'provider_not_allowed' }
```

## 4. Human approval

`ApprovalStore` parks over-threshold charges for a human and notifies a channel
adapter (Feishu / Discord / web) via `onRequested`. Resolution is idempotent —
a request settles at most once.

```ts
import { ApprovalStore } from 'moltspay';

const approvals = new ApprovalStore();
approvals.onRequested(req => sendFeishuCard(req));   // your channel adapter
// ...later, from the approval UI:
approvals.approve(requestId, 'boss');
```

## 5. 402 enforcement middleware

`CommerceMiddleware` wraps `fetch`. On a `402`, **the middleware — not the
model** — reads the challenge, runs the policy, and then auto-pays, holds for
approval, or refuses; on success it retries the original request with the
payment proof and writes the audit entry. Because the gate lives in the
transport, an agent cannot skip it by "deciding" to pay directly.

```ts
import { CommerceMiddleware, PolicyEngine, ApprovalStore, AuditLog } from 'moltspay';

const mw = new CommerceMiddleware({
  policy: new PolicyEngine({ approval: { autoPayBelowSat: 500 } }),
  approvals: new ApprovalStore(),
  audit: new AuditLog('./audit'),
  executor: myRailExecutor,            // quote() + pay(): rail-specific, injected
  approvalResolver: async req => await askHuman(req),  // optional; else throws ApprovalRequiredError
});

const res = await mw.fetch('https://provider/execute', { method: 'POST', body },
  { taskId: 'research-1', requester: 'agent-1' });
```

Errors: `PaymentDeniedError`, `ApprovalRequiredError` (turn-based), `ApprovalRejectedError`.

---

## CLI

Pay via the balance rail carrying a task scope:
```bash
moltspay pay "$SERVER" text-to-video --rail balance \
  --buyer alice --task research-1 --prompt "a happy cat"
```
`--task` caps the charge under the budget registered for `(buyer, task)`.

## Server endpoints (added by this layer)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/balance/task-budget` | operator | Register / update a per-task budget |
| GET | `/balance/task-budget` | none | Task budget, spent, remaining |
| GET | `/audit` | operator | Query the commerce audit trail (+ integrity check) |
| GET | `/fulfillment/approvals` | operator | List earn-side fulfillments held for sign-off (`?status=pending`) |
| POST | `/fulfillment/approvals/:id/approve` | operator | Approve a held fulfillment; buyer retry then proceeds |
| POST | `/fulfillment/approvals/:id/reject` | operator | Reject a held fulfillment; buyer retry gets `403` |

`/balance/transactions` now also returns each row's `task_id`.

## Config reference

```jsonc
"provider": {
  "balance": {
    "db_path": "./ledger.db",
    "currency": "USD",
    "single_limit": "5.00",       // per-transaction default
    "daily_limit": "20.00",       // per-day default
    "operator_key": "…"           // gates topup / refund
  },
  "audit": { "dir": "./audit" },   // omit → in-memory audit only
  "commerce": {
    "task_budget_db": "./task-budgets.db", // omit → sibling of the balance db, else in-memory
    "operator_key": "…"           // gates task-budget register + audit read;
                                  // lets a crypto-only server (no balance) use budgets
  }
}
```

`operator_key` resolves as: `MOLTSPAY_BALANCE_OPERATOR_KEY` env →
`provider.commerce.operator_key` → `provider.balance.operator_key`.

---

## End-to-end example

```
User: "research 3 competitors and buy their video clips, budget $5"
1. operator registers task budget:  POST /balance/task-budget  task=job-1 budget=5.00
2. agent pays per service:          moltspay pay … --task job-1
3. ledger caps cumulative spend at $5 (atomic, server-side)
4. over budget → 402 exceeds_task_budget → agent stops and reports
5. GET /audit?task_id=job-1 → full spend breakdown + result verification, tamper-evident
```

Behaviour verified end-to-end (success + failure paths): a settled purchase
delivers and is audited `fulfilled`; a failing skill auto-refunds, leaves the
balance whole, records `payment_refunded`, and does not consume task budget.

## OpenClaw integration

An OpenClaw skill (`~/clawd/skills/commerce/SKILL.md`) exposes the eight
commerce tools (`discover`, `quote`, `authorize`, `pay`, `verify`, `balance`,
`history`, `refund`) mapped to these endpoints, so an agent can run the whole
loop conversationally. Programmatic enforcement is the SDK's `CommerceMiddleware`.

## Security notes

- Budget / approval / provider policy are enforced server-side (ledger) and in
  the middleware — outside the model.
- The audit trail is hash-chained and operator-gated; integrity is checked on
  every query.
- `operator_key` gates budget registration, refunds, and audit reads — never
  hand it to an untrusted caller.
- Do not change budgets or policy over untrusted remote channels; local /
  approval-flow only.
```
