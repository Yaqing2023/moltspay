# Changelog

## [2.4.0] - 2026-07-14

**The balance rail grows a user.** 2.2/2.3 made payments password-free but left the buyer as a bare string: anyone who knew a `buyer_id` could spend that balance (bearer semantics), and the same person writing it two ways (`real01` / `test-buyer-001`) split into two accounts. This release gives the balance rail a real identity — anchored to the WeChat payer's `openid` at top-up, and authorized by a per-request signature at spend — closing both holes. It also fixes the server's self-description (a discovering agent was being sent to the wrong URL and told the wrong price), and ships `moltspay send`.

**No breaking changes**, but the balance rail's new authentication is **staged, not on by default**: `provider.balance.auth_mode` defaults to `off`, and existing unsigned clients keep working until an operator moves to `shadow` → `enforce`.

### Added
- **Balance identity — WeChat `openid` as the anchor.** On a WeChat-funded top-up, the server extracts `payer.openid` from the (signature-verified) order query and records it on the account (`buyers.wechat_openid`). Accounts are anchored to the person who actually paid, not to whatever string the caller self-reported, which removes the account-splitting class of bug at the source. Binding is observational and never overwrites: a conflicting openid is reported, not silently rebound. Exposed via `GET /balance`.
- **Balance authentication — per-request signatures.** Each deduction now carries an EIP-191 signature over a canonical message (`buildDeductMessage`: domain `moltspay-balance-auth:v1` / `balance-deduct` / `buyer_id` / `request_id` / `service` / `timestamp`). The server (`verifyDeductAuth`) recovers the signer address, TOFU-binds it to the account on first use (`buyers.signer_address`), and verifies it thereafter. Amount is deliberately *not* signed — the service id determines the price server-side, while `request_id` + a ±5-minute `timestamp` window bound replay.
  - **`provider.balance.auth_mode`: `off` | `shadow` | `enforce`** — `off` skips the check (default, backward-compatible); `shadow` verifies and logs what it *would* deny without blocking (use this to confirm every real client is signing before you tighten); `enforce` rejects unsigned/invalid requests with 401. Rollback is a config flip + restart.
  - **Signing key** — the client signs with its EVM wallet, or, for balance-only clients with no crypto wallet, a per-configDir identity key auto-created at `<configDir>/balance-identity.key` (0600). `MoltsPayClient.getBalanceSignerAddress()` exposes the address.
- **`moltspay balance whoami [server]` / `moltspay balance bind <server>`** — show the local signer address (and, against a server, the account's bound signer/openid), and bind the signer to an account explicitly. Top-up also carries the signer address through the WeChat `attach` passthrough, so identity is established at funding time rather than only on first spend.
- **Recoverable top-up for chat agents** — `moltspay balance topup-order` creates a WeChat pack order, emits the QR, and **exits immediately** instead of blocking on the scan; `balance topup-confirm <out_trade_no>` confirms and credits it later, `topup-status` / `topup-list` inspect pending orders. The blocking `topup-pack` assumes a terminal that can wait; a turn-based agent (Discord/飞书) cannot, and used to strand or re-issue orders. The order persists across turns, and confirming is idempotent on `out_trade_no` — the agent must reconfirm the *same* order rather than minting a new one.
- **`moltspay send <to> <amount>`** — send USDC/USDT to any address, so CLI/skill users can move funds out (e.g. to an exchange deposit address) without exporting the private key into a third-party wallet. Options: `--token USDC|USDT` (default USDC), `--chain base|polygon|bnb|base_sepolia|bnb_testnet|tempo_moderato` (default base), `--yes` (skip the confirmation prompt for scripts/agents), `--json`. A thin wrapper over `Wallet.transfer()`; see `docs/SEND-COMMAND-DESIGN.md`.
  - **EVM only** — Solana is a separate keypair/transfer path and is rejected with a clear message.
  - **Not gasless** — unlike x402 `pay`, a plain transfer needs native gas (ETH/BNB/POL); the command preflights the token balance and native gas and fails early if short.
  - **Safety** — checksum-validates the destination, previews From/To/Network before sending (interactive unless `--yes`/`--json`), never prints the private key, and reminds the caller that the send network must match the receiver's deposit network.

### Fixed
- **Service discovery sent agents to the wrong URL.** The discovery payload advertised its own `endpoints` as root-relative paths (`/services`, `/execute`), which resolve against the *domain* root and drop any deployment path prefix — an agent following `moltspay.com/t/moltspay-server`'s own discovery ended up at `moltspay.com/services` (a different backend) instead of `moltspay.com/t/moltspay-server/services`. The server is now prefix-aware: set `PUBLIC_BASE_URL` and `endpoints`, 404 hints, and the 402 `resource.url` are emitted as absolute URLs. Unset, it falls back to relative paths, so local/no-prefix deployments are unchanged.
- **Base URL returned a bare 404.** `GET /` was not routed and fell through to `{"error":"Not found"}`, so the most natural first request an agent makes told it nothing. The root path now serves the discovery payload, and the 404 body carries a `discovery` pointer.
- **Discovery under-reported payment options and hid CNY pricing.** Each service advertised only `price: 0.01 / currency: USDC`, so an agent reading discovery concluded the service took USDC only — even though the 402 challenge correctly offered Alipay, WeChat, and balance in CNY. Services now carry a structured `pricing` array covering every enabled rail (e.g. `[{rail: crypto, USDC, 0.01}, {rail: alipay, CNY, 1.00}, {rail: wechat, CNY, 0.07}, {rail: balance, CNY, 0.07}]`) and `acceptedCurrencies` is the union across rails. The top-level `price`/`currency` are unchanged for backward compatibility.
- **Balance identity key could fail to persist** when `configDir` did not exist yet — the directory is now created before the key is written.

### Security
- **Closes the bearer-`buyer_id` hole flagged in 2.2/2.3.** With `auth_mode: enforce`, knowing a `buyer_id` is no longer sufficient to spend that balance; the caller must hold the bound signing key. This brings the balance rail to parity with the Alipay rail's per-request `payment_proof`.
- **Trust model — one agent key spends for all its users.** The shipped model is *agent-custodial*: a single agent key is bound to every account it tops up (`signer_address` is one-to-many). Accounts stay separated by openid, but **whoever holds the agent's key can spend every bound user's balance** — protect `<configDir>/balance-identity.key` accordingly. Per-user key isolation is a future upgrade, not what this release does.
- **WeChat response verification is the foundation of the openid anchor.** `openid` is only trustworthy if the order-query response is verified against the WeChat platform certificate — configure `provider.wechat.platform_public_key_path` (present ⇒ every response is verified, and a verification failure throws). Without it, responses are unverified and the identity anchor is not trustworthy.

### Changed
- The CLI's 2682-line `index.ts` was split into per-group modules (`cli/commands/*` + `shared.ts`). No command surface changed.

### Migration from 2.1.0
This release ships everything accumulated in the unreleased 2.2.0/2.3.0 sections below (custodial balance rail, WeChat-funded password-free payments) plus the above. No code changes are required to upgrade; the balance rail and its authentication are both opt-in via configuration.

To adopt balance authentication on an existing deployment, stage it: set `auth_mode: "shadow"`, upgrade clients, watch the logs until nothing is reported as would-deny, then set `auth_mode: "enforce"`. Legacy accounts with no openid (created before this release) TOFU-bind their signer on the first signed request.

## [2.3.0] - Unreleased

**Scan once, then password-free.** Fuses the WeChat Native rail (2.1.0) and the custodial balance rail (2.2.0) into one flow: WeChat becomes a **balance funding source** (the buyer scans once to load a top-up pack) and the balance rail does the spending (subsequent purchases deduct server-side, no scan, no password). WeChat has no autonomous payer product, so "password-free" lives entirely on the balance-deduction side; the first purchase against an empty balance still requires one scan, but it buys a pack, not a single item.

**No breaking changes.** The per-transaction WeChat rail and the manual balance top-up endpoint keep working; the fused flow is opt-in via config + client behavior. Design: [`docs/WECHAT-BALANCE-PASSWORDLESS-DESIGN.md`](docs/WECHAT-BALANCE-PASSWORDLESS-DESIGN.md) (supersedes the now-deprecated `WECHAT-RAIL-DESIGN.md` / `BALANCE-RAIL-DESIGN.md`).

### Added
- **WeChat-funded balance top-up** — `POST /balance/topup/order` mints a buyer-bound WeChat Native order for a configured top-up pack and returns `{ code_url, out_trade_no, pack, expires_at }`. Buyer binding rides in the WeChat `attach` passthrough (`{ buyer_id, nonce }`), so an anonymous Native order credits the correct balance.
- **Automatic crediting** — the server confirms a top-up by **polling the WeChat order query** (`trade_state === SUCCESS`), credits the gateway-verified `payer_total`, and is idempotent on `wechat:<out_trade_no>`. Replaces the manual `balance topup --out-trade-no --amount` step. (The async `POST /wechat/notify` webhook — apiv3 AES-256-GCM decrypt + platform-cert verify — is **not implemented**; polling is the only confirmation path today. Callback-primary crediting remains planned.)
- **Fixed top-up packs** — `provider.balance.topup_packs` / `default_pack` / `auto_topup_max`. The client auto-tops-up with `default_pack` (bounded by `auto_topup_max`) when a 402 finds an insufficient balance, then auto-retries the original request.
- **CNY ledger** — `provider.balance.currency: "CNY"`. The ledger minor unit (`*_sat`) is fen for CNY, so WeChat `payer_total` credits 1:1 with no FX. A new `ledger_meta` row records the ledger currency and the rail refuses to start on a currency mismatch (guards against re-interpreting a USD ledger as CNY).
- **Client password-free orchestration** — `pay()` goes balance-first, surfaces a pack QR only when funds are short, and auto-retries after crediting; new `onTopupRequired` / `onTopupCredited` hooks. CLI: `moltspay balance topup --pack <amt>`; `moltspay pay` completes password-free when funded.

### Security
- **Structural amount integrity** — top-ups credit only the gateway-verified `payer_total` (callback decrypt+verify, or order-query `SUCCESS`); a client-declared amount never reaches the ledger. This makes the amount-spoofing class impossible by construction, generalizing the earlier `handleBalanceTopup` fix.
- **Bearer `buyer_id` caveat** — password-free means a pre-funded balance sits behind a bearer identifier; signed buyer tokens (Phase 3) are recommended before wide rollout, and `auto_topup_max` bounds how much a compromised client can pull from the user's WeChat.

## [2.2.0] - Unreleased

Third payment mode: a **custodial balance rail (password-free payments / 免密支付)**, alongside per-transaction crypto signing and the Alipay/WeChat scan-to-pay fiat rails. A buyer tops up once and subsequent purchases are deducted server-side — no signature, no QR, no password per transaction.

**No breaking changes.** Every existing rail behaves identically; the balance rail is strictly opt-in via configuration. Enabling it requires **Node.js >= 22.5** (the ledger uses the built-in `node:sqlite` — zero new dependencies); servers that don't enable it keep the package's `node >= 18` floor.

### Added
- **Custodial balance rail** — a new `BalanceFacilitator` (scheme/network `balance`) backed by a SQLite ledger (`src/facilitators/balance/ledger.ts`).
  - Amounts are integer cents; check-and-deduct runs in a single `BEGIN IMMEDIATE` transaction, so a balance can never go negative under concurrency.
  - Triple idempotency, each enforced by a unique index: deducts replay on the client's `request_id`, top-ups replay on the external settlement reference (`tx_hash` / trade number), refunds replay per deduct. No retry path can double-charge, double-credit, or double-refund.
  - Server-side hard limits per buyer: per-transaction (default `5.00`) and daily (default `10.00`), configurable.
  - `createPaymentRequirements` is **pure** — a 402 challenge mints nothing, so the order-per-challenge class of bug is structurally impossible on this rail.
- **HTTP server integration** — opt-in via `provider.balance` (`db_path`, optional `currency` / `single_limit` / `daily_limit`) and per-service `services[].balance` (`price`, defaults to the service's USD price). 402 responses append a `balance` `accepts[]` entry.
  - `/execute` dispatch order is **inverted** relative to the QR rails: atomic deduct **before** the skill runs, automatic refund if the skill fails. (QR rails: verify paid → run → confirm.)
  - Balance management endpoints: `GET /balance`, `POST /balance/topup`, `POST /balance/refund`, `GET /balance/transactions`.
- **Top-ups reuse the existing rails** — `POST /balance/topup` verifies the reported settlement per rail and credits the ledger: `crypto` verifies the `tx_hash` on-chain (receipt + USDC/USDT transfer to the provider wallet + amount); `wechat` queries the order by `out_trade_no` (must be `SUCCESS`); `alipay` is operator-trusted in this MVP (AI-Pay verification requires the buyer-side `payment_proof`) — protect the endpoint accordingly. All rails are idempotent on the external reference.
- **Buyer identity** — an opaque `buyer_id` with bearer semantics, carried in the X-Payment payload together with a client-generated `request_id` UUID. Channel runtimes map their own session ids to `buyer_id` at the application layer.
- **SDK client APIs** — `pay(..., { rail: 'balance', buyerId })`, `getBuyerBalance()`, `topupBalance()`, `listBalanceTransactions()`, `setBuyerId()` (persisted in `config.json`). No EVM wallet required.
- **CLI** — `moltspay balance query|topup|transactions|set-buyer` and `moltspay pay --rail balance`.
- **Docs** — `docs/BALANCE-RAIL-DESIGN.md` (design + SDK integration).

### Fixed
- **WeChat 402 double-charge** — every 402 emit used to place a fresh Native order, so a client that received two challenges could surface two live QRs and a buyer could pay both (confirmed ¥0.07×2 real double charge, 2026-07-02). The server now caches the unpaid order per service id and reuses it for every 402 within the order's `time_expire` window (refreshing 30s before expiry so served QRs always have usable life); the entry is dropped the moment the order verifies as paid (Native is one-code-one-payment), concurrent 402 builds share one in-flight order create, and build failures are never cached. In-memory by design: a server restart at worst leaves one extra *unpaid* order to expire server-side — never a double charge.

### Migration from 2.1.0
1. No code changes required — fully backward compatible.
2. Optional: add `provider.balance` + `services[].balance` to your services JSON to enable password-free payments (requires Node >= 22.5 on the server).
3. Buyers top up once (`moltspay balance topup`), then pay with `moltspay pay --rail balance` — no per-transaction signing or scanning.

## [2.1.0] - 2026-06-27

Second **fiat rail: WeChat Pay v3 Native (微信支付 / 扫码付)**, settling in CNY alongside USDC and Alipay.

**No breaking changes.** Every existing rail (crypto + Alipay) behaves identically; WeChat is strictly opt-in via configuration. Upgrading from 2.0.x requires no code changes.

Unlike Alipay AI Pay, WeChat has no autonomous payer product, so this rail is **SDK-managed scan-to-pay with server-side verify/settle**: the server issues a payer-agnostic Native `code_url` (no `openid`), the SDK client persists the payment session and polls, anyone scans to pay, and the server confirms by polling the order. One code, one payment.

### Added
- **WeChat Pay fiat rail** — a new `WechatFacilitator` settling CNY over the x402 protocol.
  - New `wechat` chain / `wechatpay-native` scheme; **SHA256-RSA** request signing (`WECHATPAY2-SHA256-RSA2048`), optional response-signature verification against the WeChat platform certificate.
  - `createPaymentRequirements` places a Native order (`POST /v3/pay/transactions/native`) and returns a `code_url`; `verify` queries the order (`trade_state === SUCCESS`); `settle` is an idempotent confirm; `healthCheck` validates keys + gateway reachability.
  - Amount is converted yuan → fen (`cnyToFen`) for the WeChat API; the manifest uses yuan decimal strings.
- **WeChat crypto helpers** — `wechatV3Sign` / `buildAuthorizationToken` / `wechatV3VerifyResponse` (`src/facilitators/wechat/sign.ts`) and the `wechatV3Call` v3 JSON gateway client (`src/facilitators/wechat/api.ts`).
- **HTTP server integration** — opt-in via `provider.wechat` (`mchid`, `appid`, `serial_no`, `private_key_path`, `notify_url`, optional `platform_public_key_path` / `apiv3_key`) and per-service `services[].wechat` (`price_cny`, `description`). 402 responses append a `wechatpay-native` `accepts[]` entry carrying `code_url` + `out_trade_no`; `/execute` dispatches the rail to verify → run skill → fire-and-forget settle.
- **Recoverable WeChat buyer sessions** — `WechatClient` persists `payment_session_id`, `out_trade_no`, QR payload, original request body, service context, status, and result under `<configDir>/wechat-sessions`. Sessions can be recovered by session id or `out_trade_no`, polled, fulfilled idempotently, cancelled, and listed.
- **WeChat SDK orchestration APIs** — `MoltsPayClient.startWechatPayment()`, `getWechatPaymentStatus()`, `fulfillWechatPayment()`, `cancelWechatPayment()`, and `listWechatPaymentSessions()`. `startWechatPayment()` supports `autoPoll`, `onWechatPaymentCompleted`, and `onWechatPaymentFailed` so channel runtimes can let the SDK client own payment polling and asynchronous fulfillment.
- **WeChat CLI session commands** — `moltspay wechat start/status/fulfill/cancel/list` for non-blocking QR issuance and operational recovery. `moltspay pay --rail wechat` remains the blocking terminal wrapper, now built on the same persisted session flow.
- **Scenario-A demo** — `examples/wechat-native-pay.ts` (issue code → `qrcode-terminal` → poll → settle); mock by default, `WECHAT_REAL=1` hits the live gateway.
- **Docs** — `docs/WECHAT-RAIL-DESIGN.md` (design + scenario A) and `docs/WECHAT-RAIL-PLAN.md` (dev plan).

### Fixed
- **Fiat rails no longer produce a spurious crypto `accepts[]` entry** — `getProviderChains` now excludes `alipay`/`wechat` from EVM chain iteration (they were defaulting to a base/USDC entry when listed in `provider.chains`). Affects Alipay too.

### Migration from 2.0.x
1. No code changes required — fully backward compatible.
2. Optional: add `provider.wechat` + `services[].wechat` to your services JSON to enable WeChat payments.
3. For terminal use, `moltspay pay --rail wechat` still blocks until paid/timeout.
4. For chat/channel integrations, use `startWechatPayment()` or `moltspay wechat start` so the SDK client persists the session before the QR is shown, then recover with `status` / `fulfill` by `payment_session_id` or `out_trade_no`.

## [2.0.0] - 2026-06-20

First-class **fiat payments via Alipay (支付宝 AI 收)**. This is the milestone release that takes MoltsPay beyond crypto-only settlement.

**No breaking changes to the existing crypto rails.** The Node CLI, the x402 wire protocol, and every chain that worked in 1.6.0 behave identically. The major version bump marks the fiat milestone, not an incompatible API. Upgrading from 1.6.0 requires no code changes; Alipay is strictly opt-in via configuration. (npm 1.7.0 was never published — 2.0.0 supersedes it.)

### Added
- **Alipay fiat payment rail** — a new `AlipayFacilitator` settling Chinese Yuan (CNY) over the x402 protocol.
  - New `alipay` chain / `alipay-aipay` scheme, RSA2 signature verification, health-check + settlement APIs.
  - Opt-in via `provider.alipay` and per-service `services[].alipay` in your services JSON (`seller_id`, `app_id`, key paths, `service_id`, `price_cny`, `goods_name`, …). See `docs/ALIPAY-RAIL.md`.
  - Equivalent env vars: `ALIPAY_SELLER_ID`, `ALIPAY_APP_ID`, `ALIPAY_SELLER_NAME`, `ALIPAY_PRIVATE_KEY_PATH`, `ALIPAY_PUBLIC_KEY_PATH`, `ALIPAY_GATEWAY_URL`.
- **Dual-emit HTTP 402 middleware** — services advertise both the x402 `X-Payment-Required` challenge and the legacy alipay-bot `Payment-Needed` header in one response, so existing clients keep working.
- **Client-side Alipay pay flow** — CLI wrapper around `alipay-bot` with an 8-step `pay402` state machine; consumes `Payment-Proof` on `/execute`.
- **Key-encoding utilities** — `toPem()` (bare Base64 → PEM), `decodeBase64UrlWithPadFix()` (Base64URL with padding repair), `rsa2Sign()` / `rsa2Verify()`.
- **Auto-provision of the `alipay-bot` CLI on install** — `postinstall` downloads it from Alipay's official CDN (it is not on npm and is UNLICENSED, so it is never redistributed by us). Best-effort: a provisioning failure prints an actionable notice but never fails `npm install`. Opt out with `MOLTSPAY_SKIP_CLI_INSTALL=1`; provision manually with `npx -y @alipay/agent-payment install-cli`.
- **Alipay verification scripts** — `verify:alipay:offline` (offline E2E) and `verify:alipay:http` (402 dual-emit).

### Fixed
- **Paid resource never leaks into the log stream**, and the 402 challenge headers are hardened. The deliverable is returned via the resource-URL HTTP body only — never stdout/logs.
- **`Payment-Proof` header now consumed and validated** on `/execute`; corrected `UNPAID` status parsing for Alipay transactions.
- **Settled-trade report recognition** for `alipay-bot` 0.3.15 (Shape C).
- **`scripts/postinstall.js` is now shipped in the published tarball** (was missing from the `files` whitelist, so auto-provision never ran on a clean install).

### Performance
- **Cross-flow `check-wallet` cache** — wallet authorization status is cached across payments (it doesn't change once authorized), removing a ~23s spawn from the pre-QR window of every payment after the first.
- **Overlapping status polls** — `pollUntil` launches overlapping `402-query-payment-status` spawns on a fixed cadence instead of serially; first to observe `paid` wins and aborts the rest. Cuts post-payment detection lag from ~50–60s to ~(cadence + 1 spawn). Tunables: `maxInflight` / `launchIntervalMs` (or `MOLTSPAY_ALIPAY_POLL_MAX_INFLIGHT` / `MOLTSPAY_ALIPAY_POLL_LAUNCH_MS`); set `maxInflight=1` for strict sequential polling. Concurrent polls are read-only verifies — no double-charge or double-delivery.
- **Skip-cache the payment-intent handshake** and the vendor perf request to shave fixed latency off the buyer-pay path.

### Migration from 1.6.0
1. No code changes required — fully backward compatible.
2. Optional: add `provider.alipay` + `services[].alipay` to your services JSON to enable fiat payments.
3. Optional: update clients to handle the `alipay-aipay` scheme.

## [1.6.0] - 2026-04-24

First-class browser support. Node CLI behavior and the x402 wire protocol are unchanged; everything here is additive.

### Added
- **Web Client (`moltspay/web`)** — `MoltsPayWebClient` + signer adapters for browser use. No private key ever in browser memory; signing is delegated to an injected wallet.
  - `eip1193Signer(window.ethereum)` for MetaMask / Rainbow / Frame / any EIP-1193 provider.
  - `solanaSigner(walletAdapter)` for Phantom / Solflare / Backpack / any `@solana/wallet-adapter` wallet.
  - `composeSigners(evm, svm)` to route by chain from a single client instance.
  - `SpendingLedger` — opt-in `localStorage`-backed per-browser spend limits.
  - `new ./web` subpath export, browser-only bundle (40 KB gzipped, no Node-only APIs).
  - Error classes `NeedsApprovalError` / `UnsupportedChainError` / `PaymentRejectedError` / `InsufficientBalanceError` / `SpendingLimitExceededError` / `ServerError` / `MoltsPayError` each with a stable `code` field.
- **`solanaRpc` option on `MoltsPayWebClient`** — per-chain RPC URL override so customers can point Solana traffic at Helius / QuickNode / Alchemy etc. The public `api.mainnet-beta.solana.com` endpoint returns 403 to browser requests, so this is required in practice for Solana mainnet.
- **Tempo permit settlement path** — server's `TempoFacilitator` now advertises `scheme: "permit"` in the 402 response and accepts EIP-2612 permit payloads, enabling browser payment on Tempo Moderato without a chain switch. Node CLI callers still default to MPP on Tempo; no CLI opt-in changes.
- **`MoltsPayServer` `cors` option** — CORS is required for browser clients. Default (`*`) preserves 1.5.x behavior; set to a string, string-array, or `false` to tighten. Default response already advertises `Access-Control-Expose-Headers: X-Payment-Required, X-Payment-Response, WWW-Authenticate, Payment-Receipt` so browsers can read the 402 challenge.
- **React + Vite demo** at `examples/web/` — reference integration showing MetaMask + Phantom + `composeSigners`.

### Fixed
- **EIP-712 `signTypedData` now calls `ensureChainId`** before signing. Previously MetaMask threw `The Provider is not connected to the requested chain` for any EIP-3009 or permit sign whose `domain.chainId` differed from the wallet's active chain.
- **Browser wallet disambiguation** in the demo's `detectProvider` now excludes Coinbase Wallet by its proxy-specific keys (`providerMap`, `overrideIsMetaMask`, `selectedProvider`, `qrUrl`). Coinbase Wallet spoofs `isMetaMask: true` via `overrideIsMetaMask`, so naive `providers[0]` or `isMetaMask` filtering mis-picked Coinbase when both wallets were installed.
- **Server `validatePayment` and `/proxy` now accept `scheme: "permit"`** in addition to `scheme: "exact"`. Previously two hardcoded checks rejected permit payloads before the facilitator router could see them, breaking Tempo browser payments.
- **EVM settle failure after skill execution now returns HTTP 402** with `{error, message, facilitator}` instead of a false-positive `HTTP 200 {success: true, payment: {status: "pending"}}`. Customers were seeing "Paid" in the UI while no settlement had occurred on-chain. Pay-for-success providers using this path lose the skill cost on settle failure but no longer silently claim success.
- **Tempo EIP-712 domain name casing** corrected: `pathUSD` → `PathUSD`, `alphaUSD` → `AlphaUSD` etc. — token-per-token fixtures now match what the on-chain TIP-20 contracts expose via `name()`.

### Known Limitations
Phase 8 browser QA exercised 3 of 8 chains end-to-end in production-equivalent conditions (`base`, `base_sepolia`, `solana_devnet` — all passed with real on-chain settlements). The other 5 chains have code paths covered only by unit tests or by partial integration runs:

- **`bnb` and `bnb_testnet`** — Web Client's `approveBnb` + EIP-712 `PaymentIntent` flow has not been verified end-to-end in a browser. BNB's `requiresApproval: true` code path is structurally distinct from the one-signature flows other chains use. First BNB customer is the de-facto verification.
- **`solana:mainnet`** — `solanaRpc` override is covered by 3 unit tests but has not been verified in-browser against a real Helius/QuickNode endpoint.
- **`polygon`** — client-side EIP-3009 signature construction verified via CDP verify, but no successful on-chain settlement run in QA (tester wallet had 0 USDC on Polygon). Code path is identical to `base` which did pass.
- **`tempo_moderato`** — permit signature + on-chain allowance update verified; the subsequent `transferFrom` step did not run in QA due to tester wallet having 0 pathUSD.

See `docs/WEB-CLIENT-DESIGN.md` §Phase 8 for full QA matrix and 1.6.1 follow-up plan.

## [Unreleased]

### Added
- **Solana Chain Support** - Full Solana mainnet and devnet integration
  - New `SolanaFacilitator` for SPL token transfers
  - Separate ed25519 wallet stored at `~/.moltspay/wallet-solana.json`
  - `npx moltspay faucet --chain solana_devnet` for free testnet USDC
  - Official Circle USDC SPL token support
  - Cost: ~$0.001 SOL per transaction
  
- **BNB Chain Support** - BNB Smart Chain mainnet and testnet
  - New `BNBFacilitator` with EIP-712 intent signing
  - Gas-sponsored model (server pays ~$0.0001 per tx)
  - `npx moltspay faucet --chain bnb_testnet` gives USDC + tBNB for gas
  - Pay-for-success: payment only settles if service succeeds
  - Note: BNB uses 18 decimals (not 6 like Base/Polygon)

- **Tempo Chain Support** - Tempo Moderato testnet with MPP protocol
  - New `TempoFacilitator` for native gas-free transfers
  - TIP-20 tokens: pathUSD (USDC), alphaUSD (USDT)
  - `npx moltspay faucet --chain tempo_moderato` for free testnet tokens
  - MPP (Machine Payments Protocol) support alongside x402

- **Testnet Faucet** - `npx moltspay faucet` to get free testnet USDC
  - Base Sepolia: 1 USDC per request, once per 24 hours
  - Solana Devnet: 1 USDC per request
  - BNB Testnet: 1 USDC + 0.001 tBNB (for gas)
  - Tempo Moderato: 1 pathUSD per request

### Fixed
- **EIP-712 Domain Name** - Fixed signature verification failures on Base Sepolia
  - Server now returns correct token domain per network in `extra` field
  - Base mainnet USDC uses domain name `"USD Coin"`
  - Base Sepolia USDC uses domain name `"USDC"` (different contract!)
  - Client now uses server's `extra` field for signing instead of hardcoded values
- Added `base_sepolia` to supported chains in CLI

## [0.9.5] - 2026-03-04

### Added
- **Skill Execution Timeout** - Prevents hung skills from blocking requests forever
  - Configurable via `SKILL_TIMEOUT_SECONDS` env var (default: 1200 = 20 minutes)
  - Applies to both `/execute` and `/proxy` endpoints
  - If skill times out, payment is NOT settled (client keeps money)

### Example
```env
# In ~/.moltspay/.env
SKILL_TIMEOUT_SECONDS=1200  # 20 minutes
```

## [0.9.3] - 2026-02-23

### Fixed
- Include buyer wallet address (`from`) in `/proxy` response

## [0.9.2] - 2026-02-21

### Added
- **Proxy Execute Mode** - `/proxy` endpoint now supports skill execution with pay-on-success
  - Pass `execute: true` + `service` + `params` to execute a skill after payment verification
  - Skill executes BEFORE settlement - if skill fails, payment is NOT settled (client keeps money)
  - Perfect for platform integrations (e.g., moltspay.com marketplace)
- IP whitelist for `/proxy` endpoint (`PROXY_ALLOWED_IPS` env var)

### Changed
- `/proxy` with `execute: true` now follows pay-on-success model:
  1. Verify payment signature
  2. Execute skill
  3. If success -> settle payment, return result
  4. If fail -> don't settle, return error
- Improved logging for proxy execute flow

### Fixed
- Proxy execute now properly passes params to skill handler

### Example Usage
```bash
# Platform calls /proxy with execute mode
curl -X POST https://server.com/proxy \
  -H "Content-Type: application/json" \
  -H "X-Payment: <payment-header>" \
  -d '{
    "wallet": "0x...",
    "amount": 0.99,
    "execute": true,
    "service": "text-to-video",
    "params": {"prompt": "a cat dancing"}
  }'
```

## [0.9.1] - 2026-02-20

### Added
- Facilitator selection via environment variables:
  - `FACILITATOR_PRIMARY` - Primary facilitator (default: cdp)
  - `FACILITATOR_FALLBACK` - Comma-separated fallback list
  - `FACILITATOR_STRATEGY` - Selection strategy (failover/cheapest/fastest/random/roundrobin)
- Updated `.env.example` with all facilitator config options
- Placeholder sections for upcoming ChaosChain and Questflow facilitators

### Fixed
- Users no longer need to modify code to configure facilitators

## [0.9.0] - 2026-02-20

### Added
- **Facilitator Abstraction Layer** (Phase 1 of v0.9.0)
  - `Facilitator` interface for pluggable payment facilitators
  - `CDPFacilitator` class (extracted from server logic)
  - `FacilitatorRegistry` with selection strategies (failover, cheapest, fastest, random, roundrobin)
  - New `/health` endpoint showing facilitator status
- Exports: `moltspay/facilitators` subpath for direct access
- Server now accepts `facilitators` config option

### Changed
- Server refactored to use `FacilitatorRegistry` instead of hardcoded CDP logic
- `/services` endpoint now includes facilitator configuration in response

### Fixed
- Server now loads `.env` file before reading `USE_MAINNET` (was ignoring env file)

### Migration
- Fully backward compatible - default behavior unchanged
- New facilitator config is opt-in:
  ```typescript
  const server = new MoltsPayServer('./services.json', {
    facilitators: {
      primary: 'cdp',
      fallback: ['chaoschain'],  // Coming soon
      strategy: 'failover'
    }
  });
  ```

## [0.8.15] - 2026-02-19

### Changed
- Entry point discovery now reads `package.json` `main` field
- Falls back to `index.js` if no `main` specified
- Providers no longer need to name their entry point `index.js`

## [0.8.14] - 2026-02-19

### Added
- JSON Schema for `moltspay.services.json` validation
- `npx moltspay validate <path>` command to validate manifests
- Schema available at `schemas/moltspay.services.schema.json`

## [0.8.13] - 2026-02-19

### Changed
- Skill-based architecture: providers add only `moltspay.services.json`
- `function` field points to existing exports in skill's entry point
- Server auto-discovers entry point from skill's `package.json`
- No wrapper code needed - existing skill code stays untouched

### Fixed
- Various x402 flow improvements

## [0.5.4] - 2026-02-17

### Added
- Internal module improvements

---

## [0.4.4] - 2026-02-16

### Fixed
- Fixed imports: use `import { createX402Client } from 'moltspay'` (main export)
- Removed broken subpath exports (`/x402`, `/cdp`) that didn't exist in build

## [0.4.3] - 2026-02-16

### Fixed
- Corrected x402 endpoint URL to `https://juai8.com/zen7/v1/video/generate`

## [0.4.2] - 2026-02-16

### Changed
- **Docs overhaul:** Clarified that local wallet + x402 = NO GAS needed for client agents
- Moved CDP wallet to "optional/advanced" section (not recommended for most users)
- Added clear explanation of EIP-3009 signature flow (client signs, facilitator pays gas)

### Fixed
- Updated x402 example URLs to use actual endpoint: `https://juai8.com/x402pay`

## [0.4.1] - 2026-02-16

### Fixed
- Updated x402 example URLs to use actual endpoint: `https://juai8.com/x402pay`

## [0.4.0] - 2026-02-16

### Added

#### x402 Protocol Support
- `createX402Client()` - Create HTTP client with automatic x402 payment handling
- `x402Fetch()` - One-shot function for paid HTTP requests
- `isX402Available()` - Check if x402 packages are installed
- Automatic 402 Payment Required response handling
- Integration with official `@x402/fetch` and `@x402/evm` packages

#### CDP (Coinbase Developer Platform) Wallet
- `initCDPWallet()` - Initialize CDP-hosted wallet
- `CDPWallet` class - Manage CDP wallet operations
- `npx moltspay init --cdp` - CLI command for CDP wallet creation
- No gas needed for wallet creation
- viem account compatibility for x402 integration

#### CLI Enhancements
- `moltspay init` now supports `--cdp` flag for CDP wallet
- `moltspay init` shows clear next steps after initialization

### Changed
- x402 packages moved to peerDependencies (optional)
- CDP SDK added as optional peerDependency
- Package exports updated to include `/x402` and `/cdp` subpaths

## [0.3.0] - 2026-02-15

### Added
- AgentWallet with auto-initialization
- Direct transfer support (wallet.transfer())
- Service payment helper (wallet.payService())

## [0.2.1] - 2026-02-15

### Changed
- Converted all content to English (templates, receipts, guides, comments)
- Status markers now use `[status:xxx]` format instead of Chinese

## [0.2.0] - 2026-02-15

### Added - Agent-to-Agent Payment Flow

Complete implementation of all features required for Agent-to-Agent conversational payment flow.

#### P0: Core Features

**createWallet()** - Create wallet for buyer Agent
```typescript
import { createWallet, loadWallet } from 'moltspay';

// Create new wallet (auto-stored to ~/.moltspay/wallet.json)
const result = createWallet();
console.log('Wallet address:', result.address);

// Encrypted storage
const result = createWallet({ password: 'secure123' });

// Load existing wallet
const wallet = loadWallet({ password: 'secure123' });
```

**PermitWallet** - Pay using Boss's Permit authorization
```typescript
import { PermitWallet } from 'moltspay';

const wallet = new PermitWallet({ chain: 'base' });

// Pay using Boss-signed Permit
const result = await wallet.transferWithPermit({
  to: '0xSELLER...',
  amount: 3.99,
  permit: {
    owner: '0xBOSS...',
    spender: wallet.address,
    value: '10000000',
    deadline: 1234567890,
    v: 27,
    r: '0x...',
    s: '0x...'
  }
});
```

#### P1: Receipt Generation

**generateReceipt()** - Generate transaction receipt
```typescript
import { generateReceipt, formatReceiptText } from 'moltspay';

const receipt = generateReceipt({
  orderId: 'vo_abc123',
  service: 'Video generation 5s 720p',
  amount: 3.99,
  chain: 'base',
  txHash: '0x...',
  payerAddress: '0xBUYER...',
  recipientAddress: '0xSELLER...',
  delivery: {
    url: 'https://...',
    fileHash: 'sha256:...'
  }
});

// Format as plain text (for Feishu/WhatsApp)
console.log(formatReceiptText(receipt));
```

#### P2: Conversation Templates

**SellerTemplates / BuyerTemplates** - Standardized dialogue templates
```typescript
import { SellerTemplates, BuyerTemplates, parseStatusMarker } from 'moltspay';

// Seller templates
SellerTemplates.askPaymentCapability();
SellerTemplates.guideInstall();
SellerTemplates.quote({ service: 'Video gen', price: 3.99, recipientAddress: '0x...' });

// Buyer templates
BuyerTemplates.requestService('video generation');
BuyerTemplates.walletCreated('0x...');
BuyerTemplates.paymentSent('0xtx...', 3.99);

// Parse status markers
const status = parseStatusMarker('[status:payment_sent tx=0xabc amount=3.99 USDC]');
// { type: 'payment_sent', data: { txHash: '0xabc', amount: '3.99' } }
```

### New Exports

```typescript
// Wallet creation
export { createWallet, loadWallet, getWalletAddress, walletExists } from 'moltspay';

// Permit wallet
export { PermitWallet, formatPermitRequest } from 'moltspay';

// Receipt
export { generateReceipt, generateReceiptFromInvoice, formatReceiptMessage, formatReceiptText, formatReceiptJson } from 'moltspay';

// Conversation templates
export { SellerTemplates, BuyerTemplates, StatusMarkers, parseStatusMarker } from 'moltspay';
```

---

## [0.1.3] - 2026-02-10

### Added
- OrderManager for order management
- Payment guide message generation

## [0.1.2] - 2026-02-08

### Added
- SecureWallet (limits/whitelist/audit)
- AuditLog for immutable audit logging

## [0.1.1] - 2026-02-06

### Added
- PaymentAgent core class
- Invoice generation
- On-chain payment verification
- Multi-chain support (Base, Polygon, Ethereum)

## [0.1.0] - 2026-02-05

### Added
- Initial release
- Basic Wallet class
- EIP-2612 Permit support
