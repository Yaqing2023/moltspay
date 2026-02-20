/**
 * CDP Facilitator
 * 
 * Coinbase Developer Platform x402 facilitator implementation.
 * Supports both mainnet (Base) and testnet (Base Sepolia).
 * 
 * @see https://docs.cdp.coinbase.com/x402/core-concepts/facilitator
 */

import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import {
  BaseFacilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
  SettleResult,
  HealthCheckResult,
  FacilitatorFee,
  FacilitatorConfig,
} from './interface.js';

// x402 protocol version
const X402_VERSION = 2;

// CDP Facilitator URLs
const CDP_MAINNET_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
const CDP_TESTNET_URL = 'https://www.x402.org/facilitator';

export interface CDPFacilitatorConfig extends FacilitatorConfig {
  /** Use mainnet (true) or testnet (false, default) */
  useMainnet?: boolean;
  /** CDP API Key ID (required for mainnet) */
  apiKeyId?: string;
  /** CDP API Key Secret (required for mainnet) */
  apiKeySecret?: string;
}

/**
 * Load environment from .env files
 */
function loadEnvFile(): void {
  const envPaths = [
    path.join(process.cwd(), '.env'),
    path.join(process.env.HOME || '', '.moltspay', '.env'),
  ];
  
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex === -1) continue;
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
        break;
      } catch {
        // Ignore errors
      }
    }
  }
}

/**
 * CDP (Coinbase Developer Platform) Facilitator
 * 
 * Handles payment verification and settlement via Coinbase's x402 facilitator.
 */
export class CDPFacilitator extends BaseFacilitator {
  readonly name = 'cdp';
  readonly displayName = 'Coinbase CDP';
  readonly supportedNetworks: string[];
  
  private endpoint: string;
  private useMainnet: boolean;
  private apiKeyId?: string;
  private apiKeySecret?: string;
  
  constructor(config: CDPFacilitatorConfig = {}) {
    super();
    
    // Load env files for credentials
    loadEnvFile();
    
    // Determine mainnet vs testnet
    this.useMainnet = config.useMainnet ?? 
      (process.env.USE_MAINNET?.toLowerCase() === 'true');
    
    // Get credentials
    this.apiKeyId = config.apiKeyId || process.env.CDP_API_KEY_ID;
    this.apiKeySecret = config.apiKeySecret || process.env.CDP_API_KEY_SECRET;
    
    // Set endpoint
    this.endpoint = this.useMainnet ? CDP_MAINNET_URL : CDP_TESTNET_URL;
    
    // Set supported networks
    this.supportedNetworks = this.useMainnet 
      ? ['eip155:8453']  // Base mainnet only
      : ['eip155:8453', 'eip155:84532'];  // Both mainnet and testnet via x402.org
    
    // Warn if mainnet without credentials
    if (this.useMainnet && (!this.apiKeyId || !this.apiKeySecret)) {
      console.warn('[CDPFacilitator] WARNING: Mainnet mode but missing CDP credentials!');
      console.warn('[CDPFacilitator] Set CDP_API_KEY_ID and CDP_API_KEY_SECRET');
    }
  }
  
  /**
   * Get auth headers for CDP API requests
   */
  private async getAuthHeaders(
    method: string,
    urlPath: string,
    body?: unknown
  ): Promise<Record<string, string>> {
    if (!this.useMainnet) {
      // Testnet (x402.org) doesn't require auth
      return {};
    }
    
    if (!this.apiKeyId || !this.apiKeySecret) {
      throw new Error('CDP credentials required for mainnet');
    }
    
    try {
      const { getAuthHeaders } = await import('@coinbase/cdp-sdk/auth');
      
      return await getAuthHeaders({
        apiKeyId: this.apiKeyId,
        apiKeySecret: this.apiKeySecret,
        requestMethod: method,
        requestHost: 'api.cdp.coinbase.com',
        requestPath: urlPath,
        requestBody: body,
      });
    } catch (err: any) {
      throw new Error(`Failed to generate CDP auth: ${err.message}`);
    }
  }
  
  /**
   * Health check - verify facilitator is reachable
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    
    try {
      // For testnet, just check if x402.org responds
      // For mainnet, we could hit a health endpoint or just check DNS
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await fetch(this.endpoint.replace('/x402', ''), {
        method: 'HEAD',
        signal: controller.signal,
      }).catch(() => null);
      
      clearTimeout(timeout);
      
      const latencyMs = Date.now() - start;
      
      return {
        healthy: response !== null,
        latencyMs,
      };
    } catch (err: any) {
      return {
        healthy: false,
        error: err.message,
        latencyMs: Date.now() - start,
      };
    }
  }
  
  /**
   * Verify payment signature with facilitator
   */
  async verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult> {
    try {
      const requestBody = {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements: requirements,
      };
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      
      if (this.useMainnet) {
        const authHeaders = await this.getAuthHeaders(
          'POST',
          '/platform/v2/x402/verify',
          requestBody
        );
        Object.assign(headers, authHeaders);
      }
      
      const response = await fetch(`${this.endpoint}/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
      
      const result = await response.json() as any;
      
      if (!response.ok || !result.isValid) {
        return {
          valid: false,
          error: result.invalidReason || result.error || 'Verification failed',
          details: result,
        };
      }
      
      return { valid: true, details: result };
    } catch (err: any) {
      return {
        valid: false,
        error: `Facilitator error: ${err.message}`,
      };
    }
  }
  
  /**
   * Settle payment on-chain via facilitator
   */
  async settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<SettleResult> {
    try {
      const requestBody = {
        x402Version: X402_VERSION,
        paymentPayload,
        paymentRequirements: requirements,
      };
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      
      if (this.useMainnet) {
        const authHeaders = await this.getAuthHeaders(
          'POST',
          '/platform/v2/x402/settle',
          requestBody
        );
        Object.assign(headers, authHeaders);
      }
      
      const response = await fetch(`${this.endpoint}/settle`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
      
      const result = await response.json() as any;
      
      if (!response.ok || !result.success) {
        return {
          success: false,
          error: result.error || result.errorReason || 'Settlement failed',
        };
      }
      
      return {
        success: true,
        transaction: result.transaction,
        status: result.status || 'settled',
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Settlement error: ${err.message}`,
      };
    }
  }
  
  /**
   * Get CDP fee information
   */
  async getFee(): Promise<FacilitatorFee> {
    // CDP pricing: 1000 free/month, then $0.001/tx
    return {
      perTx: 0.001,
      currency: 'USD',
      freeQuota: 1000,
    };
  }
  
  /**
   * Get configuration summary (for logging)
   */
  getConfigSummary(): string {
    const mode = this.useMainnet ? 'mainnet' : 'testnet';
    const hasCredentials = !!(this.apiKeyId && this.apiKeySecret);
    return `CDP Facilitator (${mode}, credentials: ${hasCredentials ? 'yes' : 'no'})`;
  }
}
