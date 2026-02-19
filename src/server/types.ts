/**
 * MoltsPay Server Types
 */

// Service definition from moltspay.services.json
export interface ServiceConfig {
  id: string;
  name: string;
  description?: string;
  price: number;
  currency: string;
  input: Record<string, InputField>;
  output: Record<string, OutputField>;
  /** Shell command to execute for this service. Params passed as JSON to stdin. */
  command?: string;
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

// Provider config from moltspay.services.json
export interface ProviderConfig {
  name: string;
  description?: string;
  wallet: string;
  chain: string;
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
