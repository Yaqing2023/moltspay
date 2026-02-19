/**
 * MoltsPay Server - Payment infrastructure for AI Agents
 * 
 * Uses x402 protocol with public facilitator (https://x402.org/facilitator).
 * Server does NOT need private key - facilitator handles on-chain settlement.
 * 
 * Usage:
 *   const server = new MoltsPayServer('./moltspay.services.json');
 *   server.skill('text-to-video', async (params) => { ... });
 *   server.listen(3000);
 */

import { readFileSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { getChain } from '../chains/index.js';
import type { ChainName } from '../chains/index.js';
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

// Default facilitator URL
const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';

interface X402PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: any;
}

export class MoltsPayServer {
  private manifest: ServicesManifest;
  private skills: Map<string, RegisteredSkill> = new Map();
  private options: MoltsPayServerOptions;
  private facilitatorUrl: string;

  constructor(servicesPath: string, options: MoltsPayServerOptions = {}) {
    // Load services manifest
    const content = readFileSync(servicesPath, 'utf-8');
    this.manifest = JSON.parse(content) as ServicesManifest;
    
    this.options = {
      port: options.port || 3000,
      host: options.host || '0.0.0.0',
    };

    this.facilitatorUrl = options.facilitatorUrl || DEFAULT_FACILITATOR_URL;

    console.log(`[MoltsPay] Loaded ${this.manifest.services.length} services from ${servicesPath}`);
    console.log(`[MoltsPay] Provider: ${this.manifest.provider.name}`);
    console.log(`[MoltsPay] Receive wallet: ${this.manifest.provider.wallet}`);
    console.log(`[MoltsPay] Facilitator: ${this.facilitatorUrl}`);
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
    this.skills.set(serviceId, { config, handler });
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
    const chain = getChain(this.manifest.provider.chain as ChainName);
    
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

    this.sendJson(res, 200, {
      provider: this.manifest.provider,
      services,
      x402: {
        version: X402_VERSION,
        network: `eip155:${chain.chainId}`,
        schemes: ['exact'],
        facilitator: this.facilitatorUrl,
      },
    });
  }

  /**
   * POST /execute - Execute service with x402 payment
   * Body: { service: string, params: object }
   * Header: X-Payment (optional - if missing, returns 402)
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

    // Verify payment with facilitator
    console.log(`[MoltsPay] Verifying payment with facilitator...`);
    const verifyResult = await this.verifyWithFacilitator(payment, skill.config);
    if (!verifyResult.valid) {
      return this.sendJson(res, 402, { error: `Payment verification failed: ${verifyResult.error}` });
    }

    // Execute skill FIRST (pay-for-success)
    console.log(`[MoltsPay] Executing skill: ${service}`);
    let result: any;
    try {
      result = await skill.handler(params || {});
    } catch (err: any) {
      console.error('[MoltsPay] Skill execution failed:', err.message);
      // Don't settle payment if skill fails
      return this.sendJson(res, 500, {
        error: 'Service execution failed',
        message: err.message,
      });
    }

    // Skill succeeded - now settle payment with facilitator
    console.log(`[MoltsPay] Skill succeeded, settling payment...`);
    let settlement: any = null;
    try {
      settlement = await this.settleWithFacilitator(payment, skill.config);
      console.log(`[MoltsPay] Payment settled: ${settlement.transaction || 'pending'}`);
    } catch (err: any) {
      console.error('[MoltsPay] Settlement failed:', err.message);
      // Still return result - facilitator may settle later
    }

    // Build response with settlement info
    const responseHeaders: Record<string, string> = {};
    if (settlement) {
      const responsePayload = {
        success: true,
        transaction: settlement.transaction,
        network: payment.network,
      };
      responseHeaders[PAYMENT_RESPONSE_HEADER] = Buffer.from(
        JSON.stringify(responsePayload)
      ).toString('base64');
    }

    this.sendJson(res, 200, {
      success: true,
      result,
      payment: settlement 
        ? { transaction: settlement.transaction, status: 'settled' }
        : { status: 'pending' },
    }, responseHeaders);
  }

  /**
   * Return 402 with x402 payment requirements
   */
  private sendPaymentRequired(config: ServiceConfig, res: ServerResponse): void {
    const chain = getChain(this.manifest.provider.chain as ChainName);
    const amountInUnits = Math.floor(config.price * 1e6).toString();

    const requirements = [{
      scheme: 'exact',
      network: `eip155:${chain.chainId}`,
      maxAmountRequired: amountInUnits,
      resource: this.manifest.provider.wallet,
      description: `${config.name} - $${config.price} ${config.currency}`,
      // Include facilitator info for client
      extra: JSON.stringify({ facilitator: this.facilitatorUrl }),
    }];

    const encoded = Buffer.from(JSON.stringify(requirements)).toString('base64');

    res.writeHead(402, {
      'Content-Type': 'application/json',
      [PAYMENT_REQUIRED_HEADER]: encoded,
    });
    res.end(JSON.stringify({
      error: 'Payment required',
      message: `Service requires $${config.price} ${config.currency}`,
      x402: requirements[0],
    }, null, 2));
  }

  /**
   * Basic payment validation (before calling facilitator)
   */
  private validatePayment(
    payment: X402PaymentPayload,
    config: ServiceConfig
  ): { valid: boolean; error?: string } {
    if (payment.x402Version !== X402_VERSION) {
      return { valid: false, error: `Unsupported x402 version: ${payment.x402Version}` };
    }

    if (payment.scheme !== 'exact') {
      return { valid: false, error: `Unsupported scheme: ${payment.scheme}` };
    }

    const chain = getChain(this.manifest.provider.chain as ChainName);
    const expectedNetwork = `eip155:${chain.chainId}`;
    if (payment.network !== expectedNetwork) {
      return { valid: false, error: `Network mismatch: expected ${expectedNetwork}` };
    }

    return { valid: true };
  }

  /**
   * Verify payment with facilitator
   */
  private async verifyWithFacilitator(
    payment: X402PaymentPayload,
    config: ServiceConfig
  ): Promise<{ valid: boolean; error?: string }> {
    try {
      const chain = getChain(this.manifest.provider.chain as ChainName);
      const amountInUnits = Math.floor(config.price * 1e6).toString();

      const requirements = {
        scheme: 'exact',
        network: `eip155:${chain.chainId}`,
        maxAmountRequired: amountInUnits,
        resource: this.manifest.provider.wallet,
      };

      const response = await fetch(`${this.facilitatorUrl}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentPayload: payment,
          paymentRequirements: requirements,
        }),
      });

      const result = await response.json() as any;

      if (!response.ok || !result.isValid) {
        return { valid: false, error: result.invalidReason || 'Verification failed' };
      }

      return { valid: true };
    } catch (err: any) {
      return { valid: false, error: `Facilitator error: ${err.message}` };
    }
  }

  /**
   * Settle payment with facilitator (execute on-chain transfer)
   */
  private async settleWithFacilitator(
    payment: X402PaymentPayload,
    config: ServiceConfig
  ): Promise<{ transaction?: string; status: string }> {
    const chain = getChain(this.manifest.provider.chain as ChainName);
    const amountInUnits = Math.floor(config.price * 1e6).toString();

    const requirements = {
      scheme: 'exact',
      network: `eip155:${chain.chainId}`,
      maxAmountRequired: amountInUnits,
      resource: this.manifest.provider.wallet,
    };

    const response = await fetch(`${this.facilitatorUrl}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentPayload: payment,
        paymentRequirements: requirements,
      }),
    });

    const result = await response.json() as any;

    if (!response.ok) {
      throw new Error(result.error || 'Settlement failed');
    }

    return {
      transaction: result.transaction,
      status: result.status || 'settled',
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
