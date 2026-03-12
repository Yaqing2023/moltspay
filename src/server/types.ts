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

// Server options
export interface MoltsPayServerOptions {
  port?: number;
  host?: string;
  chargeExpirySecs?: number;
  /** x402 Facilitator URL (default: https://x402.org/facilitator) */
  facilitatorUrl?: string;
}
