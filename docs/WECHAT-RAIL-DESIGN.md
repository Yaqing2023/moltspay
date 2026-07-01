# WeChat Pay Rail (WeChat Pay v3)

> **Target**: `moltspay@2.1.0` (proposed)
> **Status**: Design (partially implemented — M1/M2 landed)
> **Scope**: **Server-side verify/settle** (the focus of this doc); the client side is "render a QR + a human scans", NOT a fully autonomous agent payment
> **Author**: Mirrors the existing Alipay Rail (2.0.0) source, layer by layer

WeChat Pay Rail is the proposed 2nd fiat rail for MoltsPay. It lets a China-mainland merchant accept CNY using the **WeChat Pay v3 standard merchant API**, alongside the existing USDC/EVM/SVM crypto rails and the Alipay AI Pay rail. One `provider.wechat` block plus a per-service `wechat` object lets a single skill accept USDC / Alipay / WeChat at once.

## TL;DR

| Aspect | Value |
|---|---|
| Chain id | `"wechat"` (`type: "fiat-rail"`, peer of `alipay`/EVM/SVM) |
| Scheme | `"wechatpay-native"` |
| Currency | CNY (external `amount` is **yuan** decimal to match Alipay; converted to **fen** integer for the WeChat API) |
| Request signature | **SHA256-RSA**, merchant private key signs `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n` |
| Response/callback verify | WeChat **platform certificate** public key verifies `Wechatpay-Signature` (`timestamp\nnonce\nbody\n`) |
| Callback decryption | **AES-256-GCM** (apiv3 key + nonce + associated_data + auth tag) — Phase 2 |
| Server | 100% native Node `crypto`, no third-party deps; holds merchant RSA private key + apiv3 key |
| Client | server returns `code_url` → render a QR → **a human scans**; not an autonomous agent payment |
| Merchant eligibility | China mainland only (business license + WeChat merchant onboarding + APIv3 key) |

> **Fundamental difference vs the Alipay rail**: Alipay AI Pay ships an agent-payment protocol (the `alipay-bot` CLI), so an agent can pay fully autonomously. WeChat Pay has **no equivalent autonomous agent-payment product**; the standard merchant API assumes a human scans a QR / confirms in the WeChat app. So this rail's client shape is "server issues a code → human scans → server confirms by polling/callback". This doc focuses on the confirmed scope: **server-side verify/settle is viable**.

---

## 1. Prerequisites

The WeChat Pay v3 standard merchant API is **China-mainland merchants only** and requires onboarding via the WeChat merchant platform (pay.weixin.qq.com).

| Credential | Purpose |
|---|---|
| Business license | Merchant onboarding |
| WeChat merchant account | Provides `mchid` (merchant id) |
| WeChat official-account / open-platform app | Provides `appid` |
| API certificate | Merchant **private key** + certificate **serial number** `serial_no` |
| APIv3 key | 32 bytes, used for callback AES-256-GCM decryption |
| WeChat platform certificate | Used for response/callback verification (can be auto-downloaded via `/v3/certificates`; first version injects PEM via config) |

Choose **Native pay** (scan-to-pay) as the product type — it fits the "issue a code to collect for a resource" 402 shape best.

---

## 2. Architecture fit (reuses the existing facilitator abstraction)

The WeChat rail reuses MoltsPay's pluggable facilitator abstraction with **zero architectural change**:

```
                 FacilitatorRegistry (registry.ts)
                   |  select by network
   +----------+----+-----+-----------+--------------+
 CDP/EVM    Solana     Alipay      WeChat (new)
 (chain)    (chain)  (alipay-aipay) (wechatpay-native)
                      verify/settle  verify/settle
```

How WeChat v3 maps onto the four `Facilitator` methods:

| Interface method | WeChat v3 implementation |
|---|---|
| `createPaymentRequirements()` | `POST /v3/pay/transactions/native` → returns `code_url` + `out_trade_no` |
| `verify()` | `GET /v3/pay/transactions/out-trade-no/{no}?mchid=` → `trade_state === 'SUCCESS'` |
| `settle()` | idempotent re-confirm SUCCESS, returns `transaction_id` (Native captures at SUCCESS, no separate capture) |
| `healthCheck()` | keys parse + apiv3 key = 32B + gateway reachable |

---

## 3. Protocol differences vs the Alipay rail (implementation notes)

| Aspect | Alipay AI Pay (existing) | WeChat Pay v3 (this design) |
|---|---|---|
| Transport | form-urlencoded gateway `gateway.do` | **REST/JSON** `https://api.mch.weixin.qq.com` |
| Request signature | RSA2 over dictionary-sorted param string | **SHA256-RSA** over `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n` |
| Auth header | gateway `sign` field | `Authorization: WECHATPAY2-SHA256-RSA2048 mchid="..",nonce_str="..",signature="..",timestamp="..",serial_no=".."` |
| Response verify | not implemented (relies on HTTPS) | **required**: platform public key verifies `Wechatpay-Signature` |
| Callback | client returns a `Payment-Proof` | WeChat pushes an **async notify**; resource body is **AES-256-GCM** encrypted |
| Amount unit | **yuan** (decimal `"1.00"`) | **fen** (integer `100`) |
| Payment initiation | autonomous `alipay-bot` | `code_url` → human scans |
| Confirmation | `agent.payment.verify` | order query `trade_state` |
| Fulfillment | `fulfillment.confirm` | no separate capture, captured at SUCCESS |

---

## 4. Scenario A: agent issues a code, payer not pre-bound (this milestone)

> **Confirmed scope.** This milestone serves exactly this one scenario.

### 4.1 Scenario definition

One merchant (one `mchid`). The agent is the **merchant-side code issuer** and is **not bound to any payer**:

- The agent calls WeChat **Native order create** and gets a `code_url` (payer-agnostic, **no openid required**).
- Rendered as a QR, **whoever scans pays** — it is not pre-assigned to a specific person.
- **One code, one payment**: a `code_url` = one order = one fixed amount; once the first scanner pays, the order closes. To collect again, **issue a new code**.
- All funds go to the **same merchant id `mchid`**.

**Why Native and not JSAPI**: JSAPI order create requires the specific payer's `openid` up front, which binds the code to one person; Native is payer-agnostic by design, matching "not bound to a person, anyone can scan".

**Non-goals**: this is **not** "one long-lived receive code many people scan repeatedly" (that is WeChat's "merchant receive code / storefront code" product, which cannot be minted dynamically via the v3 order-create API); nor is it batch collection (one order per person).

### 4.2 Sequence

```
Agent (merchant side)                WeChat Pay                Payer (any WeChat user)
  |  createPaymentRequirements()        |                              |
  |  POST /v3/pay/transactions/native ->|                              |
  |  <-- { code_url } -------------------|                              |
  |                                     |                              |
  |  render QR (ASCII + MEDIA image)    |                              |
  | --------------- show QR -------------------------------------------->|
  |                                     |  <-------- scan + confirm pay -|
  |                                     |                              |
  |  poll verify():                     |                              |
  |  GET /v3/pay/transactions/          |                              |
  |      out-trade-no/{no}?mchid= ----->|                              |
  |  <-- { trade_state: NOTPAY } -------|   (not paid, keep polling)    |
  |  <-- { trade_state: SUCCESS } ------|   (paid, stop)                |
  |                                     |                              |
  |  settle(): idempotent re-confirm SUCCESS -> returns transaction_id |
  |  deliver resource / report received |                              |
```

### 4.3 Data structures and API sequence

| Step | Method | API | Key fields |
|---|---|---|---|
| Issue code | POST | `/v3/pay/transactions/native` | in: `appid,mchid,description,out_trade_no,notify_url,amount{total(fen),currency:CNY}`; out: `code_url` |
| Poll | GET | `/v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=` | `trade_state`: `NOTPAY`/`SUCCESS`/`CLOSED`/`PAYERROR`; `transaction_id`, `amount.payer_total` |
| Close (optional) | POST | `/v3/pay/transactions/out-trade-no/{out_trade_no}/close` | proactively close on timeout to avoid dangling orders |

Each order's `out_trade_no` is generated by the facilitator (unique). The `code_url` looks like `weixin://wxpay/bizpayurl?pr=xxxxxxx` — render it verbatim into a QR; **do not** post-process it or treat it as a normal HTTPS checkout link. Terminal clients may render ASCII QR. Chat clients should send a generated QR image via the channel's media/image path.

### 4.4 Polling / timeout / close strategy

- **Poll interval**: 3s (mirrors the alipay-bot polling model); `verify()` queries the order once per tick.
- **Total timeout**: default 5min (<= WeChat's default order lifetime). `createPaymentRequirements` may set `time_expire`.
- **Terminal states**: `SUCCESS` → success, stop; `CLOSED`/`PAYERROR` → failure, stop; timeout → call close API, then stop.
- **Idempotency**: both `verify()` and `settle()` are pure query/confirm, safe to retry; no side effects.
- **Concurrency**: multiple distinct `code_url`s may poll concurrently without interference (but each code is still one-code-one-payment).

### 4.5 Scenario driver (agent usage sketch)

```ts
import { WechatFacilitator } from 'moltspay/facilitators';
import qrcode from 'qrcode-terminal';

const wechat = new WechatFacilitator(cfg);

// 1) Issue a code (payer-agnostic)
const { x402Accepts, codeUrl, outTradeNo } =
  await wechat.createPaymentRequirements({ priceCny: '10.00', description: 'a cup of coffee' });

// 2) Render the QR — whoever scans pays.
// CLI terminals can use ASCII QR; chat UIs should upload a QR image.
qrcode.generate(codeUrl, { small: true });

// 3) Poll until someone pays
const paid = await pollUntilPaid(wechat, outTradeNo, { intervalMs: 3000, timeoutMs: 300_000 });
//    internally loops wechat.verify({ payload: { out_trade_no } }, x402Accepts)

// 4) Confirm received
if (paid.valid) console.log('payment received', paid.details.transaction_id);
```

> Note: scenario A confirms via **polling** (no async notify), so this milestone does **not** need `aesgcm.ts` callback decryption; that helper and the notify webhook are deferred to Phase 2.

## 5. File change list (mirrors the Alipay five layers)

### 5.1 New crypto helpers `src/facilitators/wechat/`

**`sign.ts`** — SHA256-RSA sign/verify
```ts
// Build the signing string and sign with the merchant private key (PKCS#1 v1.5, RSA-SHA256)
export function wechatV3Sign(
  method: string, urlPath: string, timestamp: string,
  nonce: string, body: string, privateKeyPem: string
): string;

// Build the Authorization header value
export function buildAuthorizationToken(args: {
  mchid: string; serialNo: string; nonce: string;
  timestamp: string; signature: string;
}): string;

// Verify a response/callback signature with the platform public key; never throws, returns false on failure
export function wechatV3VerifyResponse(
  timestamp: string, nonce: string, body: string,
  signature: string, platformPublicKeyPem: string
): boolean;
```

**`aesgcm.ts`** (Phase 2) — callback resource decryption
```ts
// AES-256-GCM decrypt (ciphertext includes the 16B auth tag, base64)
export function decryptResource(
  args: { ciphertext: string; nonce: string; associatedData: string },
  apiV3Key: string  // 32 bytes
): string;  // UTF-8 plaintext JSON
```

**`api.ts`** — generic v3 JSON caller
```ts
export interface WechatV3Config {
  mchid: string; serial_no: string;
  private_key_pem: string;
  platform_public_key_pem?: string;  // present => verify responses
  apiv3_key?: string;
  api_base?: string;  // default https://api.mch.weixin.qq.com
}
// auto Authorization, optional verify, uniform error (non-2xx throws with code/message)
export async function wechatV3Call(
  method: 'GET' | 'POST', urlPath: string,
  body: Record<string, unknown> | null, config: WechatV3Config
): Promise<{ status: number; body: any }>;
```

### 5.2 Facilitator `src/facilitators/wechat.ts`

```ts
export const WECHAT_NETWORK = 'wechat';
export const WECHAT_SCHEME = 'wechatpay-native';
export const WECHAT_API_BASE = 'https://api.mch.weixin.qq.com';
export const WECHAT_AMOUNT_REGEX = /^\d+(\.\d{1,2})?$/;  // yuan, <= 2 decimals

export interface WechatFacilitatorConfig {
  mchid: string; appid: string; serial_no: string;
  private_key_pem: string; platform_public_key_pem?: string;
  apiv3_key?: string; notify_url: string; api_base?: string;
}

export class WechatFacilitator extends BaseFacilitator {
  readonly name = 'wechat';
  readonly displayName = 'WeChat Pay';
  readonly supportedNetworks = [WECHAT_NETWORK];

  // Native order create -> code_url + out_trade_no; yuan->fen via cnyToFen
  async createPaymentRequirements(opts): Promise<WechatPaymentRequirements>;
  async verify(payload, req): Promise<VerifyResult>;   // order query trade_state
  async settle(payload, req): Promise<SettleResult>;   // idempotent confirm SUCCESS
  async healthCheck(): Promise<HealthCheckResult>;
}

// yuan -> fen, rounded to avoid float drift
export function cnyToFen(cny: string): number { return Math.round(parseFloat(cny) * 100); }
```

**`verify()` semantics**:
- extract `out_trade_no` (from `payload.payload` or `requirements.extra.out_trade_no`)
- `GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=`
- `trade_state === 'SUCCESS'` → `{ valid: true, details: { transaction_id, amount, ... } }`
- `NOTPAY`/`CLOSED`/error → `{ valid: false, error }`, **never throws**

**`settle()` semantics**: Native captures funds at SUCCESS; `settle` re-queries to confirm SUCCESS and returns `transaction_id`. Failure is fire-and-forget (same policy as Alipay `fulfillment.confirm` — do not roll back an already-delivered resource).

### 5.3 Registry / exports
- `registry.ts`: `this.registerFactory('wechat', (config) => new WechatFacilitator(config as ...))`
- `facilitators/index.ts`: export `WechatFacilitator` + types + `WECHAT_NETWORK/WECHAT_SCHEME`

### 5.4 Rail metadata `chains/index.ts`
```ts
export const WECHAT_CHAIN_ID = 'wechat' as const;
export const WECHAT_RAIL = {
  id: WECHAT_CHAIN_ID, type: 'fiat-rail' as const,
  currency: 'CNY' as const, decimals: 2 as const,
  facilitator: 'wechatpay-native' as const,
} as const;
export function isWechatChainId(id: string): id is typeof WECHAT_CHAIN_ID {
  return id === WECHAT_CHAIN_ID;
}
```

### 5.5 Config schema `schemas/moltspay.services.schema.json`
- add `"wechat"` to the `provider.chain` / `provider.chains` enums
- add `provider.wechat` (required: `mchid, appid, serial_no, private_key_path, apiv3_key, notify_url`; optional: `platform_public_key_path`)
- add per-service `services[].wechat`: `{ price_cny, description }`

### 5.6 Server integration `server/index.ts`
- **Construction**: read `this.manifest.provider.wechat`, resolve PEM paths → build `WechatFacilitatorConfig` → inject into `facilitatorConfig.config.wechat` + add to fallback; fatal on key-load failure (same as Alipay)
- **`/execute` dispatch** (~line 721):
  ```ts
  if (payScheme === WECHAT_SCHEME || (payNetwork ? isWechatChainId(payNetwork) : false)) {
    return this.handleWechatExecute(skill, params || {}, payment, res);
  }
  ```
- **402 challenge**: add `buildWechatChallenge(config)` (mirrors `buildAlipayChallenge`), push into `accepts[]`; carry `code_url` in `accepts.extra` for the client QR

### 5.7 Config example `moltspay.services.json`
```json
{
  "provider": {
    "name": "Demo",
    "chains": ["base", "alipay", "wechat"],
    "wechat": {
      "mchid": "1900000001",
      "appid": "wx8888888888888888",
      "serial_no": "5157F09EFDC096DE15EBE81A47057A72...",
      "private_key_path": "./cert/wechat_apiclient_key.pem",
      "platform_public_key_path": "./cert/wechat_platform_cert.pem",
      "apiv3_key": "your32byteapiv3keyhere0123456789",
      "notify_url": "https://your.host/wechat/notify"
    }
  },
  "services": [{
    "id": "translate",
    "name": "Translate",
    "price": 0.01, "currency": "USDC",
    "wechat": { "price_cny": "0.10", "description": "Translation service" }
  }]
}
```

---

## 6. Test plan (mirrors `test/facilitators/alipay/`)

| Test | Coverage |
|---|---|
| `wechat/sign.test.ts` | runtime-generated 2048-bit RSA keypair; correct signing string, verify passes, cross-key isolation, `buildAuthorizationToken` format |
| `wechat/aesgcm.test.ts` (Phase 2) | self-encrypt/decrypt roundtrip; wrong apiv3 key / tampered ciphertext → throws |
| `wechat/facilitator.test.ts` | mock fetch; yuan→fen conversion, Native request body, `code_url` passthrough, verify/settle states, healthCheck |
| `server/wechat-*.test.ts` (M3/Phase 2) | manifest parse + 402 accepts includes the wechat entry |

Acceptance: `npm run test:run` all green + `npm run typecheck` (`tsc --noEmit`) zero errors + `npm run build` (tsup) passes.

---

## 7. Risks and mitigations

| Risk | Level | Mitigation |
|---|---|---|
| yuan/fen unit confusion | High | `cnyToFen` single conversion + `Math.round` against float drift + regex check, unit-tested (`"0.10"→10`) |
| Response/callback not verified (fund safety) | High | `wechatV3VerifyResponse` enforced; platform cert injected in v1, later auto-download + rotation via `/v3/certificates` |
| Async nature of scan payment | Medium | `verify` is a single query, the client polls (same model as alipay-bot); optionally wire a notify webhook for proactive confirmation |
| Not an autonomous agent payment | Medium | Doc states clearly: this rail requires a human to scan, unlike Alipay's autonomous flow |
| Platform certificate expiry | Low | Certificate auto-download scheduled for 2.2.0 |

---

## 8. Phasing

- **Phase 1 (this design, server verify/settle)**: 5.1–5.6 + tests. Delivers a usable WeChat Native collection rail (human scans).
- **Phase 2**: async notify webhook route (reusing callback verify + `aesgcm.ts`) + platform certificate auto-download/rotation.
- **Phase 3 (external dependency)**: if WeChat ships an autonomous agent-payment product, build the agent-side autonomous payment client (counterpart of `alipay-bot`).

---

## 9. Effort

About **10 new files + 4 integration points + 6 test files**, same order of magnitude as the 2.0.0 Alipay integration. The core verify/settle logic is simple (one signed call + one order query); complexity concentrates in the `sign`/`aesgcm`/`api` helpers, all on standard Node `crypto` with **no new third-party dependency**.
