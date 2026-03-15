/**
 * CDP Facilitator
 * 
 * Coinbase Developer Platform x402 facilitator implementation.
 * Auto-detects mainnet vs testnet from chain ID in request.
 * 
 * Supported networks:
 * - Base mainnet (eip155:8453)
 * - Polygon mainnet (eip155:137)
 * - Base Sepolia testnet (eip155:84532)
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

// CDP Facilitator URL (handles both mainnet and testnet)
const CDP_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

// Testnet chain IDs (for logging/info only - CDP auto-detects from network field)
const TESTNET_CHAIN_IDS = [84532]; // Base Sepolia

export interface CDPFacilitatorConfig extends FacilitatorConfig {
  /** CDP API Key ID (required) */
  apiKeyId?: string;
  /** CDP API Key Secret (required) */
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
  private apiKeyId?: string;
  private apiKeySecret?: string;
  
  constructor(config: CDPFacilitatorConfig = {}) {
    super();
    
    // Load env files for credentials
    loadEnvFile();
    
    // Get credentials (required for CDP)
    this.apiKeyId = config.apiKeyId || process.env.CDP_API_KEY_ID;
    this.apiKeySecret = config.apiKeySecret || process.env.CDP_API_KEY_SECRET;
    
    // Single endpoint handles both mainnet and testnet (auto-detected from chain ID in request)
    this.endpoint = CDP_URL;
    
    // All supported networks - CDP handles both mainnet and testnet
    this.supportedNetworks = [
      'eip155:8453',   // Base mainnet
      'eip155:137',    // Polygon mainnet
      'eip155:84532',  // Base Sepolia (testnet)
    ];
    
    // Warn if missing credentials
    if (!this.apiKeyId || !this.apiKeySecret) {
      console.warn('[CDPFacilitator] WARNING: Missing CDP credentials!');
      console.warn('[CDPFacilitator] Set CDP_API_KEY_ID and CDP_API_KEY_SECRET in ~/.moltspay/.env');
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
    if (!this.apiKeyId || !this.apiKeySecret) {
      throw new Error('CDP credentials required. Set CDP_API_KEY_ID and CDP_API_KEY_SECRET');
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
      
      const authHeaders = await this.getAuthHeaders(
        'POST',
        '/platform/v2/x402/verify',
        requestBody
      );
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
      };
      
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
      
      const authHeaders = await this.getAuthHeaders(
        'POST',
        '/platform/v2/x402/settle',
        requestBody
      );
      
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
      };
      
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
   * Check if a chain ID is testnet
   */
  static isTestnet(chainId: number): boolean {
    return TESTNET_CHAIN_IDS.includes(chainId);
  }
  
  /**
   * Get configuration summary (for logging)
   */
  getConfigSummary(): string {
    const hasCredentials = !!(this.apiKeyId && this.apiKeySecret);
    const networks = this.supportedNetworks.join(', ');
    return `CDP Facilitator (networks: ${networks}, credentials: ${hasCredentials ? 'yes' : 'no'})`;
  }
}
