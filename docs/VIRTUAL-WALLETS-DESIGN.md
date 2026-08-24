# MoltsPay Virtual Wallets — Design Notes (DRAFT / pre-decision)

**Status:** proposal only. Nothing here is built. Written to capture the plan before any code is touched.
**Author:** Zen7
**Goal:** give MoltsPay a wallet model with Cloudflare-style **bounded-loss + revocable delegate credentials + human-override**, without abandoning what MoltsPay already has (multi-rail, fiat, self-custody crypto).

---

## 1. Why

Cloudflare Wallets (Aug 2026) set a security bar for agent payments:

- **Bounded loss** — a compromised/misbehaving agent cannot exceed server-enforced caps.
- **Revocable credential** — the agent holds a delegated key/token that can be revoked instantly, without moving funds.
- **Human-override** — the owner sets merchant allowlists and can require approval on sensitive spends.

MoltsPay's **balance rail (2.2–2.4)** already provides most of the substrate: a custodial balance with server-enforced per-tx/daily limits, atomic + idempotent deducts, auto-refund, and (2.4) a signed local identity bound to the account. This doc proposes closing the remaining gap.

---

## 2. The hard constraint (read first)

Cloudflare's three properties require a **server that can refuse a transaction**. They map onto MoltsPay's **custodial balance rail**. They **cannot** be retrofitted onto the raw crypto rail (`moltspay init` → local `wallet.json`), because the blockchain does not know MoltsPay's rules: whoever holds the private key can move funds directly on-chain, and SDK-side limits are bypassed once the key is stolen.

Therefore:

- **Path A (this doc's primary proposal):** Virtual Wallets on the *balance rail*. Custodial, server-enforced, ship-soon.
- **Path B (roadmap):** on-chain account abstraction (ERC-4337 session keys) to get the same three properties for *self-custody crypto*. Bigger, needs contracts + audit. Sketched in §7.

---

## 3. Concept mapping

| Cloudflare | MoltsPay equivalent | Exists today? |
|---|---|---|
| Account Wallet (owner holds funds) | Balance account (custodial, anchored to funding identity / openid) | ✅ 2.4 |
| Virtual Wallet (agent, API-key scoped) | **Delegate credential** (new) — scoped, revocable, per-agent | ❌ new |
| Spending caps | Per-account limits | ✅ (per-account) → extend to per-credential |
| Approved merchants | Provider allowlist per credential | ❌ new |
| Human override | Threshold-based approval flow | ❌ new (approval plumbing exists in Feishu bridge) |
| Revoke key | Revoke/rotate credential endpoint | ❌ new |

---

## 4. Data model (Path A)

New table, server-side (extends the existing balance ledger DB):

```
delegate_credential
---------------------------------------------------------------
credential_id      TEXT PK      -- e.g. "vw_a1b2c3"
account_id         TEXT FK      -- the balance account it draws from
label              TEXT         -- human name, e.g. "video-bot-prod"
signer_pubkey      TEXT NULL    -- if auth = signed key (preferred)
token_hash         TEXT NULL    -- if auth = bearer token (Cloudflare-style)
max_per_tx         INTEGER      -- fen / smallest currency unit
max_per_day        INTEGER
allowed_providers  TEXT         -- JSON array; empty = any
approval_threshold INTEGER NULL -- deducts above this need human approval; NULL = never
expires_at         TIMESTAMP NULL
status             TEXT         -- active | revoked | expired
created_at         TIMESTAMP
created_by         TEXT         -- owner identity that issued it
```

Optional companion for the override flow:

```
approval_request
---------------------------------------------------------------
approval_id   TEXT PK
credential_id TEXT FK
provider      TEXT
amount        INTEGER
request_id    TEXT          -- ties to the pending deduct (idempotency)
status        TEXT          -- pending | approved | denied | expired
created_at    TIMESTAMP
decided_at    TIMESTAMP NULL
```

Per-credential daily spend is tracked the same way per-account spend is today (rolling window keyed on `credential_id`).

---

## 5. Deduct-path changes (Path A)

Current balance deduct (2.4) checks: account exists → signer bound (enforce mode) → per-tx/daily limit → atomic idempotent deduct → auto-refund on service failure.

Insert credential enforcement **before** the deduct:

1. Resolve `credential_id` from the request (signed key → look up `signer_pubkey`, or bearer token → hash compare).
2. Reject if `status != active`, or `expires_at` passed → **401 / revoked** (revocable-API-key).
3. Enforce `allowed_providers` — reject if the target provider isn't in the list → **403 / merchant-not-allowed** (approved merchants).
4. Enforce per-credential `max_per_tx` and `max_per_day` **in addition to** the account limits → **bounded loss**. Lowest cap wins.
5. If `amount > approval_threshold`: do **not** deduct. Create an `approval_request`, return `{ status: "approval_required", approval_id }` → **human-override**.
6. Otherwise proceed to the existing atomic deduct.

Idempotency and auto-refund behavior are unchanged — the credential check is a gate in front of them.

---

## 6. New endpoints (Path A)

Owner-authenticated (must prove control of the account — reuse the funding-identity auth):

```
POST   /balance/credentials              issue a Virtual Wallet (returns credential_id + secret ONCE)
GET    /balance/credentials              list credentials + status + today's spend
POST   /balance/credentials/:id/revoke   set status=revoked (instant, funds untouched)
POST   /balance/credentials/:id/rotate   new secret, same caps
PATCH  /balance/credentials/:id          change caps / allowlist / threshold
```

Approval flow:

```
GET    /balance/approvals                pending approvals for the owner
POST   /balance/approvals/:id/decide     { decision: approved | denied }
```

CLI surface (mirrors existing `moltspay balance ...`):

```
moltspay balance vw create --label video-bot --max-per-tx 5 --max-per-day 50 --provider https://juai8.com/zen7
moltspay balance vw list
moltspay balance vw revoke vw_a1b2c3
moltspay balance vw rotate vw_a1b2c3
```

---

## 7. Path B — on-chain, non-custodial (roadmap sketch)

To get bounded-loss + revoke + override for the **crypto** rail without custody:

- Give the agent a **smart-contract wallet** (ERC-4337) instead of an EOA private key.
- Owner installs a **spending-limit + allowlist module** (caps and approved recipients enforced *on-chain*).
- Agent holds a **session key** with limited scope; owner can **revoke** it via a transaction.
- This is strictly stronger than Cloudflare on one axis: bounded-loss **and** non-custodial (nobody can freeze/seize).

Cost: smart-contract development, a security **audit** before real funds, per-chain deployment, gas for revocation, bundler/paymaster infra. Weeks, not days. Do after Path A proves the UX.

---

## 8. Security properties — before vs after

| Threat | Crypto rail today | Balance rail 2.4 | + Virtual Wallets (Path A) |
|---|---|---|---|
| Leaked agent key drains everything | ❌ full drain | ⚠️ bounded by account caps | ✅ bounded by *credential* caps |
| Revoke a compromised agent | ❌ impossible | ⚠️ operator-only re-bind | ✅ self-serve instant revoke |
| Rogue/injected agent overspends | ⚠️ SDK-only (bypassable) | ✅ server caps | ✅ server caps + allowlist |
| Sensitive spend needs a human | ❌ none | ❌ none | ✅ threshold approval |
| Counterparty freeze/seizure | ✅ none (self-custody) | ⚠️ custodial | ⚠️ custodial (Path B fixes) |

---

## 9. Non-goals / explicitly out of scope (for now)

- Changing the raw crypto rail's custody model (that's Path B).
- Multi-owner / org roles on an account.
- On-chain settlement of the custodial balance.
- Fiat-rail refund automation beyond what 2.4 already does.

---

## 10. Open questions (need answers before spec → code)

1. **Auth type for the delegate:** signed key (matches 2.4, no shared secret in transit) vs bearer token (matches Cloudflare's mental model, simpler for web). Recommend **signed key**, optional token for browser.
2. **Approval channel:** reuse the **Feishu card-approval** flow, or a generic **webhook** so any channel can implement override? Recommend webhook interface with Feishu as the first adapter.
3. **Default caps** for a freshly issued Virtual Wallet (safe-by-default, e.g. max-per-tx = account default, threshold = off).
4. **Enforcement mode:** ship credential checks in `shadow` first (log-only) before `enforce`, matching the 2.4 rollout pattern?
5. **Where credentials live client-side:** per-credential file under `<configDir>/credentials/` vs single keystore.

---

## 11. Rough effort (Path A)

- Data model + migrations: ~0.5 day
- Deduct-path gate (steps 1–5): ~1 day
- Endpoints + owner auth: ~1 day
- Approval flow + first channel adapter: ~1–1.5 days
- CLI surface: ~0.5 day
- Tests (unit + e2e, mirror existing balance tests): ~1 day

**~5–6 dev-days** for Path A, no new cryptography. Path B is a separate, larger effort gated on an audit.

---

## 12. Decision needed

- [ ] Path A now, Path B later (recommended) / Path A only / Path B only
- [ ] Approval channel: Feishu adapter / generic webhook / both
- [ ] Auth type: signed key / bearer token / both
- [ ] Ship credential checks in shadow mode first? (recommended)

Once these are checked, next artifact is a concrete implementation spec (file-level changes in `src/server`, `src/facilitators`, `src/cli`) for review — still before any code.
