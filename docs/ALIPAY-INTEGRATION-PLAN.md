# MoltsPay × Alipay AI Pay (支付宝 AI 收) Integration Execution Plan

> **Status**: v1 · All §0 decisions settled (2026-05-29), rc.1 may start
> **Created**: 2026-05-29
> **Decided**: 2026-05-29
> **Target version**: `moltspay@1.7.0`
> **Related docs**:
> - `./ALIPAY-INTEGRATION-DESIGN.md` — full design (architecture decisions, config schema, file inventory)
> - `~/clawd/docs/alipay-aipay-402-protocol.md` — server-side 402 protocol reference implementation (sr007.com)
> - `~/clawd/docs/alipay-skill-integration-guide.md` — client CLI onboarding flow (official `alipay-bot`)

This document is the executable checklist for the design doc. Every item maps to a checkable state; all 5 decisions in §0 must be resolved before rc.1 starts.

---

## §0 Pre-start decisions (settled, 2026-05-29)

From design doc §9. All settled on recommended option A.

- [x] **Decision 1: Merchant identity → A (reuse sr007.com / 上海超响应)**
  - Python end-to-end already runs, all 6 pitfalls already hit; porting cost is manageable
  - Rejected option: create a MoltsPay-owned sandbox merchant (onboarding lead time blocks rc.1)
  - **Execution impact**: rc.1 sandbox phase uses sr007 sandbox keys directly; the 3 production orders in §3 also run on sr007; merchant onboarding fees/account management deferred to 1.8.x
- [x] **Decision 2: CLI subcommand naming → A (`moltspay pay --rail alipay <url>`)**
  - Parallel semantics with `--chain base`; a rail is a "transport channel"
  - Rejected option: `moltspay alipay pay <url>` subcommand form
  - **Execution impact**: `src/cli/index.ts` adds a `--rail` option under the `pay` command, no new `moltspay alipay` subcommand tree; however `moltspay alipay check / apply / bind` remain as **auxiliary subcommands** (for first-time wallet setup, passthrough to `alipay-bot`)
- [x] **Decision 3: Where the rail lives in the schema → A (reuse `provider.chains: ["alipay", ...]`)**
  - Does not break the existing whole-schema semantics; the docs just need to explain that a chain id may now be a fiat rail
  - Rejected option: add a `provider.rails` field
  - **Execution impact**: `schemas/moltspay.services.schema.json` does not add `provider.rails`; `src/chains/index.ts` annotates `"alipay"` with `type: "fiat-rail"`; README gains one line — "the chains array may now also contain fiat rails"
- [x] **Decision 4: 1.7.0 scope → A (402 only, cashier goes to 1.7.1)**
  - Cashier has little to do with the server SDK; it's mostly MCP passthrough to `alipay-bot submit-payment`, no reason to drag out 1.7.0
  - Rejected option: 1.7.0 covers both
  - **Execution impact**: MCP tool `alipay_pay_cashier` **moves from §3 1.7.0 GA to §5 1.7.1**; CHANGELOG Known Limitations states "1.7.0 is 402 only; cashier in 1.7.1"
- [x] **Decision 5: Documentation location → A (standalone `docs/ALIPAY-RAIL.md` + 5-line README callout)**
  - README is already 33 KB; stuffing more in would blow it up
  - Rejected option: put it directly in the README
  - **Execution impact**: §3 documentation list adjusted — create `docs/ALIPAY-RAIL.md` (user-facing onboarding guide), README gains a callout pointing to it

---

## §1 Milestone 1: 1.7.0-rc.1 (server-side foundation + sandbox E2E)

**Estimate**: 2 weeks
**Exit criteria**: sandbox passes; legacy `alipay-bot` client regression passes

### New files

- [x] `src/facilitators/alipay.ts` — `AlipayFacilitator` class, all 4 methods implemented (createPaymentRequirements / verify / settle / healthCheck) 2026-05-29, 56 unit tests combined
- [x] `src/facilitators/alipay/openapi.ts` — `alipayOpenApiCall()` generic invoker (implemented 2026-05-29 + 16 unit tests, incl. fetch mock)
- [x] `src/facilitators/alipay/rsa2.ts` — `rsa2Sign` / `rsa2Verify`, built on Node's built-in `crypto` (implemented 2026-05-29 + 14 unit tests)
- [x] `src/facilitators/alipay/encoding.ts` — `base64url` / `decodeBase64UrlWithPadFix` (implemented 2026-05-29 + 17 unit tests)

### Changed files

- [x] `src/facilitators/registry.ts` — register `"alipay"` network → `AlipayFacilitator` (implemented, registry.ts:85)
- [x] `src/facilitators/index.ts` — export (implemented)
- [x] `src/server/index.ts` — 402 middleware **dual-emits** `X-Payment-Required` + `Payment-Needed` (2026-05-31 fixed the missing emit on `/execute`, 6 HTTP regression tests)
- [x] `src/server/index.ts` — `/execute` and MPP service endpoints dispatch to `AlipayFacilitator.verify` when a `Payment-Proof` header is received (**exposed by a real order on 2026-05-31: Payment-Proof was only listed in the CORS allowlist and never read → buyers who had already paid were stuck in a 402 loop**; now reads header → verify → fulfill → 200, 2 server tests + real-order verification)
- [x] `src/chains/index.ts` — register `"alipay"` chain id (`ALIPAY_RAIL` metadata + `isAlipayChainId` guard; the `ChainName`/`EvmChainName` unions untouched to avoid disturbing 20+ callers, 2026-05-29, 18 unit tests incl. cross-module consistency check)

### Schema extensions

- [x] `src/server/types.ts` — `ServiceConfig.alipay?: ServiceAlipayConfig` + `ServiceAlipayConfig` interface (2026-05-29; the PLAN originally said `src/types/services.ts`, but service types actually live in `src/server/types.ts`)
- [x] `src/server/types.ts` — `ProviderConfig.alipay?: ProviderAlipayConfig` + `ProviderAlipayConfig` interface (2026-05-29)
- [x] `schemas/moltspay.services.schema.json` — JSON Schema synced, incl. `provider.alipay` / `services[].alipay` / `"alipay"` added to the chains enum / a complete alipay example (2026-05-29)
- [x] `src/facilitators/interface.ts` — `X402PaymentRequirements.extra` gains per-scheme JSDoc convention (the PLAN originally said `src/types/x402.ts`, actually in `src/facilitators/interface.ts`; 2026-05-29)
- [ ] `scripts/validate-config.ts` keeps up with new field validation — the file **does not yet exist** in the repo; create it separately when needed

### Startup validation

- [ ] When `provider.chains` contains `"alipay"`, startup validates that `provider.alipay.private_key_path` is readable and the RSA private key is valid
- [ ] When `provider.alipay` is absent, the `Payment-Needed` header is not emitted; behavior identical to 1.6.0

### Unit tests (vitest) 100% coverage of `src/facilitators/alipay/*`

- [x] RSA2 sign/verify (2026-05-29, verified sign/verify correctness with runtime-generated 2048-bit key pairs + cross-key rejection + error robustness, 14 unit tests; end-to-end with real Alipay sandbox keys deferred to the rc.1 sandbox integration phase)
- [x] Base64URL padding fix (covers `==` / `=` / no-padding cases + URL-safe/standard alphabets + UTF-8 + round-trip, 2026-05-29)
- [x] Signature over 8 fields in dictionary order: `amount`/`currency`/`goods_name`/`out_trade_no`/`pay_before`/`resource_id`/`seller_id`/`service_id` (2026-05-29, real `rsa2Verify` round-trip + tamper detection)
- [x] Challenge JSON nested structure `{protocol: {...}, method: {...}}` (2026-05-29, exact assertions on 8 protocol keys + 6 method keys + UTF-8 fidelity)
- [x] `pay_before` ISO 8601 +30 minutes (2026-05-29, UTC `Z` form, no fractional seconds)
- [x] `amount` regex validation `/^\d+(\.\d{1,2})?$/` (2026-05-29, 15 `it.each` cases covering accept/reject; `"100"` accepted by the regex, the "yuan-vs-fen ambiguity" guarded by docs + types)

### Sandbox integration

- [ ] Run one complete 402 challenge → mock proof → verify → fulfill against the Alipay sandbox merchant

### Regression

- [ ] 1 E2E order on each of the existing 8 chains, confirming the dual-emitted header does not break 1.6.0
- [ ] **CLI compatibility**: hit MoltsPayServer directly with the un-upgraded `@alipay/agent-payment@1.0.9` skill; the payment must complete

---

## §2 Milestone 2: 1.7.0-rc.2 (client CLI wrapper + state machine)

**Estimate**: 1 week
**Exit criteria**: internal 1-yuan real-money order passes end-to-end

### New files

- [x] `src/client/alipay/index.ts` — `AlipayClient` + `pay402()` 8-step state machine (2026-05-31, runner/getVersion/now all injectable via DI, 11 unit tests incl. full 8-step ordering assertions)
- [x] `src/client/alipay/cli.ts` — `spawn` wrapper, stdout/stderr streaming callbacks, env allowlist, injectable `bin` (2026-05-31, 5 unit tests using real node spawn to verify line splitting + abort + env allowlist)
- [x] `src/client/alipay/poll.ts` — `pollUntil(tradeNo, signal)`, 3s interval, `pay_before` deadline, `AbortSignal` interruption (2026-05-31, 7 unit tests, runner/sleep/now injected)
- [x] `src/client/alipay/install.ts` — `ensureCli()` version check ≥ 0.3.15 (2026-05-31, inlined semverLt to avoid a new dependency, 8 unit tests)
- [x] `src/client/alipay/router.ts` — `selectRail(serverAccepts, userPref, availability)` (2026-05-31, pure function, 12 unit tests covering the 4-level decision tree)
- [x] `src/client/alipay/errors.ts` — 7 error classes, each with a stable `code` field (2026-05-31, extends `MoltsPayError` from `core/errors.ts`)

### Changed files

- [x] `src/client/index.ts` (actually `node/index.ts`) — when `options.rail === 'alipay'`, `pay()` dispatches to `payViaAlipay()` **before EVM wallet validation** → `selectRail()` confirms the server offers alipay → `AlipayClient.pay402()` (2026-05-31. Note: automatic cross-rail preference routing when no rail is explicit (railPreference when the server offers both crypto+alipay) is deferred to post-rc.2; `selectRail` is implemented + unit-tested)
- [x] `src/client/web/index.ts` — `AlipayWebClient` stub (standalone `web/alipay.ts`, does **not** import `../alipay/*` to keep Node modules out of the browser bundle), throws `UnsupportedChainError`; verify:web passes (2026-05-31)
- [x] `src/cli/index.ts` — `moltspay pay --rail alipay` subcommand (skips EVM wallet validation for alipay + streaming passthrough + onPaymentPending prints the payment link, 2026-05-31)
- [x] `src/cli/index.ts` — `moltspay alipay check / apply / bind` CLI passthrough (`stdio:'inherit'` + env allowlist, friendly ENOENT guidance, 2026-05-31)

### Skill guide hard constraints (implemented at the SDK layer, not dependent on the CLI)

- [x] **CLI output passed through character-for-character**: `spawn` + line-level stream API, no `exec` (2026-05-31, `makeLineSplitter` buffers until newline before surfacing)
- [x] **Environment variable allowlist**: only `AIPAY_OUTPUT_CHANNEL` / `AIPAY_SESSION_ID` / `AIPAY_FRAMEWORK` / `AIPAY_MODEL` / `AIPAY_OS` + minimal survival set (`PATH`/`HOME`) (2026-05-31, `ALLOWED_ENV` + unit test asserting the exact set)
- [x] **8 steps must never be skipped**: state machine strictly enforces step order, one spawn per step (2026-05-31, unit test asserts the `payment-intent → check-wallet → 402-buyer-pay → query → ack` call sequence)
- [x] **sessionId**: `opts.sessionId ?? AIPAY_SESSION_ID ?? crypto.randomUUID()` (never "fabricate" a fake UUID) (2026-05-31, `resolveSessionId`)
- [x] **tradeNo is 32 digits, numeric only**: SDK-layer `assertTradeNo` regex validation, not dependent on the CLI (2026-05-31, `/^\d{32}$/`)
- [x] **MEDIA: lines**: line-level detection, extract the image path, strip and surface (2026-05-31, `extractMedia` + onLine wrapper stripping)
- [x] **No automatic npm install**: on missing CLI, raise `AlipayCliNotFoundError` and guide the user to install manually (2026-05-31)

### Error codes (stable API)

- [x] `ALIPAY_CLI_NOT_FOUND` (2026-05-31, all 7 implemented in `client/alipay/errors.ts`)
- [x] `ALIPAY_CLI_VERSION`
- [x] `ALIPAY_NEEDS_WALLET_SETUP`
- [x] `ALIPAY_PAYMENT_REJECTED`
- [x] `ALIPAY_PAYMENT_TIMEOUT`
- [x] `ALIPAY_PROTOCOL`
- [x] `UNSUPPORTED_RAIL`

### Real end-to-end (mandatory) — ✅ passed 2026-05-31

- [x] One real 1-yuan (元) CNY payment: `moltspay pay --rail alipay http://127.0.0.1/execute video-demo`, real "AI Pay" (AI付) wallet QR-scan payment → server reads `Payment-Proof` → `alipay.aipay.agent.payment.verify` (**production gateway** openapi.alipay.com) verified → skill executes → `alipay.aipay.agent.fulfillment.confirm` → resource delivered with 200 (tradeNo `20260531008281180847110000015839`)
- [x] Real-device testing exposed and fixed 4 bugs: (1) `check-wallet` exits 0 with `{code:500}` when the wallet is not set up (cannot rely on exit code); (2) `payment-intent` requires `-i/--intent-summary`; (3) passthrough subcommands' real names are `apply-wallet`/`bind-wallet`; (4) `parseStatus` mistook the `success` key of `{"success":false}` for paid (UNPAID false positive)
- [x] **Key environment finding**: the buyer uses a **production** AI Pay wallet, so the seller must configure the **production gateway** `openapi.alipay.com` (the sandbox alipaydev.com already 502s and the environments do not interoperate)
- alipay-bot install: `npx -y @alipay/agent-payment install-cli` (installs alipay-bot-cli ≥0.3.15 into `~/.local/bin`)
- ⏭️ Archive screen recording into `~/moltspay-qa-notes/` (QA record, pending)

---

## §3 Milestone 3: 1.7.0 GA (MCP + docs)

**Estimate**: 0.5 week
**Exit criteria**: **3 production orders** end-to-end with sr007.com, all fulfillment.confirm successful

### New files

- [ ] `src/mcp/tools/alipay.ts` — MCP tool registration
  - [ ] `alipay_check_wallet`
  - [ ] `alipay_pay_402(url, intent_summary)` — runs all 8 steps to completion
  - ~~`alipay_pay_cashier`~~ — per Decision 4, moved to §5 1.7.1
- [x] `docs/ALIPAY-RAIL.md` — user-facing onboarding guide (per Decision 5, v1 draft landed 2026-05-29)

### Documentation

- [x] `docs/ALIPAY-RAIL.md` covers: merchant onboarding prerequisites, `provider.alipay` config, `services[].alipay` config, `moltspay pay --rail alipay` usage, error code table (7 `ALIPAY_*` codes), common pitfalls (amount yuan vs fen (分), service_id prefix, 8-field signature) + end-to-end example + x402 comparison
- [x] README gains a callout line linking to `docs/ALIPAY-RAIL.md` (Features list, 1-line compact form)
- [ ] CHANGELOG (GitHub Release notes; CHANGELOG.md remains gitignored)
  - [ ] Known Limitations: browser support for alipay is **hard-coded unsupported** (not "untested")
  - [ ] Known Limitations: mainland-China merchants only (requires ICP + business license)
  - [ ] Known Limitations: cashier-mode coverage (worded per Decision 4)

### Production acceptance

- [ ] sr007.com 1 order at 1 CNY, fulfillment.confirm `code: 10000`
- [ ] sr007.com 1 order at ≥10 CNY, fulfillment.confirm `code: 10000`
- [ ] sr007.com 1 POST-request order (validates the `-m POST -d` path), fulfillment.confirm `code: 10000`

---

## §4 Cross-cutting acceptance (never skipped at any milestone completion)

### Compatibility checklist (design doc §10)

- [ ] `Payment-Needed` is **Base64URL** (not standard Base64)
- [ ] Nested `{protocol: {...}, method: {...}}` structure
- [ ] `amount` is a string denominated in **yuan** (`"1.00"`), not fen
- [ ] Signature covers only the 8 fields, concatenated in dictionary order, excluding `protocol` / `method` themselves
- [ ] `pay_before` ISO 8601 +30 minutes
- [ ] `Access-Control-Expose-Headers` exposes `Payment-Needed` and `Payment-Proof` for browser CORS (even though 1.7.0 does not let browsers pay via alipay, the headers must still be exposed to pages that read the challenge)
- [ ] `Payment-Proof` base64 padding auto-completed before decoding
- [ ] `client_session` passed at verify time (taken from `method.client_session`)
- [ ] Fulfillment confirmation `alipay.aipay.agent.fulfillment.confirm` is called **asynchronously** after the resource is returned, **never blocking** the user from receiving the resource

### Risk register (design doc §7, monitored until 1.7.0 GA)

| Risk | Level | Mitigation status |
|---|---|---|
| Merchant qualification threshold (China ICP + business license) | High | [ ] Explicit in docs + CLI detects missing `provider.alipay` and skips |
| `alipay-bot` CLI upgrade breaks the wrapper | Medium | [ ] `ensureCli()` pins ≥ 0.3.15; major locked, minor accepted |
| Private key leakage (RSA2 merchant private key) | High | [ ] File-path config, inline forbidden; log redaction; schema lint bans `BEGIN RSA PRIVATE KEY` |
| amount unit (yuan vs fen) | Medium | [ ] Strong typing `priceCny: string` + regex validation |
| Refund semantics on fulfillment failure | Medium | [ ] fulfillment.confirm failure is not treated as success |
| Payment-Proof base64 padding | Low | [ ] Unit test coverage |
| Existing `alipay-bot` users broken | High | [ ] Dual-emitted headers; legacy 1.0.9 skill regression passes |

---

## §5 After 1.7.0 (reference, out of scope for this cycle)

- **1.7.1** (scope settled per Decision 4):
  - `alipay_pay_cashier(cashier_url, intent_summary)` MCP tool (passthrough to `alipay-bot submit-payment`)
  - `moltspay alipay pay-cashier <url>` CLI subcommand
  - `apply` / `bind` / `check` fallback callbacks (guided flow when the wallet is not yet set up)
- **1.8.0**: native TS client (drop the `alipay-bot` dependency), browser cashier-URL fallback; trigger condition = real 1.7.x usage data
- **1.8.x / later**: MoltsPay-owned sandbox merchant onboarding (deferred item from Decision 1), reducing coupling to sr007.com

---

## Appendix: self-check entry point

At any moment, return to this document and check:

1. Are all five §0 decisions resolved? If not, §1 must not be touched
2. Are all checkboxes of the current §1 / §2 / §3 milestone ticked? Do not advance to the next milestone until they all are
3. Is the §4 compatibility checklist re-run at every milestone? Because any server change may break 1.6.0 legacy client compatibility
4. Do all "High" items in the §4 risk register have mitigations landed? No latest tag may ship until they do

*This document is updated in lockstep with the 1.7.0 implementation. Come back and tick checkboxes after each PR merge. Archived as v1 final at 1.7.0 GA.*
