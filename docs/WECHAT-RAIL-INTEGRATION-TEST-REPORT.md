# WeChat Pay Rail — Integration Test Report (2.1.0)

| | |
|---|---|
| **Component** | moltspay WeChat Pay Native rail (scenario A) |
| **Version** | 2.1.0 |
| **Branch / commit** | `feature/wechat` @ `f229897` |
| **Date** | 2026-06-28 |
| **Environment** | Production WeChat Pay merchant gateway (`api.mch.weixin.qq.com`) |
| **Merchant (mchid)** | `1648212710` (production) |
| **Overall result** | ✅ **PASS** — automated suites green + live production end-to-end green |

---

## 1. Scope

Validate the WeChat Native collection rail (scenario A: agent issues a payer-agnostic
`code_url`, a human scans and pays, the agent polls to confirm, then settles) at two
levels:

1. **Automated** — unit + HTTP server integration tests (stubbed gateway, no network/money).
2. **Live** — a real ¥0.01 order against the **production** WeChat v3 gateway, paid by a
   human scan, then verified and settled. This exercises the parts unit tests cannot:
   real APIv3 signing acceptance, certificate serial, merchant identity, and the live
   order-query/settle round trip.

Out of scope (deferred to Phase 2 per design §8): async `notify` webhook, AES-GCM
callback decryption, platform-certificate auto-download/rotation.

---

## 2. Automated test results

Command: `npx vitest run test/facilitators/wechat test/server/wechat-rail.test.ts`

| Suite | Tests | Result |
|---|---|---|
| `test/facilitators/wechat/sign.test.ts` | 13 | ✅ pass |
| `test/facilitators/wechat/facilitator.test.ts` | — | ✅ pass |
| `test/facilitators/wechat/wiring.test.ts` | 2 | ✅ pass |
| `test/server/wechat-rail.test.ts` (HTTP server integration) | 3 | ✅ pass |
| **Total (WeChat)** | **38** | ✅ **38 passed** |

- `npm run typecheck` (`tsc --noEmit`): ✅ 0 errors.
- The HTTP server integration test boots a real `MoltsPayServer`, stubs only the WeChat
  gateway, and asserts: (a) without `provider.wechat` the 402 `accepts[]` has no wechat
  entry; (b) with it, a `wechatpay-native` entry carrying `code_url` + `out_trade_no` is
  appended and the crypto entries are untouched; (c) `/execute` with a paid order
  (`trade_state=SUCCESS`) verifies, runs the skill, and returns 200.

### Note on the full suite

`npm run test:run` (entire repo) shows **11 failures across 3 files** — all in
**unrelated legacy suites**, not the WeChat rail:

- `test/AuditLog.test.ts` (7 failed)
- `test/chains.test.ts` (4 failed)
- `test/PaymentAgent.test.ts` (collection/load error, 0 tests run)

These pre-date this rail and are not a 2.1.0 regression. Flagged for separate triage.

---

## 3. Live production end-to-end

A real order was placed against the production gateway, paid by WeChat scan, then
verified and settled.

| Stage | Detail | Result |
|---|---|---|
| Credentials preflight | `apiclient_key.pem` valid (`RSA key ok`); cert serial matches `CERT_SERIAL_NO` exactly (`6C00701C394129F25C9134D0A6CB6C2814088630`) | ✅ |
| `createPaymentRequirements` | Native order, amount ¥0.01; gateway accepted in **2.66 s**; returned `code_url=weixin://wxpay/bizpayurl?pr=3dTjvLJz3`, `out_trade_no=WX5aa28944bef1f09acfbe31a0aec88f` | ✅ |
| Human scan + pay | QR rendered from `code_url`; paid via WeChat | ✅ |
| `verify` (order query poll) | `valid=true`, `trade_state=SUCCESS` | ✅ |
| `settle` | `success=true`, `status=fulfilled` | ✅ |
| **transaction_id** | `4200003113202606281048886793` | — |
| Amount reconciliation | payer total = **1 fen** (¥0.01) — yuan→fen conversion correct | ✅ |

**Proven on the real gateway:** APIv3 SHA256-RSA authorization signing, merchant
certificate serial, mchid/appid acceptance, yuan→fen conversion, Native order create,
order-query verification, and idempotent settle.

Reproduction scripts (added during this test, currently uncommitted):
- `scripts/wechat-live-order.mts` — places a live Native order, prints `code_url` (no
  money moves until scanned).
- `scripts/wechat-live-verify.mts` — polls `verify` to SUCCESS then `settle` for a given
  `out_trade_no`.

---

## 4. Defect found — IPv6 egress / undici no Happy-Eyeballs (production-impacting)

**Symptom.** Node global `fetch` to `api.mch.weixin.qq.com` fails with `ETIMEDOUT`
("fetch failed") even though the gateway is reachable.

**Root cause.** This host's IPv6 egress is a black hole, and the gateway's DNS returns
AAAA (IPv6) records first. Node's `fetch` (undici) does **not** perform Happy-Eyeballs
fallback to IPv4, so it hangs on the dead IPv6 route. `curl` masks the problem because it
falls back to IPv4 (`1.13.x`) on its own.

**Confirmed non-fixes.** `node --dns-result-order=ipv4first` and
`net.setDefaultAutoSelectFamily(true)` both still `ETIMEDOUT`. Raw `net.connect({family:4})`
to the IPv4 address succeeds, and patching `dns.lookup` to force `family:4` makes `fetch`
return normally — that is the working mitigation used in the live scripts.

**Impact.** Any deployment on a host with AAAA-first DNS but no working IPv6 route will
see the WeChat facilitator hang. This is environmental but realistic.

**Recommended fix (2.1.1).** Configure undici in `src/facilitators/wechat/api.ts` with an
IPv4-pinned / `autoSelectFamily`-enabled dispatcher (or a custom `connect.lookup`), so the
rail is robust regardless of host IPv6 health. Mirror in the Alipay HTTP path if it shares
the same `fetch` usage.

---

## 5. Conclusion & follow-ups

The WeChat Native rail is **functionally correct end-to-end on the production gateway**.
Automated coverage for the rail is green; the live round trip confirms the
cryptography/identity layer that stubs cannot.

Recommended follow-ups, in order:

1. **Fix the undici/IPv4 defect** in the facilitator and ship as **2.1.1**; promote the
   live scripts to a `verify:wechat:live` npm script (mirroring `verify:alipay:*`).
2. Triage the unrelated `AuditLog` / `chains` / `PaymentAgent` legacy test failures.
3. Open PR `feature/wechat → main`, tag `v2.1.0`, then decide on npm publish (per the
   plan, publishing can wait until Phase 2 notify + cert rotation lands).
