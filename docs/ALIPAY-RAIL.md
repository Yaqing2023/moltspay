# Alipay Rail (支付宝 AI 收)

> **Target**: `moltspay@1.7.0`
> **Status**: Design complete, rc.1 implementation in progress
> **Scope**: Server + Node CLI client; browser **not supported** (hard-coded in 1.7.0; 1.8.0 falls back to a cashier URL)

Alipay Rail is the 9th rail introduced in MoltsPay 1.7.0 (following Base / Polygon / Solana / BNB / Tempo / XRPL). It lets China-mainland merchants use Alipay AI Pay (支付宝 AI 收) to offer CNY-priced services to AI Agents. One `provider.alipay` block plus a per-service `alipay` sub-object lets a single skill accept both USDC and CNY payments, with the Agent side routing by preference/capability.

## TL;DR

| Aspect | Value |
|---|---|
| Chain id | `"alipay"` (`type: "fiat-rail"`, peer of EVM/SVM) |
| Currency | CNY (`amount` is a string in **yuan (元)**, not fen) |
| Signature | RSA2 (SHA256WithRSA), merchant private key signs 8 fields concatenated in dictionary order |
| Client | Node CLI shell-out to `alipay-bot@0.3.15` (1.7.0); native TS deferred to 1.8.0 |
| Server | 100% native TS, holds the RSA2 private key |
| Browser | Not supported (throws `UnsupportedChainError`) |
| Merchant eligibility | **China mainland only** (ICP filing + business license + Alipay Open Platform onboarding) |
| 1.6.0 compatibility | server dual-sends `X-Payment-Required` + `Payment-Needed`; legacy `alipay-bot` skill works with 0 changes |

## 1. Prerequisites

Alipay AI Pay is **China-mainland merchants only** and requires passing the Alipay Open Platform onboarding review.

| Credential | Purpose |
|---|---|
| ICP filing (ICP 备案) | Required |
| Business license | Merchant onboarding |
| Alipay Open Platform account | Create the app + obtain keys |
| AI Pay product activation | Required |

After onboarding you will receive:
- `seller_id` (merchant ID, 16 digits)
- `app_id` (application ID, 16 digits)
- RSA2 merchant private key (`.txt`) + Alipay public key (`.txt`)
- `service_id` (service ID, shaped like `API_0EA6DC4FC99A4DF7`; the value shown on the "推进开发" (Promote Development) page is authoritative)

> For the onboarding flow see the official Alipay docs: https://ideservice.alipay.com/cms/site/0j7svz.md
>
> Overseas merchants or individual developers should use a USDC rail (Base / Polygon / Solana / BNB / Tempo) — no onboarding needed.

## 2. Server-side configuration

### 2.1 `provider.alipay`

```json
{
  "provider": {
    "name": "灵机一物",
    "wallet": "0xYOUR_EVM_WALLET",
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
    "chains": ["base", "polygon", "alipay"]
  }
}
```

| Field | Required | Description |
|---|---|---|
| `seller_id` | ✅ | Merchant Alipay ID |
| `app_id` | ✅ | Application ID |
| `seller_name` | ✅ | Merchant full legal name (`method.seller_name` in the 402 challenge) |
| `service_id_default` | ✅ | Default service_id; can be overridden per service |
| `private_key_path` | ✅ | Path to the RSA2 merchant private key file (relative to the directory containing `moltspay.services.json`) |
| `alipay_public_key_path` | ✅ | Path to the Alipay public key file (verifies `Payment-Proof`) |
| `gateway_url` | Optional | Defaults to `https://openapi.alipay.com/gateway.do`; sandbox uses `https://openapi.alipaydev.com/gateway.do` |
| `sign_type` | Optional | Defaults to `RSA2`, currently the only supported value |

> 🔒 **Private key security**: you must use the `private_key_path` file path — inlining the key into JSON is **forbidden**. Add `cert/` to `.gitignore`. On startup the service validates that the private key is readable and is valid RSA format, and refuses to start on failure.

### 2.2 Add `"alipay"` to the `chains` array

```json
"chains": ["base", "polygon", "alipay"]
```

As of 1.7.0, chain ids introduce `type: "fiat-rail"`, alongside the existing `type: "evm"` / `type: "svm"`. The `chains` array **does not break the full-set semantics** — any enabled rail is declared here.

### 2.3 `services[].alipay`

```json
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
```

| Field | Required | Description |
|---|---|---|
| `service_id` | Optional | Falls back to `provider.alipay.service_id_default` |
| `price_cny` | ✅ | CNY price, **string, unit yuan, ≤ 2 decimal places**. `"7.00"` = 7 yuan; `"100"` = **100 yuan** (not fen) |
| `goods_name` | ✅ | Product name the user sees in the Alipay app |

⚠️ **`price` (USDC) and `price_cny` (CNY) are two independent prices** — MoltsPay does no exchange-rate conversion. You decide yourself whether USDC `0.99` is equivalent to CNY `7.00`.

### 2.4 Startup validation

On `moltspay start` (when `provider.alipay` is detected), the server runs:

- ✅ `private_key_path` / `alipay_public_key_path` are readable
- ✅ Private key is valid RSA PEM format
- ✅ Every `services[].alipay.price_cny` matches the regex `/^\d+(\.\d{1,2})?$/`
- ✅ Every `services[].alipay.service_id` (or the fallback default) is non-empty

On any failure, the service refuses to start and prints the specific reason.

### 2.5 Server dual-header compatibility

In the 402 response the server sends both:
- `X-Payment-Required` (x402 standard; a `scheme: "alipay-aipay"` entry is added to the `accepts` array)
- `Payment-Needed` (Alipay standard; Base64URL-encoded nested JSON)

The two headers **mirror each other** and are generated uniformly by server middleware. This way:
- New `moltspay` clients use `X-Payment-Required` for the alipay path
- The legacy `alipay-bot` skill only recognizes `Payment-Needed` and works with 0 changes

On the request side, capabilities are declared via `Accept-Payment-Rail`; when absent, both headers are sent.

## 3. CLI client usage

> 🌐 **Node-only**: the CLI client wraps `alipay-bot@0.3.15` and is only available on Node ≥ 22. The browser build (`moltspay/web`) throws `UnsupportedChainError` directly.

### 3.1 Prerequisite: install `alipay-bot`

**`npm install moltspay` installs it automatically** (since commit `1e7c5ac`). The postinstall invokes `install-cli` from the declared dependency `@alipay/agent-payment`, which downloads `alipay-bot` to the machine from Alipay's official CDN. Failure does not block `npm install`; `MOLTSPAY_SKIP_CLI_INSTALL=1` skips it.

Manual install / repair (if you used `--ignore-scripts`, or were offline at install time):

```bash
npx -y @alipay/agent-payment install-cli
alipay-bot --version   # expect >= 0.3.15
```

When not installed, MoltsPay raises `ALIPAY_CLI_NOT_FOUND` and suggests the command above; at runtime `ensureCli` is the real version gate (`MIN_CLI_VERSION = 0.3.15`).

> **Dependencies and distribution (why alipay-bot is not in package.json)**
> - `alipay-bot` (= the `alipay-bot-cli` runtime, `0.3.x`, currently `0.3.15`) is **not on npm**, is `license: UNLICENSED`, and is distributed via Alipay's own CDN → it can neither be a package.json dependency nor be vendored into our distribution.
> - The only thing that goes into package.json is the npm installer **`@alipay/agent-payment` (`1.0.x`, currently `^1.0.14`)**, whose sole job is pulling the CLI from the CDN — the same model as Puppeteer downloading Chromium: **download at install time, never redistribute on Alipay's behalf**.
> - The two version lines are independent: `1.0.x` = installer, `0.3.x` = CLI; the CLI version is determined by Alipay's remote config, not statically pinned by the installer version.
> - License: the skills wrapper (`github.com/alipay/payment-skills`) = **Apache-2.0**; **the CLI itself has no public redistribution license whatsoever** (its release repo is private, runtime is `UNLICENSED`).
> - The old principle of "never silently modify the user's environment" has been **updated for "explicitly installed rail dependencies"**: by running `npm install moltspay` the user has already opted in.
> - For deployment/offline-machine details see server60 `docs/sdk-config-and-logging.md` §1a.

### 3.2 One-time: wallet activation

```bash
# Apply for activation (returns an authorization link; the user scans and authorizes in the Alipay app)
moltspay alipay apply

# Bind after authorization completes
moltspay alipay bind -c "<authorization code>"

# Check status
moltspay alipay check
```

The helper subcommands pass straight through to the same-named `alipay-bot` commands, mainly for first-time wallet activation.

### 3.3 Payment: the 402 protocol

```bash
moltspay pay --rail alipay https://www.sr007.com/api/v1/videos/v_001 \
  --intent "购买产品演示视频"
```

`--rail alipay` is the peer of `--chain base`. Once matched, the internal 8-step state machine runs:

```
1. payment-intent       initialize session
2. check-wallet         validate wallet status
3. save Payment-Needed  to ~/.moltspay/alipay/402_<reqId>.txt
4. 402-buyer-pay        initiate payment, output payment link + tradeNo
5. wait for user scan   surfaced via onPaymentPending callback
6. 402-query-payment-status  poll every 3s until success/timeout
7. pass resource body through to the caller   ⚠️ currently regex-scraped from the bot's stdout report and it ends up in logs; the bot deliberately never emits Payment-Proof so the SDK cannot fetch it itself — should switch to reading the structured resourceResponse field + stop forwarding into logs, see §9.3
8. 402-buyer-fulfillment-ack  fulfillment confirmation (async fire-and-forget)
```

The CLI output includes the payment link (with RSA2 signature), passed through **character-for-character** — any string manipulation is forbidden.

### 3.4 Programmatic SDK

```ts
import { MoltsPayClient } from "moltspay/client";

const client = new MoltsPayClient();

const out = await client.pay("https://www.sr007.com/api/v1/videos/v_001", {
  rail: "alipay",
  onPaymentPending: ({ paymentUrl, shortenUrl, tradeNo }) => {
    process.stdout.write(`请用支付宝扫码或访问：${shortenUrl}\n`);
  },
  timeoutMs: 30 * 60_000,   // default 30 minutes = pay_before
});

console.log(out.body);              // resource content
console.log(out.payment.tradeNo);   // 32-digit tradeNo
```

### 3.5 Multi-rail routing

When the server supports both USDC + Alipay, the client selects a rail in the following order:

```
1. Explicit { rail: "alipay" } / --rail alipay
2. First entry of the client.railPreference config (ordered list)
3. The client's actual capabilities:
   - Has an EVM wallet funded with USDC → use EVM
   - Otherwise alipay-bot online + wallet activated → use alipay
4. Server-side accepts[0] (fallback)
```

`railPreference` is client-level config, not a global env var — the same Agent can simultaneously serve two caller populations, "Chinese users prefer Alipay, overseas users prefer USDC".

## 4. Error code table

All alipay-related errors carry a stable `code` field for programmatic handling:

| Code | Meaning | Suggested handling |
|---|---|---|
| `ALIPAY_CLI_NOT_FOUND` | `alipay-bot` not installed | Guide to `npx -y @alipay/agent-payment install-cli` |
| `ALIPAY_CLI_VERSION` | `alipay-bot` version < 0.3.15 | Guide to `npx -y @alipay/agent-payment@latest update` |
| `ALIPAY_NEEDS_WALLET_SETUP` | Wallet not activated / applied but not authorized | Guide through `moltspay alipay apply` + `bind` |
| `ALIPAY_PAYMENT_REJECTED` | User canceled in the Alipay app | Ask the user to retry or switch rails |
| `ALIPAY_PAYMENT_TIMEOUT` | Not paid within `pay_before` (default 30 minutes) | Retry or switch rails |
| `ALIPAY_PROTOCOL` | Protocol-layer error (tradeNo format / signature / parse) | File an issue; usually an `alipay-bot` upgrade or inconsistent merchant config |
| `UNSUPPORTED_RAIL` | Server does not accept alipay | Switch rails or ask the service provider to enable it |

## 5. Common pitfalls

### 5.1 `amount` is in **yuan**, not fen

In the Alipay AI Pay 402 challenge, `amount` is a string denominated in **yuan**:

- `"1.00"` = 1 yuan ✅
- `"100"` = **100 yuan** (not 100 fen) ✅
- The "service unit price" in the merchant backoffice must match `services[].alipay.price_cny`, otherwise `SERVICE_PRICE_MISMATCH`

The MoltsPay server validates with the regex `/^\d+(\.\d{1,2})?$/` at startup and rejects ambiguous values.

### 5.2 `service_id` prefix

Two pages in the merchant backoffice show a service_id:
- The "审核通过" (Review Approved) page — the historical ID
- The "推进开发" (Promote Development) page — the **currently effective** ID (may look like `API_xxx`)

`services[].alipay.service_id` must be the ID from the **"推进开发" page**, otherwise you get `SERVICE_NOT_EXIST`.

### 5.3 Signature covers 8 fields, concatenated in dictionary order

The RSA2 signature covers only 8 fields, sorted by key in dictionary order:

```
amount / currency / goods_name / out_trade_no / pay_before / resource_id / seller_id / service_id
```

It does not include the `protocol` / `method` nested structures themselves, nor meta fields like `seller_signature` / `seller_sign_type`. `AlipayFacilitator.createPaymentRequirements()` already implements this; manual callers must sign exactly this set.

### 5.4 `Payment-Needed` is Base64URL (not standard Base64)

The `Payment-Needed` header uses **Base64URL** encoding (`-` for `+`, `_` for `/`, padding optional).

When forwarding the header with `curl -H`, beware of the shell interpreting `=`; extracting with Node.js is recommended (see `alipay-skill-integration-guide` Step 3). The MoltsPay client already encapsulates this.

### 5.5 `Payment-Proof` base64 padding is auto-completed

Some proxies strip trailing `=`. Server-side verify pads it back automatically:

```ts
const padded = proof + "=".repeat((4 - proof.length % 4) % 4);
```

### 5.6 Browsers do not support alipay

1.7.0 hard-codes `throw new UnsupportedChainError(...)` in `moltspay/web`. Reason: `alipay-bot` is a Node CLI.

The browser path goes through a "cashier URL" (user jumps to the Alipay app, frontend polls `tradeNo`) — that is 1.8.0 scope, not 1.7.0.

### 5.7 CLI output must not be modified

The payment link emitted by `moltspay pay --rail alipay` contains an RSA2 signature; any modification (including ANSI prettifying, line truncation, adding emoji, reordering) invalidates the link. Internally the MoltsPay SDK uses `spawn` + the stream API to forward lines verbatim; upstream callers **must not** do any string manipulation before printing.

### 5.8 `tradeNo` must be 32 pure digits

`alipay-bot 402-buyer-fulfillment-ack` rejects any `tradeNo` that is not 32 pure digits. At the SDK layer, `assertTradeNo` regex-validates `/^\d{32}$/` before the call; on failure it throws `ALIPAY_PROTOCOL` directly and never invokes alipay-bot.

## 6. End-to-end example

```bash
# 1. Merchant: start the server (with alipay config)
moltspay start ./my-skill --port 3000

# 2. Customer: first-time wallet activation
moltspay alipay apply
moltspay alipay bind -c "AUTH_xxxxx"
moltspay alipay check         # expect: code: 200, "已开启"

# 3. Customer: initiate payment
moltspay pay --rail alipay http://merchant.local:3000/services/text-to-video \
  --intent "购买产品演示视频" \
  --data '{"prompt":"demo"}'

# Internal CLI states (passed through to the user):
#   [1] payment-intent  initialized session
#   [2] check-wallet    code: 200
#   [3] saved Payment-Needed → ~/.moltspay/alipay/402_<uuid>.txt
#   [4] 402-buyer-pay  payment URL: https://qr.alipay.com/c1x...xyz
#                      tradeNo: 20240528xxxxxxxxxxxxxxxxxxxxxxxxxx
#   [5] waiting for user to scan & confirm in Alipay app...
#   [6] 402-query-payment-status  SUCCESS
#   [7] resource: {"video_url":"https://..."}
#   [8] 402-buyer-fulfillment-ack  confirmed (async)
```

## 7. Comparison with other rails

| Aspect | x402 (USDC) | Alipay AI Pay |
|---|---|---|
| 402 header | `X-Payment-Required` (JSON array) | `Payment-Needed` (Base64URL JSON) |
| Challenge structure | Flat `accepts[]` | Nested `{protocol, method}` |
| Currency | USDC (atomic units) | CNY (yuan, decimal string) |
| Signature | EIP-712 / EIP-3009 / Permit / SPL | RSA2 SHA256WithRSA |
| Client payment | Wallet signature → on-chain settle | User confirms in Alipay app → trade_no |
| Proof header | `X-Payment` | `Payment-Proof` |
| Verify | On-chain RPC | HTTP `alipay.aipay.agent.payment.verify` |
| Browser | ✅ Supported since 1.6.0 | ❌ (CLI-only; cashier URL from 1.8.0) |
| Compliance | Global | China-mainland merchants only |

## 8. References

- [`./ALIPAY-INTEGRATION-DESIGN.md`](./ALIPAY-INTEGRATION-DESIGN.md) — full architecture design + decision record
- [`./ALIPAY-INTEGRATION-PLAN.md`](./ALIPAY-INTEGRATION-PLAN.md) — implementation checklist + milestones
- Official Alipay docs: https://ideservice.alipay.com/cms/site/0j7svz.md
- `@alipay/agent-payment` npm package: https://www.npmjs.com/package/@alipay/agent-payment

---

## 9. Known bugs

### 9.1 Settlement polling fetches the resource with GET, inconsistent with the payment step (POST) → after a successful payment `pay()` never resolves

**Status:** ✅ Fixed in source (2026-06-05, moltspay@1.7.0 / alipay-bot 0.3.15).
**Fix:** `src/client/alipay/poll.ts` — `PollOptions` gains `method`/`data`, and `pollUntil` appends `-m/-d` to `402-query-payment-status`; `src/client/alipay/index.ts` — `pay402` passes `opts.method`/`opts.data` through when calling `pollUntil`. This makes the settlement resource fetch consistent with `402-buyer-pay` (POST `/execute`).
Also: `parseStatus` in `src/client/alipay/poll.ts` gains the anchor marker `"status":"fulfilled"` — because alipay-bot 0.3.15 actually outputs a **human-readable markdown report** (not the pure JSON envelope the comments claimed), the original `parseStatus` judged `unknown` even when the resource fetch succeeded; the new marker is taken from the server-side post-settlement resource body and only appears once settled, so it is safe. The original record follows:

**Symptom:**
The buyer pays via `MoltsPayClient.pay(serverUrl, service, params, { rail:'alipay' })`. The Alipay side **has debited successfully** (alipay-bot outputs `✓ 查询支付状态成功`), but `pay()` **never resolves**; nothing progresses after `onPaymentPending`, and the caller (e.g. a Discord bot) is stuck on the QR screen and never triggers downstream fulfillment.

**Root cause (inconsistent methods between the client's two internal steps):**
`AlipayClient.pay402` (`dist/client/index.js`) uses different HTTP methods for the two steps:

- **402-buyer-pay** (create/pay) carries `-m POST -d <body>`:
  ```js
  const payArgs = ["402-buyer-pay", "-f", challengeFile, "-r", resourceUrl, ...];
  if (opts.method) payArgs.push("-m", opts.method);   // POST
  if (opts.data)   payArgs.push("-d", opts.data);
  ```
- **402-query-payment-status** (settlement polling) goes through `pollUntil`, which **does not pass method/data through**:
  ```js
  // pay402: method/data not passed when calling pollUntil
  const poll = await pollUntil(tradeNo, resourceUrl, { deadline, signal, onLine, runner, now });
  // pollUntil: query-payment-status has no -m → alipay-bot defaults to GET
  await runner(["402-query-payment-status", "-t", tradeNo, "-r", resourceUrl], {...});
  ```

Meanwhile, `MoltsPayServer`'s resource endpoint `/execute` **only accepts POST** (`server/index.ts`: `url.pathname === '/execute' && req.method === 'POST'`; GET is only supported on the `/<serviceId>` MPP path). So the settlement poll does **GET `/execute` → 404 `Not found`**, alipay-bot enters its error branch and outputs Chinese prose, and the client's `parseStatus` only recognizes `TRADE_SUCCESS`/`{success:true}`/`{code:200}` → judges `unknown` → loops forever until the `pay_before` timeout.

**Verdict:** the client itself is inconsistent ("POST for pay, GET for the status/resource fetch"); the GET is in turn inconsistent with the server's POST-only `/execute`. It is an **SDK client bug** (`pollUntil` fails to pass through the method/data used by buyer-pay).

**Blast radius:** all self-hosted/cashier-style deployments where "resourceUrl points at the POST-only `/execute`" (worst when the service declares no GET-reachable `endpoint`). Typical scenario: a bot using Alipay as a pure cashier (fulfillment happens on the bot side).

**Suggested fix (client):** `pay402` passes `opts.method`/`opts.data` through into `pollUntil`, and `pollUntil` appends `-m <method> -d <data>` to `402-query-payment-status`, making the resource fetch consistent with buyer-pay (POST `/execute`), so alipay-bot takes the success branch and `parseStatus` judges correctly.

**Workaround (no SDK change):** configure a GET-reachable resource path for `services[].endpoint` (e.g. `/<serviceId>`) so the client's resourceUrl does not land on the POST-only `/execute` (needs live testing to confirm `parseStatus` can judge paid on that path's output).

### 9.2 `parsePaymentUrl` swallows the trailing markdown `)` → cashier link/QR code 404s

**Status:** ✅ Fixed in source (2026-06-05). `parsePaymentUrl` in `src/client/alipay/index.ts` strips trailing markdown characters after extraction with `.replace(/[)\]`>]+$/, '')`.

alipay-bot prints the link as markdown `[点击此处](https://u.alipay.cn/xxx)`. The greedy regex `https?:\/\/\S+` in `parsePaymentUrl` swallows the trailing `)` too → the returned `paymentUrl` becomes `https://u.alipay.cn/xxx)` (with a trailing parenthesis) → opening/scanning it 404s.

**Fix (client):** strip trailing markdown characters after extraction with `.replace(/[)\]`>]+$/, '')`. **Workaround (caller):** sanitize trailing `)]`> etc. from the `paymentUrl`/`shortenUrl` returned by `onPaymentPending` before using them.

### 9.3 The alipay path skips the x402 retry and scrapes the bot's stdout report instead → deliverables (e.g. video base64) end up in logs

**Status:** 🟡 Characterized + verified against the bot (2026-06-13); fix not yet landed. Originally triggered by an issue proposing `--output-dir`, which has been **rejected**. **Key conclusion**: the ideal x402 shape (SDK retries the HTTP request itself carrying the proof to get the response body) is **empirically infeasible** — alipay-bot deliberately never outputs `Payment-Proof`; with the CLI unmodifiable, what can be done is "read the bot's structured `resourceResponse` field + stop forwarding into logs", see below.

**Requirements (confirmed by the user 2026-06-13):**
1. Deliverables **must not** appear in stdout / logs;
2. Deliverables should be obtained **via the HTTP response body of the resource URL** — i.e. the standard x402 "retry the original request with the proof header → 200 + body", not scraped from CLI stdout text;
3. `--output-dir` (having the bot write deliverables to disk) is **not** the solution and is not adopted as a fix direction.

> These two halves were originally assumed to be one requirement (a proper x402 SDK self-fetch would satisfy both). Corrected after testing: the bot never emits the proof, so the SDK cannot self-fetch; they can only be satisfied separately — "keep out of logs" is achievable (do not forward bot output), "SDK fetches via HTTP itself" is not (requires bot-side changes).

**The server side was already x402 (design is correct):**
After the buyer pays, **re-request `/execute` with the `Payment-Proof` header** → server verifies via the facilitator → runs the skill → returns **200 + resource in the HTTP response body**. Evidence:
- `src/server/index.ts:688-700`: `handleExecute` routes to `handleAlipayExecute` on receiving a `Payment-Proof` header → verify + execute + 200.
- `test/server/alipay-payment-proof.test.ts:1-12`: explicitly "after paying, the re-request carries the `Payment-Proof` header and the server must return 200, not another 402".
- The EVM path does exactly this (`src/client/node/index.ts:447-462`): construct the proof locally → retry the original request with the `X-Payment` header → body comes straight from the HTTP response (`paidRes`), **never touching stdout at any point**.

**Bug: the alipay client path skips the "SDK retries with the proof itself" step.**
Current (incorrect) pipeline:
1. After settlement, `pollUntil` calls `402-query-payment-status -t <tradeNo> -r <resourceUrl> -m -d`, letting **the bot internally** re-request the resource (the bot holds the proof itself, see `server/index.ts:60-62`), then **render the HTTP response into a human-readable markdown report**, with the resource body embedded after the `资源响应体：` label — `src/client/alipay/poll.ts:233-235`.
2. This whole report streams through `onLine` into the **logs**, and is also returned as `poll.lines`.
3. At Step 7 the SDK does `const body = extractBody(poll.lines)` — `src/client/alipay/index.ts:466-467` — internally `extractResourceFromReport` (`index.ts:177`) does brace-matching over the report and digs out the embedded JSON's `.result`.

For large payloads like video, the entire base64 blob gets stuffed into the report → into stdout/logs → then string-scanned. The resource **was already the body of some HTTP 200 response** (the bot's re-request response); it just got relayed by the bot and leaked into the report/logs.

**Verdict:** an **SDK client architecture bug** — the alipay path does not let the SDK issue the x402 retry itself like the EVM path does; it degenerated into "let the bot fetch on our behalf + scrape the report". `extractResourceFromReport` / the whole report-scraping chain are artifacts of this incorrect implementation.

**The ideal x402 shape (aligned with the EVM path) — but blocked by testing, see below:**
In theory the alipay path should be symmetric with the EVM path: alipay-bot only produces the `Payment-Proof`, and the **SDK itself** does `fetch(executeUrl, { method, headers:{ 'Payment-Proof': <proof> }, body })` → 200 + resource taken from the HTTP response body (mirroring `node/index.ts:455-462`). Proof structure in `src/facilitators/alipay.ts:469-493`: base64url `{protocol:{payment_proof,trade_no}, method:{client_session}}`.

**Empirical conclusion (2026-06-13, verified against the real bot CLI): alipay-bot deliberately never outputs `Payment-Proof`, so a pure SDK retry is infeasible.**
Audited all 8 occurrences of `paymentProof`/`Payment-Proof` in `~/.local/share/alipay-bot-cli/runtime/dist/cli.js` (v1.0.14, obfuscated); they fall into two categories, **none of which reach stdout**:
1. **Used for the internal re-request**: `{resourceUrl, paymentProof, tradeNo, token, …}` → builds the `{'Payment-Proof': base64url({protocol:{payment_proof,trade_no},method:{client_session}})}` header → `fetch(resourceUrl,{headers})`. That is, **the bot itself is the x402 client** and already makes the authenticated re-request with the proof (exactly what `server/index.ts:60-62` describes).
2. **The output rendering layer deliberately strips the proof**: `const { paymentProof:_, ...rest } = result; return { content: JSON.stringify(rest), … }`. The internal result object is `{success, tradeNo, paymentProof, paymentType, payScheme, shortenUrl, needPolling, goodsInfo, resourceResponse, …}` — at render time **`paymentProof` is deleted, `resourceResponse` (the resource body) is kept**.

This explains the status quo: the SDK can scrape the resource from stdout but can never get the proof — the bot does this on purpose (the proof is a replayable bearer credential and is not leaked to callers). **Therefore "SDK retries with the proof itself" is unreachable while the CLI cannot be modified.**

**SDK changes that can land with the CLI unmodifiable (satisfy "keep out of logs", improve the fetch):**
- Change the deliverable's source from "regex-scraping the `资源响应体：` text report" to "reading the **structured `resourceResponse` field** in the bot's output" — more robust, no brittle text matching (replaces `extractResourceFromReport`, `index.ts:177`);
- This portion of the bot's output is **no longer forwarded to `onLine`/logger**; the deliverable leaves only via the typed return value `{body}` (`index.ts:466-467`) — **guaranteeing it never enters our logs**.
- Limitation: the deliverable still transits the bot's own stdout pipe (a black-box CLI decision); a true "SDK issues the HTTP request and takes the response body" needs the bot to expose the proof, or the bot itself to stop stuffing the resource into log-capturable output — **goes back to the bot team** (see §5.7).

> Note: the bot **already** makes one authenticated HTTP re-request with the proof and puts the response into `resourceResponse`, so the deliverable does in essence already come from an HTTP response body — it is merely relayed through the bot's stdout.

**Relationship to §9.1:** §9.1 adds `-m/-d` to `402-query-payment-status` so the bot's internal re-fetch works — a symptomatic fix but on the correct path (the bot was always supposed to make this authenticated re-request). This item changes **how the SDK consumes the bot's result** (read the structured field, keep it out of logs), instead of continuing to rely on text-report scraping.

---

*Document version: v1 (rc.1 in progress) | Created: 2026-05-29 | Target version: `moltspay@1.7.0`*
