# MoltsPay × Alipay AI Pay (支付宝 AI 收) Integration (Design Doc)

> **Status**: Draft v1 · pending review
> **Created**: 2026-05-28
> **Author**: Claude (in collaboration with Yaqing)
> **Related documents**:
> - `~/clawd/docs/alipay-aipay-402-protocol.md` — server-side 402 protocol (sr007.com battle-tested reference implementation)
> - `~/clawd/docs/alipay-skill-integration-guide.md` — client-side CLI onboarding flow (`alipay-bot` official)
> - `./ALIPAY-INTEGRATION-PLAN.md` — execution checklist for this design (milestones + acceptance criteria)
> - `../src/facilitators/interface.ts` — Facilitator abstraction

---

## 1. Goals and Non-Goals

### Goals
1. In `moltspay@1.7.0`, integrate **Alipay AI Pay (aipay) as the 9th "rail"** into the MoltsPay SDK, coexisting with the existing Base / Polygon / BNB / Solana / Tempo in the same `moltspay.services.json` config file
2. Let a service provider expose any skill to **AI Agents payable in either RMB or USDC** with one line of JSON, routed on the Agent side by preference/capability
3. Reuse the existing `Facilitator` abstraction, adding `AlipayFacilitator` with **minimal code intrusion**
4. Two-way compatibility with the official `alipay-bot` CLI: the existing `@alipay/agent-payment` skill running on OpenClaw / Claude Code is unaffected

### Non-Goals
- 1.7.0 does not implement **browser-side (`moltspay/web`)** Alipay payment (`alipay-bot` is a Node CLI with no browser implementation). Cashier URL fallback to be discussed in 1.7.x
- No **CNY ↔ USDC real-time exchange-rate conversion**. The service provider explicitly declares two sets of prices in config
- Not a replacement for `alipay-bot`. The client continues to shell-out to the CLI (rationale in §5.2)

---

## 2. Protocol Differences vs x402 (must be understood first)

| Aspect | x402 (USDC / EVM / SVM) | Alipay AI Pay |
|------|--------------------------|--------------|
| 402 challenge header | `X-Payment-Required` (JSON array, multiple accepts) | `Payment-Needed` (Base64URL single JSON) |
| Challenge structure | Flat `accepts: [{scheme, network, asset, amount, payTo, ...}]` | **Nested** `{protocol: {...}, method: {...}}` |
| Amount unit | atomic units (USDC 6 decimals, BNB 18 decimals) | **yuan (元)** (decimal string `"1.00"`) |
| Currency | USDC / pathUSD / alphaUSD | CNY (`"currency": "CNY"`) |
| Signature | EIP-712 / EIP-3009 / EIP-2612 permit / SPL transfer | **RSA2 (SHA256WithRSA)** merchant private key signs 8 fields |
| Client payment | Wallet signs → facilitator settles on-chain | User confirms inside the Alipay app → trade_no + payment_proof |
| Proof header | `X-Payment` | `Payment-Proof` (Base64URL) |
| Verify | On-chain RPC verifies signature + balance + transfer event | HTTP call to `alipay.aipay.agent.payment.verify` |
| Settle | On-chain broadcast transferWithAuthorization / transferFrom | Call `alipay.aipay.agent.fulfillment.confirm` (fulfillment confirmation) |
| Failure semantics | settle failure must return 402 (false-positive 200 fixed in 1.6.0) | Same — verify or fulfillment failure must both 402 |
| Browser | Supported since 1.6.0 | **Not supported** (CLI-only) |
| Compliance | Global (permissionless on-chain) | China-mainland merchants only (ICP filing + business-license onboarding required) |

**Key observation**: despite the huge difference in protocol shape, **the core abstraction of both is "402 challenge → user pays → proof → verify → fulfill"** — **fully isomorphic** to MoltsPay's `Facilitator` interface (`verify` + `settle`). So the core of this design is to treat Alipay as a Facilitator with a peculiar signing/verification mechanism.

---

## 3. Architecture Decisions

### Decision 1: Alipay as chain id `alipay`; do **not** add a rail abstraction

**Option A**: add a `PaymentRail` abstraction layer (`EVMRail` / `SolanaRail` / `AlipayRail`)
**Option B**: treat `alipay` as another chain id, reusing the `Facilitator` abstraction ✅

**Reasons for B**:
- The existing 8 chains are already heterogeneous in signing mechanisms (BNB EIP-712 PaymentIntent ≠ Base EIP-3009 ≠ Solana SPL ≠ Tempo permit); Alipay is just one more
- Introducing a `Rail` abstraction would force 1.7.0 to touch the code paths of all 8 chains — violating MoltsPay's "additive by default" engineering stance
- The `chain id` string is sufficient as a namespace (`"alipay"` already makes clear it is neither EVM nor SVM)

**Cost**: the semantics of the `network` field get diluted (no longer strictly a "blockchain network"; it may be a payment rail). A comment in `src/chains/index.ts` suffices; no runtime complexity is introduced.

### Decision 2: **Extend, don't replace,** the x402 wire format

The server's 402 response sends two headers simultaneously:
- `X-Payment-Required` (x402 standard, with a `scheme: "alipay-aipay"` entry added to the accepts array)
- `Payment-Needed` (Alipay standard, Base64URL nested JSON)

**Why send both**:
- The existing `alipay-bot` CLI only recognizes `Payment-Needed` — without it, every existing skill running on OpenClaw / Claude Code breaks
- The existing moltspay Node client only recognizes `X-Payment-Required` — without it, there is no way to take the alipay path inside the same `moltspay` client
- The two headers mirror each other's content, generated uniformly by server middleware; the **single source of truth lives in the server config**

Whether the request receives `Payment-Needed` is declared by the `Accept-Payment-Rail` request header (when absent, both are sent, for old-client compatibility).

### Decision 3: Client shells out to `alipay-bot` first; native implementation in 1.8.x

**1.7.0 client strategy**: `moltspay pay --rail alipay <url>` internally spawns the `alipay-bot` CLI

**Rationale**:
- `alipay-bot@0.3.15` has already stepped on all 6 pitfalls (PARSE_ERROR, Base64URL, amount unit, signature field set, Base64 padding, client_session extraction) — see alipay-aipay-402-protocol.md §9
- A native implementation requires RSA2 + the Alipay Open Platform SDK + the full call chain for wallet activation/binding/query/fulfillment, **estimated at 6-8 weeks**; the wrapper is estimated to **ship within 1 week**
- Cadence: 1.7.0 brings Alipay in (native on the server, wrapper on the client); 1.8.0 decides on a native TS client based on real usage

**Cost**: the client must require Node ≥ 22 (alipay-bot's requirement); the `moltspay/web` rail list does not include `alipay`.

### Decision 4: Server side is 100% native TS, no dependency on an external alipay service

**Rationale**:
- The server handles a private key (the RSA2 merchant private key) — this should not be outsourced to an npm subprocess
- Server-side alipay integration logic stays controllable, testable, auditable — `sr007.com` has already run end-to-end in Python, so the TS port is not hard
- A native server implementation lets us uniformly control cors / cors-expose / error codes / logging inside `MoltsPayServer`

---

## 4. Config Schema Changes

### 4.1 `moltspay.services.json` extension (backward compatible)

```json
{
  "provider": {
    "name": "灵机一物",
    "wallet": "0xYOUR_EVM_WALLET",
    "solana_wallet": "YOUR_SOL_WALLET",
    "alipay": {
      "seller_id": "2088641494699428",
      "app_id": "2021006150642142",
      "seller_name": "上海超响应数字科技有限公司",
      "service_id_default": "API_0EA6DC4FC99A4DF7",
      "private_key_path": "./cert/ALIPAY_PRIVATE_KEY.txt",
      "alipay_public_key_path": "./cert/ALIPAY_PUBLIC_KEY.txt",
      "gateway_url": "https://openapi.alipay.com/gateway.do",
      "sign_type": "RSA2"
    },
    "chains": ["base", "polygon", "solana", "bnb", "alipay"]
  },
  "services": [{
    "id": "text-to-video",
    "function": "textToVideo",
    "price": 0.99,
    "currency": "USDC",
    "alipay": {
      "service_id": "API_0EA6DC4FC99A4DF7",
      "price_cny": "7.00",
      "goods_name": "产品演示视频 - 系列一"
    }
  }]
}
```

**Compatibility rules**:
- `provider.alipay` absent → the server does not add the alipay scheme to the accepts array; behavior is identical to today's 1.6.0
- `services[].alipay` absent → that service does not support Alipay, on-chain payment only
- `"alipay" in provider.chains` triggers a server startup check that `provider.alipay.private_key_path` is readable and the RSA private key is valid

### 4.2 chains registry extension

Add to `src/chains/index.ts`:
```ts
export const ALIPAY_RAIL = {
  id: "alipay",
  type: "fiat-rail" as const,  // new enum value, peer of "evm" / "svm"
  currency: "CNY",
  decimals: 2,
  facilitator: "alipay-aipay",
} as const;
```

---

## 5. Implementation Breakdown

### 5.1 Server side: `src/facilitators/alipay.ts`

Implements the `Facilitator` interface (following the existing shape of `bnb.ts` / `tempo.ts`).

```ts
export class AlipayFacilitator implements Facilitator {
  network = "alipay";
  scheme = "alipay-aipay";

  // Build the 402 challenge — RSA2-sign 8 fields, output Payment-Needed Base64URL
  async createPaymentRequirements(opts: CreatePaymentReqOpts): Promise<{
    x402Accepts: X402PaymentRequirements;   // feeds X-Payment-Required
    paymentNeededHeader: string;            // feeds Payment-Needed
  }> {
    const sign_params = {
      amount: opts.priceCny,                          // "1.00"
      currency: "CNY",
      goods_name: opts.goodsName,
      out_trade_no: `VID${randomBase58(29)}`,
      pay_before: addMinutesISO(30),
      resource_id: opts.resourceId,
      seller_id: this.config.seller_id,
      service_id: opts.serviceId,
    };
    const seller_signature = rsa2Sign(
      sortedQuerystring(sign_params),
      this.config.privateKey
    );
    const challenge = {
      protocol: { ...sign_params, seller_signature, seller_sign_type: "RSA2", seller_unique_id: this.config.seller_id },
      method:   { seller_name: this.config.seller_name, seller_id: this.config.seller_id,
                  seller_app_id: this.config.app_id, goods_name: opts.goodsName,
                  seller_unique_id_key: "seller_id", service_id: opts.serviceId },
    };
    return {
      x402Accepts: this.toX402Accepts(sign_params),
      paymentNeededHeader: base64url(JSON.stringify(challenge)),
    };
  }

  // Verify signature + call alipay.aipay.agent.payment.verify
  async verify(payload: AlipayPaymentProof): Promise<VerifyResult> {
    const decoded = decodeBase64UrlWithPadFix(payload.proofHeader);   // §9.5 padding fix
    const { payment_proof, trade_no } = decoded.protocol;
    const { client_session } = decoded.method;
    const resp = await this.alipayOpenApiCall("alipay.aipay.agent.payment.verify", {
      payment_proof, trade_no, client_session,
    });
    return resp.code === "10000"
      ? { valid: true, details: { trade_no, amount: resp.amount, out_trade_no: resp.out_trade_no } }
      : { valid: false, error: `alipay-verify ${resp.code}: ${resp.msg}` };
  }

  // Fulfillment confirmation (async)
  async settle(verifyResult: VerifyResult): Promise<SettleResult> {
    const trade_no = verifyResult.details!.trade_no as string;
    const resp = await this.alipayOpenApiCall("alipay.aipay.agent.fulfillment.confirm", { trade_no });
    return resp.code === "10000"
      ? { success: true, transaction: trade_no, status: "fulfilled" }
      : { success: false, error: `alipay-fulfill ${resp.code}: ${resp.msg}` };
  }

  async healthCheck(): Promise<HealthCheckResult> { /* ping gateway, validate private key */ }
}
```

**New files**:
- `src/facilitators/alipay.ts` — the class above, ~250 lines
- `src/facilitators/alipay/openapi.ts` — `alipayOpenApiCall(method, params)` generic caller (signing, application/x-www-form-urlencoded, error-code mapping), ~120 lines
- `src/facilitators/alipay/rsa2.ts` — `rsa2Sign(data, pem)` + `rsa2Verify(data, sig, pem)`, using Node's built-in `crypto`, ~50 lines
- `src/facilitators/alipay/encoding.ts` — `base64url` / `decodeBase64UrlWithPadFix` (pad restoration), ~30 lines

**Modified files**:
- `src/facilitators/registry.ts` — register the `"alipay-aipay"` scheme → `AlipayFacilitator`
- `src/facilitators/index.ts` — export
- `src/server/index.ts` — the 402 middleware, upon detecting provider.alipay config, **double-sends** `X-Payment-Required` and `Payment-Needed` in the response; the `/proxy` and `/execute` paths dispatch to `AlipayFacilitator.verify` on receiving a `Payment-Proof` header
- `src/chains/index.ts` — register the `"alipay"` chain id

### 5.2 Client side: Node CLI wrapper + state machine + rail routing

The client is the subtlest part of this design — it is not "run the server-side flow in the other direction" but involves three things: **shell-out decisions / asynchronous user behavior / multi-rail routing**, a completely different class of problem from the server's native RSA2 implementation.

#### 5.2.1 Decision matrix: why wrap the CLI instead of going native TS

| Option | Effort | Ships in 1.7.0? | Risk |
|------|--------|-------------|------|
| **A. shell-out wrapping `alipay-bot@0.3.15`** ✅ | 1 week | Yes | Node-only; alipay-bot upgrades require version tracking |
| B. Native TS implementation (RSA2 + full wallet activation/binding/query/receipt chain) | 6-8 weeks | No | Reinventing the wheel, debugging the Alipay sandbox + assorted wallet states, etc. |
| C. Call the Alipay Open Platform REST API directly (bypassing the CLI) | 4-5 weeks | No | The CLI already encapsulates business states like "wallet activation authorization / payment-intent / session-id management" that REST does not expose |

**Choose A** — `alipay-bot` has already stepped on all 6 pitfalls in alipay-aipay-402-protocol.md §9 (PARSE_ERROR, Base64URL, amount yuan/fen, 8 signature fields, padding restoration, client_session extraction); a rewrite would mean stepping on all of them again.

**Do B in 1.8.0**, with priority driven by real 1.7.x usage data.

#### 5.2.2 The 3 user-facing API surfaces

**CLI (aligned with `--chain`)**:
```bash
moltspay pay --rail alipay https://sr007.com/api/v1/videos/v_001 \
  --intent "购买产品演示视频"
```

**Programmatic SDK**:
```ts
import { MoltsPayClient } from "moltspay/client";

const client = new MoltsPayClient({
  railPreference: ["base", "alipay"],          // routing policy
  alipay: { sessionId: process.env.AIPAY_SESSION_ID }  // optional
});

const result = await client.pay("https://sr007.com/api/v1/videos/v_001", {
  rail: "alipay",
  onPaymentPending: ({ paymentUrl, tradeNo }) => {
    console.log("Scan with Alipay:", paymentUrl);
  },
});
```

**MCP tool**: `alipay_pay_402(url, intent_summary)` — runs all 8 steps end to end; the MCP host (Claude Desktop / Cursor) only needs to call once.

#### 5.2.3 The 8-step state machine and its Promise-ification

Skill guide §5 mandates the 8 steps and **strictly forbids skipping any**. `AlipayClient.pay402()` is a state machine; each step corresponds to one `spawn('alipay-bot', [...])`:

```
SDK call                                  Internal command                                      User perception
─────────────────────────────────────────────────────────────────────────────────────────────────
client.pay(url, { rail: "alipay" })
        │
        ├─ Step 1b  alipay-bot payment-intent --session-id <uuid> --framework moltspay ...
        ├─ Step 2   alipay-bot check-wallet                                                not activated → NeedsWalletSetupError
        ├─ Step 3   save Payment-Needed to ~/.moltspay/alipay/402_<reqId>.txt              (internal, invisible to user)
        ├─ Step 4   alipay-bot 402-buyer-pay -f <file> -r <url> [-m POST -d ...]           ← obtain paymentUrl + tradeNo
        │           │
        │           └─→ onPaymentPending({ paymentUrl, tradeNo, shortenUrl })             ← callback surfaced to the caller
        │
        ├─ Step 5   poll: alipay-bot 402-query-payment-status -t <tradeNo> -r <url>        loop until success/timeout
        │           interval = 3s, timeout = pay_before (default 30 minutes)
        │           interruptible via AbortSignal
        │
        ├─ Step 7   return resourceResponse.body verbatim to the caller
        └─ Step 8   alipay-bot 402-buyer-fulfillment-ack -t <tradeNo>                      (async fire-and-forget)
```

**Key design**: Step 5 polling does not block on the call stack; instead the SDK internally wraps it as an async `pollUntil(tradeNo, signal)` function, and the caller receives a **final `PaymentResult`** (success / failure / timeout). This aligns alipay's "long-tail user behavior" with the "auto-wait" semantics of EVM chain settle — the caller does not need to write alipay-specific code.

#### 5.2.4 Shell-out engineering details

**spawn vs exec**: use `child_process.spawn`, **not** `exec` — because:
- Skill guide §5 Step 4 mandates **"CLI output must be relayed to the user character-for-character; modifying/wrapping/omitting is forbidden"** — only `spawn`'s stream API can do line-level forwarding
- Content like `paymentUrl` contains a **cryptographic signature**; any truncation invalidates it
- alipay-bot emits `MEDIA:` lines (image paths) that must be detected per line, extracted, stripped, then surfaced

```ts
// src/client/alipay/cli.ts (core)
async function runCli(args: string[], opts: { onLine: (line: string) => void; signal?: AbortSignal }) {
  const child = spawn("alipay-bot", args, { env: filterEnv(process.env) });
  opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"));

  child.stdout.on("data", chunk => splitLines(chunk).forEach(opts.onLine));   // line-level verbatim forwarding
  // stderr handled the same way
  return new Promise<number>(resolve => child.on("exit", code => resolve(code ?? 1)));
}
```

**Environment variable allowlist**: skill guide §7 is explicit: "**only the following environment variables may be passed; passing any other variable is forbidden**".
```ts
const ALLOW = new Set([
  "AIPAY_OUTPUT_CHANNEL", "AIPAY_SESSION_ID",
  "AIPAY_FRAMEWORK", "AIPAY_MODEL", "AIPAY_OS",
  "PATH", "HOME",   // minimal survival set for spawn
]);
function filterEnv(e: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(e).filter(([k]) => ALLOW.has(k)));
}
```

**Installation and version check**: validated once at startup:
```ts
async function ensureCli() {
  try {
    const { stdout } = await execFile("alipay-bot", ["--version"]);
    const v = stdout.match(/v(\d+\.\d+\.\d+)/)?.[1];
    if (!v || semver.lt(v, "0.3.15")) {
      throw new AlipayCliVersionError(
        `alipay-bot ${v ?? "?"} found, need ≥ 0.3.15. ` +
        `Run: npx -y @alipay/agent-payment@latest update`
      );
    }
  } catch (e: any) {
    if (e.code === "ENOENT") throw new AlipayCliNotFoundError(
      "alipay-bot not installed. Run: npx -y @alipay/agent-payment install-cli"
    );
    throw e;
  }
}
```

**No** automatic `npm install` — that is a side-effecting global/local modification requiring explicit user consent (consistent with 1.6.0's long-standing "never silently modify the user's environment" principle).

**sessionId handling**: skill guide §5 Step 1b: **`sessionId` must be a UUID; fabricating one yourself is forbidden**. We interpret this as "forbidden to fabricate a string that merely looks like a session" and **not** "the SDK is forbidden from generating a UUID". So:
```ts
const sessionId = opts.sessionId
  ?? process.env.AIPAY_SESSION_ID
  ?? crypto.randomUUID();   // a legitimate UUID, not "fabricated"
```

**Strict tradeNo validation**: skill guide §5 Step 8: `tradeNo` must be a 32-digit numeric string; refuse to proceed on failed validation — implement it at the SDK layer instead of relying on the CLI:
```ts
function assertTradeNo(t: string) {
  if (!/^\d{32}$/.test(t)) throw new AlipayProtocolError(`invalid tradeNo: ${t}`);
}
```

#### 5.2.5 Multi-rail routing: server offers two rails — how does the client pick?

This is the genuinely new problem alipay introduces — before 1.6.0 a service accepted exactly one payment method. From 1.7.0 on, the server's 402 accepts array may simultaneously contain USDC (Base) and CNY (Alipay).

**Routing decision tree**:
```
1. Did the caller pass { rail: "alipay" } / --rail alipay?
     → use alipay; if the server does not accept alipay → UnsupportedRailError
2. Otherwise check client.railPreference config (ordered list)
     → take the first entry in the intersection with the server's accepts
3. Otherwise check the client's actual capabilities
     → has an EVM wallet funded with USDC → take EVM
     → otherwise alipay-bot online and wallet activated → take alipay
4. Otherwise → server accepts[0]
```

`railPreference` is client-side config, **not** a global environment — because the same Agent may serve two kinds of callers: "Chinese users preferring Alipay, overseas users preferring USDC".

#### 5.2.6 Error model (aligned with 1.6.0 style)

All new error classes carry a stable `code` field (a convention established in 1.6.0):
```ts
// src/client/alipay/errors.ts
export class AlipayCliNotFoundError      extends MoltsPayError { code = "ALIPAY_CLI_NOT_FOUND" }
export class AlipayCliVersionError       extends MoltsPayError { code = "ALIPAY_CLI_VERSION" }
export class NeedsWalletSetupError       extends MoltsPayError { code = "ALIPAY_NEEDS_WALLET_SETUP" }
export class AlipayPaymentRejectedError  extends MoltsPayError { code = "ALIPAY_PAYMENT_REJECTED" }
export class AlipayPaymentTimeoutError   extends MoltsPayError { code = "ALIPAY_PAYMENT_TIMEOUT" }
export class AlipayProtocolError         extends MoltsPayError { code = "ALIPAY_PROTOCOL" }
export class UnsupportedRailError        extends MoltsPayError { code = "UNSUPPORTED_RAIL" }
```

This lets an MCP host / upstream Agent make decisions based on `error.code`: `ALIPAY_CLI_NOT_FOUND` guides the user to install, `ALIPAY_NEEDS_WALLET_SETUP` guides the user to activate the wallet, `ALIPAY_PAYMENT_TIMEOUT` retries once.

#### 5.2.7 Browser scenario (`moltspay/web`)

**1.7.0 flatly gives up on browser alipay**:
```ts
// src/client/web/alipay.ts
export class AlipayWebClient {
  async pay(): Promise<never> {
    throw new UnsupportedChainError(
      "alipay rail is not available in browser; use the Node CLI or wait for v1.8.0"
    );
  }
}
```

The reason is that `alipay-bot` is a Node CLI and cannot run in a browser. 1.6.0 already paid the honest price of 5/8 chains lacking browser E2E on the `moltspay/web` line; 1.7.0 has no business stuffing in one more false promise.

**The 1.7.1 / 1.8.0 browser path** would be: use the Alipay **cashier URL** (skill guide §6) so the user jumps out of the browser to the Alipay web page/app to complete payment, with the frontend polling `tradeNo` status — that is a separate design, out of scope here.

#### 5.2.8 Minimal working demo (what a caller writes once this lands)

```ts
import { MoltsPayClient } from "moltspay/client";

const c = new MoltsPayClient();

const out = await c.pay("https://www.sr007.com/api/v1/videos/v_001", {
  rail: "alipay",
  onPaymentPending: ({ paymentUrl, shortenUrl, tradeNo }) => {
    // Relay the payment link to the user verbatim in CLI / MCP; re-wrapping is forbidden
    process.stdout.write(`请用支付宝扫码或访问：${shortenUrl}\n`);
  },
  timeoutMs: 30 * 60_000,
});

console.log(out.body);              // resource content (video URL / binary)
console.log(out.payment.tradeNo);   // 32-digit tradeNo
```

SDK internal states: `spawn alipay-bot payment-intent` → `spawn alipay-bot check-wallet` → dump the `Payment-Needed` header to a tmp file → `spawn alipay-bot 402-buyer-pay -f ...` with streaming callbacks → poll `402-query-payment-status` → obtain the body → fire-and-forget `402-buyer-fulfillment-ack`.

#### 5.2.9 New/modified file inventory

**New files**:
- `src/client/alipay/index.ts` — `AlipayClient` class + `pay402()` 8-step state machine, ~250 lines
- `src/client/alipay/cli.ts` — `spawn` wrapper, stdout/stderr streaming callbacks, env allowlist, timeout control (aligned with `SKILL_TIMEOUT_SECONDS`), ~120 lines
- `src/client/alipay/poll.ts` — `pollUntil(tradeNo, signal)` poller (3s interval, AbortSignal interruption, `pay_before` deadline), ~60 lines
- `src/client/alipay/install.ts` — `ensureCli()` version check (≥ 0.3.15) + installation-guidance error copy, ~40 lines
- `src/client/alipay/router.ts` — `selectRail(serverAccepts, userPref, availability)` routing decision, ~80 lines
- `src/client/alipay/errors.ts` — the 7 error classes above, each with a stable `code` field, ~50 lines

**Modified files**:
- `src/client/index.ts` — `MoltsPayClient.pay()` wires in `selectRail()`, dispatching to `AlipayClient` when alipay is selected
- `src/client/web/index.ts` — register the `AlipayWebClient` stub (throws `UnsupportedChainError` directly)
- `src/cli/index.ts` — `moltspay pay --rail alipay <url>` subcommand; `moltspay alipay check / apply / bind` pass through to the CLI (for the user's initial wallet activation)

**Forbidden**: providing a real alipay implementation under `src/client/web/`. Any web bundle reaching `AlipayClient` throws `UnsupportedChainError("alipay not supported in browser")` directly; 1.7.0 does not budge.

### 5.3 MCP: `src/mcp/tools/alipay.ts`

Expose the client capabilities as MCP tools:
- `alipay_check_wallet`
- `alipay_pay_402(url, intent_summary)` — runs the full 8 steps internally, returns the final resource body
- `alipay_pay_cashier(cashier_url, intent_summary)` — cashier mode

Each tool's description must emphasize constraints such as the 32-digit numeric `tradeNo` validation and verbatim CLI output relay (these are hard requirements of Alipay's official integration protocol).

### 5.4 Types & schema updates

- `src/types/services.ts` — `ServiceDefinition` gains an optional `alipay?: { service_id, price_cny, goods_name }`
- `schemas/moltspay.services.schema.json` — JSON Schema extended in sync; the CI test `validate-config.ts` follows
- `src/types/x402.ts` — `X402PaymentRequirements.extra` is documented, under the alipay scheme, to contain `{ payment_needed_header: string }`, so clients can also obtain the alipay data from the standard envelope

### 5.5 Package exports

`package.json` `exports` gains no new subpaths — Alipay capability is assigned respectively to `./server` (`AlipayFacilitator`), `./client` (`AlipayClient`), and `./mcp` (tool registration), keeping the top-level API unpolluted.

---

## 6. Testing Strategy

Following the standard of the 1.6.0 Known Limitations section (which chains have real on-chain E2E, which only have unit-test coverage), the 1.7.0 alipay QA matrix is spelled out:

| Test tier | Scope | Must-pass items |
|----------|------|--------------|
| **Unit tests** (vitest) | RSA2 sign/verify, Base64URL padding fix, dictionary ordering of the 8 signature fields, nested challenge JSON structure | 100% coverage of `src/facilitators/alipay/*` |
| **Sandbox integration** | Run one 402 challenge → mock proof → verify → fulfill using an Alipay sandbox merchant | full server single-rail path |
| **Real end-to-end** (mandatory) | Using 1 real merchant (recommend reusing sr007.com / 上海超响应), run 1 order of 1 yuan CNY, screen-recorded end-to-end from `moltspay-bot pay --rail alipay` through `alipay.aipay.agent.fulfillment.confirm` | **1.7.0 latest must not ship without this passing** |
| **Regression** | At least 1 E2E order on each of the existing 8 chains, ensuring the server's double-header sending does not break 1.6.0 behavior | Old clients 100% unaware |
| **CLI compatibility** | Hit MoltsPayServer directly with the un-upgraded `@alipay/agent-payment@1.0.9` skill; payment must complete | Verifies the `Payment-Needed` header matches the official spec byte-for-byte |

**Mandatory**: the Known Limitations section of the 1.7.0 CHANGELOG must honestly state —
- What sandbox vs production vs end-to-end each cover
- Whether cashier mode (§6 of alipay-skill-integration-guide) is covered in 1.7.0
- That browser non-support for alipay is hard-coded, not "untested"

---

## 7. Risks & Mitigations

| Risk | Level | Mitigation |
|------|------|------|
| Merchant qualification bar (China ICP + business license) | High | Docs explicitly state "the alipay rail applies to China-mainland merchants only"; the CLI skips it at init when `provider.alipay` config is absent |
| `alipay-bot` CLI upgrades break the wrapper | Medium | Wrapper checks `alipay-bot --version` ≥ 0.3.15 at startup; lock the major version, auto-accept minors |
| Private key leakage (server holds the RSA2 private key) | High | File-path config rather than inline; log redaction (reuse existing audit utils); add a lint rule to `schemas/` forbidding `BEGIN RSA PRIVATE KEY` in any `.json` |
| Amount unit pitfall (yuan vs fen (分)) | Medium | `AlipayFacilitator.createPaymentRequirements` takes a strongly-typed `priceCny: string`, runtime regex-validated against `/^\d+(\.\d{1,2})?$/`; ambiguous values like `"100"` are rejected |
| Refund semantics when fulfillment confirmation fails | Medium | Per the 1.6.0 design principle: a failed fulfillment.confirm is not treated as success; when `--pay-for-success` mode is offered, fall back to not calling fulfillment (pay-for-failure reconciled asynchronously by the merchant themselves) |
| Payment-Proof base64 padding compatibility | Low | Known pitfall (§9.5), covered by unit tests |
| Existing `alipay-bot` users broken | High | Double-header design; CHANGELOG states "server 1.7.0 is fully backward compatible with alipay-bot 1.0.x"; run one end-to-end with an unmodified OpenClaw skill as regression |

---

## 8. Roadmap

| Version | Scope | Estimated duration | Exit criteria |
|------|------|----------|----------|
| **1.7.0-rc.1** | Server-side `AlipayFacilitator` + double header + sandbox E2E | 2 weeks | Sandbox passes; old-client regression passes |
| **1.7.0-rc.2** | Client-side `AlipayClient` (CLI wrapper) + `moltspay pay --rail alipay` | 1 week | Internal 1-yuan real-order end-to-end passes |
| **1.7.0** | MCP tool + docs (README §Alipay Rail) + CHANGELOG Known Limitations | 0.5 weeks | 3 production orders jointly tested with sr007.com, all fulfillment.confirm successful |
| **1.7.1** | Cashier mode (payment-link flow) + `alipay-bot` apply/bind/check fallback callbacks | Deferred | — |
| **1.8.0** | Native TS client (drop the `alipay-bot` dependency, support browser cashier-URL fallback) | Driven by 1.7.x usage data | 1-yuan real order passes in browser |

---

## 9. Open Questions (Yaqing's decisions needed)

1. **Merchant identity**: for 1.7.0 end-to-end testing, use sr007.com (with whom you already have a joint-test relationship), or spin up a MoltsPay-owned sandbox merchant? The former is fast but couples to an external team; the latter is clean but requires fresh Alipay merchant onboarding
2. **CLI subcommand naming**: `moltspay pay --rail alipay <url>` vs `moltspay alipay pay <url>`? The former is consistent with `--chain base`, the latter with `alipay-bot` habits — I lean toward the former, on the grounds that rail carries a "transport channel" semantic, sitting at the same level as the existing `--chain`
3. **Whether to use `"alipay"` directly in `provider.chains`**: or add a new `"provider.rails": ["alipay"]` field, separating fiat rails from chain rails at the schema layer? The latter is cleaner but breaks the exhaustive-set semantics of the existing `chains` array. I lean toward the former (everything is a chain id; the docs just need to explain it)
4. **Does 1.7.0 cover cashier mode (§6 of alipay-skill-integration-guide)?** This is "the user hands over an Alipay order link and the Agent pays it" — the reverse of 402 — more of a "proxy-payment wallet" than "selling a service". I lean toward pushing it to 1.7.1, since it has little to do with the server SDK and is mostly an MCP tool passing through to `alipay-bot submit-payment`
5. **Extent of README changes**: the 1.6.0 README is already 33KB; stuffing in Alipay content would blow it up. Leaning toward a standalone `docs/ALIPAY-RAIL.md` with a 5-line callout added to the README

---

## 10. Appendix: Compatibility Checklist vs the Official alipay-bot

Consistency is the precondition for painless user migration. MoltsPayServer in 1.7.0 must satisfy:

- [ ] The `Payment-Needed` header is Base64URL (not standard Base64) — §9.2
- [ ] Nested `{protocol: {...}, method: {...}}` structure — §9.1
- [ ] `amount` is a string denominated in yuan (`"1.00"`), not fen — §9.3
- [ ] The signature covers only 8 fields, concatenated in dictionary order, excluding `protocol` / `method` themselves — §9.4
- [ ] `pay_before` is ISO 8601, +30 minutes
- [ ] `Access-Control-Expose-Headers` additionally exposes `Payment-Needed` and `Payment-Proof` in browser CORS scenarios (aligned with 1.6.0 exposing `X-Payment-Required` / `X-Payment-Response`)
- [ ] base64 padding is automatically restored before decoding `Payment-Proof` — §9.5
- [ ] `client_session` is passed at verify time (taken from `method.client_session`) — §9.6
- [ ] The fulfillment-confirmation call `alipay.aipay.agent.fulfillment.confirm` is made asynchronously after the resource is returned, **never blocking the user's access to the resource**

---

*This document: Draft v1, awaiting Yaqing's decisions on the 5 items in §9 before entering the 1.7.0-rc.1 implementation phase.*
