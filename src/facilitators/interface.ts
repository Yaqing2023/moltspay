/**
 * Facilitator Interface
 * 
 * A facilitator is a service that handles x402 payment verification and settlement.
 * This abstraction allows MoltsPay to support multiple facilitators.
 * 
 * @see https://www.x402.org/ecosystem?category=facilitators
 */

/**
 * x402 Payment Payload (from client)
 */
export interface X402PaymentPayload {
  x402Version: number;
  scheme?: string;
  network?: string;
  accepted?: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
  };
  payload: unknown;
}

/**
 * x402 Payment Requirements (server specifies what it accepts)
 */
export interface X402PaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/**
 * Result of payment verification
 */
export interface VerifyResult {
  valid: boolean;
  error?: string;
  details?: Record<string, unknown>;
}

/**
 * Result of payment settlement
 */
export interface SettleResult {
  success: boolean;
  transaction?: string;
  error?: string;
  status?: string;
}

/**
 * Facilitator health check result
 */
export interface HealthCheckResult {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * Facilitator fee information (for selection strategies)
 */
export interface FacilitatorFee {
  perTx: number;
  currency: string;
  freeQuota?: number;
}

/**
 * Facilitator configuration
 */
export interface FacilitatorConfig {
  /** Facilitator endpoint URL */
  endpoint?: string;
  /** API key (if required) */
  apiKey?: string;
  /** API secret (if required) */
  apiSecret?: string;
  /** Additional config specific to facilitator */
  [key: string]: unknown;
}

/**
 * Facilitator Interface
 * 
 * All facilitators must implement this interface.
 */
export interface Facilitator {
  /** Unique identifier for this facilitator */
  readonly name: string;
  
  /** Human-readable display name */
  readonly displayName: string;
  
  /** Supported networks (e.g., ["eip155:8453", "eip155:84532"]) */
  readonly supportedNetworks: string[];
  
  /**
   * Check if facilitator is available and responsive
   */
  healthCheck(): Promise<HealthCheckResult>;
  
  /**
   * Verify a payment signature without executing it
   * 
   * @param paymentPayload - The x402 payment payload from client
   * @param requirements - The payment requirements from server
   */
  verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult>;
  
  /**
   * Settle a payment on-chain
   * 
   * @param paymentPayload - The x402 payment payload from client
   * @param requirements - The payment requirements from server
   */
  settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<SettleResult>;
  
  /**
   * Get current fee information (optional, for selection strategies)
   */
  getFee?(): Promise<FacilitatorFee>;
  
  /**
   * Check if this facilitator supports a given network
   */
  supportsNetwork(network: string): boolean;
}

/**
 * Base class with common functionality
 */
export abstract class BaseFacilitator implements Facilitator {
  abstract readonly name: string;
  abstract readonly displayName: string;
  abstract readonly supportedNetworks: string[];
  
  abstract healthCheck(): Promise<HealthCheckResult>;
  abstract verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult>;
  abstract settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<SettleResult>;
  
  supportsNetwork(network: string): boolean {
    return this.supportedNetworks.includes(network);
  }
}
