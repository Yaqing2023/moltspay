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
