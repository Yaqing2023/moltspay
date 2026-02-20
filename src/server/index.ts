/**
 * MoltsPay Server - Payment infrastructure for AI Agents
 * 
 * Now uses pluggable Facilitator abstraction for payment verification/settlement.
 * 
 * Environment variables (from ~/.moltspay/.env or process.env):
 *   USE_MAINNET=true          - Use Base mainnet (requires CDP keys)
 *   CDP_API_KEY_ID=xxx        - Coinbase Developer Platform API key ID
 *   CDP_API_KEY_SECRET=xxx    - CDP API key secret
 * 
 * Usage:
 *   const server = new MoltsPayServer('./moltspay.services.json');
 *   server.skill('text-to-video', async (params) => { ... });
 *   server.listen(3000);
 */

import { readFileSync, existsSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import {
  FacilitatorRegistry,
  FacilitatorSelection,
  X402PaymentPayload,
  X402PaymentRequirements,
} from '../facilitators/index.js';
import {
  ServicesManifest,
  ServiceConfig,
  SkillFunction,
  RegisteredSkill,
  MoltsPayServerOptions,
} from './types.js';

export * from './types.js';

// x402 constants
const X402_VERSION = 2;
const PAYMENT_REQUIRED_HEADER = 'x-payment-required';
const PAYMENT_HEADER = 'x-payment';
const PAYMENT_RESPONSE_HEADER = 'x-payment-response';

// USDC contract addresses
const USDC_ADDRESSES: Record<string, string> = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',   // Base mainnet
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
};

// EIP-712 domain info for USDC
const USDC_DOMAIN = {
  name: 'USD Coin',
  version: '2',
};

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
        console.log(`[MoltsPay] Loaded config from ${envPath}`);
        break;
      } catch {
        // Ignore errors
      }
    }
  }
}

/**
 * Extended server options with facilitator config
 */
export interface MoltsPayServerOptionsExtended extends MoltsPayServerOptions {
  /** Facilitator selection configuration */
  facilitators?: FacilitatorSelection;
}

export class MoltsPayServer {
  private manifest: ServicesManifest;
  private skills: Map<string, RegisteredSkill> = new Map();
  private options: MoltsPayServerOptionsExtended;
  private registry: FacilitatorRegistry;
  private networkId: string;
  private useMainnet: boolean;

  constructor(servicesPath: string, options: MoltsPayServerOptionsExtended = {}) {
    // Load env files FIRST (before reading USE_MAINNET)
    loadEnvFile();
    
    // Load services manifest
    const content = readFileSync(servicesPath, 'utf-8');
    this.manifest = JSON.parse(content) as ServicesManifest;
    
    this.options = {
      port: options.port || 3000,
      host: options.host || '0.0.0.0',
      ...options,
    };

    // Determine mainnet vs testnet from env
    this.useMainnet = process.env.USE_MAINNET?.toLowerCase() === 'true';
    this.networkId = this.useMainnet ? 'eip155:8453' : 'eip155:84532';

    // Create facilitator registry with config (env vars take precedence)
    const facilitatorConfig: FacilitatorSelection = options.facilitators || {
      primary: process.env.FACILITATOR_PRIMARY || 'cdp',
      fallback: process.env.FACILITATOR_FALLBACK?.split(',').filter(Boolean),
      strategy: (process.env.FACILITATOR_STRATEGY as any) || 'failover',
      config: {
        cdp: { useMainnet: this.useMainnet },
      },
    };
    this.registry = new FacilitatorRegistry(facilitatorConfig);

    // Get primary facilitator for logging
    const primaryFacilitator = this.registry.get(facilitatorConfig.primary);
    const networkName = this.useMainnet ? 'Base mainnet' : 'Base Sepolia (testnet)';
    
    console.log(`[MoltsPay] Loaded ${this.manifest.services.length} services from ${servicesPath}`);
    console.log(`[MoltsPay] Provider: ${this.manifest.provider.name}`);
    console.log(`[MoltsPay] Receive wallet: ${this.manifest.provider.wallet}`);
    console.log(`[MoltsPay] Network: ${this.networkId} (${networkName})`);
    console.log(`[MoltsPay] Facilitator: ${primaryFacilitator.displayName} (${facilitatorConfig.strategy || 'failover'})`);
    console.log(`[MoltsPay] Protocol: x402 (gasless for both client AND server)`);
  }

  /**
   * Register a skill handler for a service
   */
  skill(serviceId: string, handler: SkillFunction): this {
    const config = this.manifest.services.find(s => s.id === serviceId);
    if (!config) {
      throw new Error(`Service '${serviceId}' not found in manifest`);
    }
    this.skills.set(serviceId, { id: serviceId, config, handler });
    return this;
  }

  /**
   * Start HTTP server
   */
  listen(port?: number): void {
    const p = port || this.options.port || 3000;
    const host = this.options.host || '0.0.0.0';

    const server = createServer((req, res) => this.handleRequest(req, res));
    server.listen(p, host, () => {
      console.log(`[MoltsPay] Server listening on http://${host}:${p}`);
      console.log(`[MoltsPay] Endpoints:`);
      console.log(`  GET  /services     - List available services`);
      console.log(`  POST /execute      - Execute service (x402 payment)`);
      console.log(`  GET  /health       - Health check (incl. facilitators)`);
    });
  }

  /**
   * Handle incoming request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment');
    res.setHeader('Access-Control-Expose-Headers', 'X-Payment-Required, X-Payment-Response');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      
      if (url.pathname === '/services' && req.method === 'GET') {
        return this.handleGetServices(res);
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return await this.handleHealthCheck(res);
      }

      if (url.pathname === '/execute' && req.method === 'POST') {
        const body = await this.readBody(req);
        const paymentHeader = req.headers[PAYMENT_HEADER] as string | undefined;
        return await this.handleExecute(body, paymentHeader, res);
      }

      // Not found
      this.sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      console.error('[MoltsPay] Error:', err);
      this.sendJson(res, 500, { error: err.message || 'Internal error' });
    }
  }

  /**
   * GET /services - List available services
   */
  private handleGetServices(res: ServerResponse): void {
    const services = this.manifest.services.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      price: s.price,
      currency: s.currency,
      input: s.input,
      output: s.output,
      available: this.skills.has(s.id),
    }));

    const selection = this.registry.getSelection();
    
    this.sendJson(res, 200, {
      provider: this.manifest.provider,
      services,
      x402: {
        version: X402_VERSION,
        network: this.networkId,
        schemes: ['exact'],
        facilitators: {
          primary: selection.primary,
          fallback: selection.fallback,
          strategy: selection.strategy,
        },
        mainnet: this.useMainnet,
      },
    });
  }

  /**
   * GET /health - Health check endpoint
   */
  private async handleHealthCheck(res: ServerResponse): Promise<void> {
    const facilitatorHealth = await this.registry.healthCheckAll();
    
    const allHealthy = Object.values(facilitatorHealth).every(h => h.healthy);
    
    this.sendJson(res, allHealthy ? 200 : 503, {
      status: allHealthy ? 'healthy' : 'degraded',
      network: this.networkId,
      facilitators: facilitatorHealth,
      services: this.manifest.services.length,
      registered: this.skills.size,
    });
  }

  /**
   * POST /execute - Execute service with x402 payment
   */
  private async handleExecute(
    body: any,
    paymentHeader: string | undefined,
    res: ServerResponse
  ): Promise<void> {
    const { service, params } = body;

    if (!service) {
      return this.sendJson(res, 400, { error: 'Missing service' });
    }

    const skill = this.skills.get(service);
    if (!skill) {
      return this.sendJson(res, 404, { error: `Service '${service}' not found or not registered` });
    }

    // Validate required params
    for (const [key, field] of Object.entries(skill.config.input)) {
      if (field.required && (!params || params[key] === undefined)) {
        return this.sendJson(res, 400, { error: `Missing required param: ${key}` });
      }
    }

    // If no payment header, return 402 with payment requirements
    if (!paymentHeader) {
      return this.sendPaymentRequired(skill.config, res);
    }

    // Parse payment payload
    let payment: X402PaymentPayload;
    try {
      const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
      payment = JSON.parse(decoded);
    } catch {
      return this.sendJson(res, 400, { error: 'Invalid X-Payment header' });
    }

    // Validate basic payment fields
    const validation = this.validatePayment(payment, skill.config);
    if (!validation.valid) {
      return this.sendJson(res, 402, { error: validation.error });
    }

    // Build requirements for facilitator
    const requirements = this.buildPaymentRequirements(skill.config);

    // Verify payment with facilitator (via registry)
    console.log(`[MoltsPay] Verifying payment...`);
    const verifyResult = await this.registry.verify(payment, requirements);
    if (!verifyResult.valid) {
      return this.sendJson(res, 402, { 
        error: `Payment verification failed: ${verifyResult.error}`,
        facilitator: verifyResult.facilitator,
      });
    }
    console.log(`[MoltsPay] Verified by ${verifyResult.facilitator}`);

    // Execute skill FIRST (pay-for-success)
    console.log(`[MoltsPay] Executing skill: ${service}`);
    let result: any;
    try {
      result = await skill.handler(params || {});
    } catch (err: any) {
      console.error('[MoltsPay] Skill execution failed:', err.message);
      return this.sendJson(res, 500, {
        error: 'Service execution failed',
        message: err.message,
      });
    }

    // Skill succeeded - now settle payment with facilitator
    console.log(`[MoltsPay] Skill succeeded, settling payment...`);
    let settlement: any = null;
    try {
      settlement = await this.registry.settle(payment, requirements);
      console.log(`[MoltsPay] Payment settled by ${settlement.facilitator}: ${settlement.transaction || 'pending'}`);
    } catch (err: any) {
      console.error('[MoltsPay] Settlement failed:', err.message);
    }

    // Build response
    const responseHeaders: Record<string, string> = {};
    if (settlement?.success) {
      const responsePayload = {
        success: true,
        transaction: settlement.transaction,
        network: payment.network || payment.accepted?.network,
        facilitator: settlement.facilitator,
      };
      responseHeaders[PAYMENT_RESPONSE_HEADER] = Buffer.from(
        JSON.stringify(responsePayload)
      ).toString('base64');
    }

    this.sendJson(res, 200, {
      success: true,
      result,
      payment: settlement?.success 
        ? { transaction: settlement.transaction, status: 'settled', facilitator: settlement.facilitator }
        : { status: 'pending' },
    }, responseHeaders);
  }

  /**
   * Return 402 with x402 payment requirements (v2 format)
   */
  private sendPaymentRequired(config: ServiceConfig, res: ServerResponse): void {
    const requirements = this.buildPaymentRequirements(config);

    const paymentRequired = {
      x402Version: X402_VERSION,
      accepts: [requirements],
      resource: {
        url: `/execute?service=${config.id}`,
        description: `${config.name} - $${config.price} ${config.currency}`,
        mimeType: 'application/json',
      },
    };

    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

    res.writeHead(402, {
      'Content-Type': 'application/json',
      [PAYMENT_REQUIRED_HEADER]: encoded,
    });
    res.end(JSON.stringify({
      error: 'Payment required',
      message: `Service requires $${config.price} ${config.currency}`,
      x402: paymentRequired,
    }, null, 2));
  }

  /**
   * Basic payment validation
   */
  private validatePayment(
    payment: X402PaymentPayload,
    config: ServiceConfig
  ): { valid: boolean; error?: string } {
    if (payment.x402Version !== X402_VERSION) {
      return { valid: false, error: `Unsupported x402 version: ${payment.x402Version}` };
    }

    const scheme = payment.accepted?.scheme || payment.scheme;
    const network = payment.accepted?.network || payment.network;

    if (scheme !== 'exact') {
      return { valid: false, error: `Unsupported scheme: ${scheme}` };
    }

    if (network !== this.networkId) {
      return { valid: false, error: `Network mismatch: expected ${this.networkId}, got ${network}` };
    }

    return { valid: true };
  }

  /**
   * Build payment requirements for facilitator
   */
  private buildPaymentRequirements(config: ServiceConfig): X402PaymentRequirements {
    const amountInUnits = Math.floor(config.price * 1e6).toString();
    const usdcAddress = USDC_ADDRESSES[this.networkId];

    return {
      scheme: 'exact',
      network: this.networkId,
      asset: usdcAddress,
      amount: amountInUnits,
      payTo: this.manifest.provider.wallet,
      maxTimeoutSeconds: 300,
      extra: USDC_DOMAIN,
    };
  }

  private async readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  private sendJson(
    res: ServerResponse, 
    status: number, 
    data: any,
    extraHeaders?: Record<string, string>
  ): void {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (extraHeaders) {
      Object.assign(headers, extraHeaders);
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(data, null, 2));
  }
}
