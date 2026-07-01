# WeChat Pay Rail — Development Plan (Scenario A)

> **Companion design**: [WECHAT-RAIL-DESIGN.md](./WECHAT-RAIL-DESIGN.md)
> **Scope**: Scenario A — agent issues a Native code, payer not pre-bound, one-code-one-payment, all funds to one `mchid`, **poll-based confirmation**
> **Target**: `moltspay@2.1.0` (proposed)
> **Effort**: ~1.5–2 person-days

This milestone does **poll-based confirmation only**. It excludes `aesgcm.ts` callback decryption, the notify webhook, the deep server `/execute` 402 wiring, and the full `provider.wechat` config — those belong to Phase 2 (see design §8).

---

## 1. Milestones (M1 → M4, strictly serial)

### M1 — Crypto + API base (highest risk, first) — DONE

| Item | Output |
|---|---|
| `src/facilitators/wechat/sign.ts` | `wechatV3Sign` (SHA256-RSA over `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n`), `buildAuthorizationToken`, `wechatV3VerifyResponse` (platform key, never throws), `generateNonce` |
| `src/facilitators/wechat/api.ts` | `wechatV3Call(method, urlPath, body, config)`: auto Authorization, optional response verify, throws `WechatApiError` with code/message on non-2xx |

- **Depends on**: nothing
- **Acceptance**: `sign.test.ts` sign/verify roundtrip passes; `buildAuthorizationToken` format asserted

### M2 — WechatFacilitator (scenario A core) — DONE

| Item | Output |
|---|---|
| `src/facilitators/wechat.ts` | `WechatFacilitator implements Facilitator`: `createPaymentRequirements` (Native order → `code_url` + `out_trade_no`, yuan→fen), `verify` (order query `trade_state === SUCCESS`), `settle` (idempotent confirm), `healthCheck`; helpers `cnyToFen`, `generateOutTradeNo` |

- **Depends on**: M1
- **Acceptance**: `createPaymentRequirements`/`verify`/`settle` pass with mock `fetch`; yuan→fen unit test (`"0.10"→10`)

### M3 — Scenario driver + integration wiring

| Item | Output |
|---|---|
| `examples/wechat-native-pay.ts` | runnable scenario A demo: issue code → render QR → 3s poll `verify` until SUCCESS/timeout → print `transaction_id` |
| `src/facilitators/registry.ts` | `registerFactory('wechat', ...)` |
| `src/facilitators/index.ts` | export `WechatFacilitator` + types + `WECHAT_NETWORK/WECHAT_SCHEME` |
| `src/chains/index.ts` | `WECHAT_CHAIN_ID`, `isWechatChainId`, `WECHAT_RAIL{type:'fiat-rail'}` |

- **Depends on**: M2
- **Acceptance**: demo runs (mock/sandbox); `registry.get('wechat')` works

### M4 — Wrap-up

| Item | Output |
|---|---|
| Tests complete | `test/facilitators/wechat/{sign,facilitator}.test.ts` (+ any added in M3) |
| Gates | `tsc --noEmit` zero errors, `vitest run` all green, `tsup` build passes |

- **Depends on**: M3
- **Acceptance**: all three gates pass, PR mergeable

---

## 2. Branch strategy

Currently on `main`. Following the Alipay convention (2.0.0 went on `feature/alipay`), **do not develop directly on main**:

```bash
git checkout -b feature/wechat        # branch off main
```

- Commit docs first: `docs(wechat): WeChat rail design + dev plan`
- Commit implementation per milestone: `feat(wechat): v3 sign/api`, `feat(wechat): facilitator`, `feat(wechat): scenario A demo + registry wiring`, ...
- When done, open PR `feature/wechat → main`, review, then merge

---

## 3. Testing

**Three local gates (same as `prepublishOnly`, must pass before release):**

```bash
npm run typecheck      # tsc --noEmit
npm run test:run       # vitest run (includes test/facilitators/wechat/*)
npm run build          # tsup
npm run verify:web     # web bundle check
```

**Layers:**

| Layer | Content | Needs real WeChat |
|---|---|---|
| Unit | `sign` (sign/verify roundtrip), `createPaymentRequirements`/`verify`/`settle` (mock `fetch`) | No, CI workhorse |
| Scenario demo | `examples/wechat-native-pay.ts` | Default mock; real run needs merchant credentials |
| Sandbox e2e (optional) | mirror `scripts/alipay-offline-e2e.mts` with `scripts/wechat-*.mts`, run issue+poll against a real test merchant | Yes, credentials via env |

**Key discipline**: merchant private key / `apiv3_key` never committed; use env or local `cert/` (already in `.gitignore`).

---

## 4. Release

A new rail is a new feature → semantic-version **minor: `2.0.1 → 2.1.0`**.

```bash
# 1) Version & changelog
#    package.json: version -> 2.1.0
#    CHANGELOG.md: add a 2.1.0 entry (WeChat Native rail / scenario A)
#    package.json "files": if shipping docs/WECHAT-RAIL.md, add it explicitly

# 2) Publish (auto-triggers prepublishOnly: typecheck + build + verify:web)
npm publish

# 3) Tag and push
git tag v2.1.0
git push origin main --tags
```

**Cadence suggestion**: the first version can **skip npm** — if only validating scenario A, merge to `main` + tag is enough; publish 2.1.0 once Phase 2 (notify + cert rotation) is complete, to avoid shipping a partial feature. npm credentials (PAT/OTP) reuse the existing release setup.

---

## 5. Effort

| Milestone | Estimate |
|---|---|
| M1 crypto+API | half day |
| M2 facilitator | half day |
| M3 demo+wiring | half day |
| M4 wrap-up | wrap-up |
| **Total** | **~1.5–2 person-days** |

No new third-party dependency (`qrcode-terminal`, `crypto`, and `zlib`/`fs` from Node are already present). CLI output should include terminal ASCII QR plus a generated PNG path emitted as `MEDIA: <path>` for chat surfaces.
