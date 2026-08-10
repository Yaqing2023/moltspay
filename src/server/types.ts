/**
 * MoltsPay Server Types
 */

// Supported token types
export type TokenSymbol = 'USDC' | 'USDT';

// Service definition from moltspay.services.json
export interface ServiceConfig {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  /**
   * Tokens accepted for payment (optional).
   * If not specified, defaults to [currency].
   * Example: ["USDC", "USDT"]
   */
  acceptedCurrencies?: TokenSymbol[];
  input: Record<string, InputField>;
  output: Record<string, OutputField>;
  /** Shell command to execute for this service. Params passed as JSON to stdin. */
  command?: string;
  /** Function name to import from skill's index.js (new skill-based approach) */
  function?: string;
  /**
   * Alipay AI Pay per-service config (2.0.0+).
   * Set when this service accepts CNY payments via the alipay rail.
   * The `price`/`currency` fields above still describe USDC pricing
   * for the x402 rails; `alipay.price_cny` is a separate CNY price.
   */
  alipay?: ServiceAlipayConfig;
  /**
   * WeChat Pay v3 Native per-service config (2.1.0+).
   * Set when this service accepts CNY payments via the wechat rail.
   * The `price`/`currency` fields above still describe USDC pricing for the
   * x402 rails; `wechat.price_cny` is a separate CNY price.
   */
  wechat?: ServiceWechatConfig;
  /**
   * Custodial balance per-service config (2.2.0+).
   * Set when this service accepts password-free deduction from
   * server-custodied buyer balances. `balance.price` defaults to the
   * service's top-level `price` when omitted.
   */
  balance?: ServiceBalanceConfig;
}

/**
 * Per-service custodial balance configuration (2.2.0+).
 *
 * Sample:
 * ```json
 * "balance": {
 *   "price": "3.99"
 * }
 * ```
 */
export interface ServiceBalanceConfig {
  /**
   * Price in the ledger currency as a decimal string (e.g. `"3.99"`).
   * Defaults to the service's top-level `price` when omitted.
   * Must match `/^\d+(\.\d{1,2})?$/`.
   */
  price?: string;
}

/**
 * Per-service WeChat Pay Native configuration (2.1.0+).
 *
 * Sample:
 * ```json
 * "wechat": {
 *   "price_cny": "10.00",
 *   "description": "Demo video - series one"
 * }
 * ```
 */
export interface ServiceWechatConfig {
  /**
   * CNY price as a decimal string in **yuan** (e.g. `"10.00"` = 10 CNY).
   * NOT fen: `"100"` means 100 yuan, not 100 fen.
   * Must match `/^\d+(\.\d{1,2})?$/`.
   */
  price_cny: string;
  /** Order description shown to the payer in the WeChat app. */
  description: string;
}

/**
 * Per-service Alipay AI Pay configuration (2.0.0+).
 *
 * Sample:
 * ```json
 * "alipay": {
 *   "service_id": "API_0EA6DC4FC99A4DF7",
 *   "price_cny": "7.00",
 *   "goods_name": "Product demo video - series 1"
 * }
 * ```
 */
export interface ServiceAlipayConfig {
  /** Per-service service_id (defaults to provider.alipay.service_id_default). */
  service_id?: string;
  /**
   * CNY price as decimal string in **yuan** (e.g. `"7.00"` = 7 CNY).
   * NOT cents: `"100"` means 100 yuan, not 100 fen.
   * Must match `/^\d+(\.\d{1,2})?$/`.
   */
  price_cny: string;
  /** Goods name shown to the user in the Alipay app. */
  goods_name: string;
}

export interface InputField {
  type: 'string' | 'number' | 'boolean' | 'object';
  required?: boolean;
  description?: string;
}

export interface OutputField {
  type: 'string' | 'number' | 'boolean' | 'object';
  description?: string;
}

// Chain configuration for multi-chain support
export interface ChainConfig {
  chain: string;
  network: string;
  wallet?: string;  // Optional per-chain wallet, falls back to provider.wallet
  tokens?: TokenSymbol[];
}

// Provider config from moltspay.services.json
export interface ProviderConfig {
  name: string;
  description?: string;
  wallet: string;
  solana_wallet?: string;  // Solana chains receiving wallet
  chain?: string;  // Single chain (backward compat)
  chains?: ChainConfig[];  // Multi-chain support
  /**
   * Alipay AI Pay provider-level config (2.0.0+).
   * Required when `chains` includes `"alipay"`.
   * Server validates `private_key_path` / `alipay_public_key_path` are
   * readable + parse as RSA PEM at startup; rejects start otherwise.
   */
  alipay?: ProviderAlipayConfig;
  /**
   * WeChat Pay v3 provider-level config (2.1.0+).
   * Required when `chains` includes `"wechat"`. The server resolves the PEM
   * file paths + validates them at startup; rejects start otherwise.
   */
  wechat?: ProviderWechatConfig;
  /**
   * Custodial balance rail provider-level config (2.2.0+).
   * Required when `chains` includes `"balance"`. Requires Node >= 22.5
   * (node:sqlite); the server rejects start otherwise.
   */
  balance?: ProviderBalanceConfig;
}

/**
 * Provider-level custodial balance rail configuration (2.2.0+).
 *
 * Sample:
 * ```json
 * "balance": {
 *   "db_path": "./data/balance.sqlite",
 *   "currency": "USD",
 *   "single_limit": "5.00",
 *   "daily_limit": "10.00"
 * }
 * ```
 */
export interface ProviderBalanceConfig {
  /** SQLite ledger file path (relative to moltspay.services.json). Created on first start. */
  db_path: string;
  /** Ledger quote currency. Defaults to `"USD"`. */
  currency?: string;
  /** Default per-transaction limit for new buyers, decimal string. Defaults to `"5.00"`. */
  single_limit?: string;
  /** Default daily limit for new buyers, decimal string. Defaults to `"10.00"`. */
  daily_limit?: string;
  /** Offered top-up pack amounts in ledger currency (2.3+), e.g. `["20.00","50.00"]`. */
  topup_packs?: string[];
  /** Pack the client auto-selects when a 402 finds an insufficient balance (2.3+). Must be one of `topup_packs`. */
  default_pack?: string;
  /** Ceiling on client auto-top-up without explicit pack selection (2.3+). */
  auto_topup_max?: string;
  /** User-auth rollout gate for deductions: `off` | `shadow` | `enforce`. Default `off`. */
  auth_mode?: 'off' | 'shadow' | 'enforce';
  /**
   * Shared operator secret gating the credit/reverse endpoints
   * (`POST /balance/topup`, `POST /balance/refund`). These mint or reverse
   * balance and are operator-only. May also be supplied via the
   * `MOLTSPAY_BALANCE_OPERATOR_KEY` env var (env takes precedence). When
   * neither is set, both endpoints are DISABLED (503) — fail closed.
   */
  operator_key?: string;
}

/**
 * Provider-level WeChat Pay v3 configuration (2.1.0+).
 *
 * The user-facing form uses FILE PATHS for the PEM keys; the server resolves
 * them to PEM strings before constructing WechatFacilitator.
 *
 * Sample:
 * ```json
 * "wechat": {
 *   "mchid": "1900000001",
 *   "appid": "wx8888888888888888",
 *   "serial_no": "5157F09EFDC096DE15EBE81A47057A72...",
 *   "private_key_path": "./cert/wechat_apiclient_key.pem",
 *   "platform_public_key_path": "./cert/wechat_platform_cert.pem",
 *   "apiv3_key": "your32byteapiv3keyhere0123456789",
 *   "notify_url": "https://your.host/wechat/notify"
 * }
 * ```
 */
export interface ProviderWechatConfig {
  /** Merchant id (mchid). */
  mchid: string;
  /** App id (official account / mini-program / app). */
  appid: string;
  /** Merchant API certificate serial number. */
  serial_no: string;
  /** Path to the merchant RSA private key PEM (relative to moltspay.services.json). */
  private_key_path: string;
  /** Path to the WeChat platform certificate public key PEM. Enables response verification. */
  platform_public_key_path?: string;
  /** APIv3 key (32 bytes). Only needed for callback decryption (Phase 2). */
  apiv3_key?: string;
  /** Async result notify URL. Required by Native order create even when polling. */
  notify_url: string;
  /** Open API base URL. Defaults to `"https://api.mch.weixin.qq.com"`. */
  api_base?: string;
}

/**
 * Provider-level Alipay AI Pay configuration (2.0.0+).
 *
 * The user-facing form uses FILE PATHS for both PEM keys; the server
 * resolves them to PEM strings before constructing AlipayFacilitator.
 *
 * Sample:
 * ```json
 * "alipay": {
 *   "seller_id": "2088641494699428",
 *   "app_id": "2021006150642142",
 *   "seller_name": "Example Co., Ltd.",
 *   "service_id_default": "API_0EA6DC4FC99A4DF7",
 *   "private_key_path": "./cert/ALIPAY_PRIVATE_KEY.txt",
 *   "alipay_public_key_path": "./cert/ALIPAY_PUBLIC_KEY.txt"
 * }
 * ```
 */
export interface ProviderAlipayConfig {
  /** Merchant Alipay ID (16 digits, e.g. `"2088641494699428"`). */
  seller_id: string;
  /** Application ID from Alipay Open Platform. */
  app_id: string;
  /** Merchant legal name; appears in `method.seller_name` of the 402 challenge. */
  seller_name: string;
  /** Default `service_id` when a `services[].alipay` entry doesn't override it. */
  service_id_default: string;
  /** Path to the RSA2 merchant private key PEM file (relative to moltspay.services.json). */
  private_key_path: string;
  /** Path to the Alipay platform public key PEM file (relative to moltspay.services.json). */
  alipay_public_key_path: string;
  /** Open API gateway URL. Defaults to `"https://openapi.alipay.com/gateway.do"`. */
  gateway_url?: string;
  /** Signature algorithm. Only `"RSA2"` is supported in 2.0.0. */
  sign_type?: 'RSA2';
}

// Full services.json structure
export interface ServicesManifest {
  provider: ProviderConfig;
  services: ServiceConfig[];
}

// Skill function type
export type SkillFunction = (params: Record<string, any>) => Promise<Record<string, any>>;

// Registered skill
export interface RegisteredSkill {
  id: string;
  config: ServiceConfig;
  handler: SkillFunction;
}

// Payment request (returned to client)
export interface PaymentRequest {
  chargeId: string;
  service: string;
  amount: number;
  currency: string;
  wallet: string;
  chain: string;
  expiresAt: number;
}

// Payment verification request
export interface VerifyRequest {
  chargeId: string;
  txHash: string;
}

// Charge status
export type ChargeStatus = 'pending' | 'paid' | 'completed' | 'expired' | 'failed';

// Internal charge record
export interface Charge {
  id: string;
  service: string;
  params: Record<string, any>;
  amount: number;
  currency: string;
  status: ChargeStatus;
  txHash?: string;
  result?: Record<string, any>;
  createdAt: number;
  expiresAt: number;
  paidAt?: number;
  completedAt?: number;
}

/**
 * CORS configuration. See MoltsPayServerOptions.cors.
 * Fine-grained shape for providers that need allowlist origins or custom control.
 */
export interface CorsOptions {
  /** Explicit origin allowlist. Either an array of origins, or a predicate function. */
  origins: string[] | ((origin: string) => boolean);
  /** Emit `Access-Control-Allow-Credentials: true`. Default false. */
  credentials?: boolean;
  /** Preflight cache seconds (`Access-Control-Max-Age`). Default 600. */
  maxAge?: number;
}

// Server options
export interface MoltsPayServerOptions {
  port?: number;
  host?: string;
  chargeExpirySecs?: number;
  /** x402 Facilitator URL (default: https://x402.org/facilitator) */
  facilitatorUrl?: string;

  /**
   * CORS configuration.
   *
   * - `undefined` or `true` (default): allow any origin (`Access-Control-Allow-Origin: *`).
   *   This matches the 1.5.x behavior — browser clients from any origin can call this server.
   * - `false`: emit no CORS headers (same-origin only).
   * - `string[]`: explicit origin allowlist. Request's Origin must match an entry.
   * - `CorsOptions` object: fine-grained control (origins + credentials + maxAge).
   *
   * When CORS is active, the server always exposes the following response headers via
   * `Access-Control-Expose-Headers`: `X-Payment-Required`, `X-Payment-Response`,
   * `WWW-Authenticate`, `Payment-Receipt`. These are required for browser clients to
   * read the 402 challenge and the payment receipt on successful responses.
   */
  cors?: boolean | string[] | CorsOptions;
}
