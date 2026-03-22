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

// MPP (Machine Payments Protocol) constants
const MPP_AUTH_HEADER = 'authorization';
const MPP_WWW_AUTH_HEADER = 'www-authenticate';
const MPP_RECEIPT_HEADER = 'payment-receipt';

// Token contract addresses by network
const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  'eip155:8453': {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  },
  'eip155:84532': {
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    USDT: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Same as USDC on testnet
  },
  'eip155:137': {
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
  'eip155:42431': {
    // Tempo Moderato testnet - TIP-20 stablecoins
    USDC: '0x20c0000000000000000000000000000000000000', // pathUSD
    USDT: '0x20c0000000000000000000000000000000000001', // alphaUSD
  },
  // Solana networks use mint addresses (SPL tokens)
  'solana:mainnet': {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Circle USDC
  },
  'solana:devnet': {
    USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Devnet USDC
  },
};

// Chain name to network ID mapping
const CHAIN_TO_NETWORK: Record<string, string> = {
  'base': 'eip155:8453',
  'base_sepolia': 'eip155:84532',
  'polygon': 'eip155:137',
  'tempo_moderato': 'eip155:42431',
  'bnb': 'eip155:56',
  'bnb_testnet': 'eip155:97',
  'solana': 'solana:mainnet',
  'solana_devnet': 'solana:devnet',
};

// Helper to check if a network is Solana
function isSolanaNetwork(network: string): boolean {
  return network.startsWith('solana:');
}

// EIP-712 domain info for tokens (per network)
// Different networks may have different domain names for the same token
const TOKEN_DOMAINS: Record<string, Record<string, { name: string; version: string }>> = {
  // Base mainnet
  'eip155:8453': {
    USDC: { name: 'USD Coin', version: '2' },
    USDT: { name: 'Tether USD', version: '2' },
  },
  // Base Sepolia testnet - USDC uses 'USDC' not 'USD Coin'
  'eip155:84532': {
    USDC: { name: 'USDC', version: '2' },
    USDT: { name: 'USDC', version: '2' }, // Same contract as USDC on testnet
  },
  // Polygon mainnet
  'eip155:137': {
    USDC: { name: 'USD Coin', version: '2' },
    USDT: { name: '(PoS) Tether USD', version: '2' },
  },
  // Tempo Moderato testnet - TIP-20 stablecoins
  'eip155:42431': {
    USDC: { name: 'pathUSD', version: '1' },
    USDT: { name: 'alphaUSD', version: '1' },
  },
  // BNB Smart Chain mainnet
  'eip155:56': {
    USDC: { name: 'USD Coin', version: '1' },
    USDT: { name: 'Tether USD', version: '1' },
  },
  // BNB Smart Chain testnet
  'eip155:97': {
    USDC: { name: 'USD Coin', version: '1' },
    USDT: { name: 'Tether USD', version: '1' },
  },
};

// Helper to get token domain for a network
function getTokenDomain(network: string, token: string): { name: string; version: string } {
  const networkDomains = TOKEN_DOMAINS[network] || TOKEN_DOMAINS['eip155:8453']; // fallback to base mainnet
  return networkDomains[token] || { name: 'USD Coin', version: '2' };
}

// Helper to get accepted currencies with backward compatibility
function getAcceptedCurrencies(config: ServiceConfig): string[] {
  return config.acceptedCurrencies ?? [config.currency];
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

    // Determine default network from env (fallback only)
    // NOTE: Chain is auto-detected from client payment header (payment.network)
    // USE_MAINNET is only used as fallback when payment header omits network
    // Recommended: configure "chains" array in manifest instead
    this.useMainnet = process.env.USE_MAINNET?.toLowerCase() === 'true';
    this.networkId = this.useMainnet ? 'eip155:8453' : 'eip155:84532';

    // Create facilitator registry with config (env vars take precedence)
    // Always include 'tempo', 'bnb', and 'solana' in fallback for multi-chain support
    const defaultFallback = ['tempo', 'bnb', 'solana'];
    const envFallback = process.env.FACILITATOR_FALLBACK?.split(',').filter(Boolean);
    const facilitatorConfig: FacilitatorSelection = options.facilitators || {
      primary: process.env.FACILITATOR_PRIMARY || 'cdp',
      fallback: envFallback || defaultFallback,
      strategy: (process.env.FACILITATOR_STRATEGY as any) || 'failover',
      config: {
        cdp: { useMainnet: this.useMainnet },
      },
    };
    this.registry = new FacilitatorRegistry(facilitatorConfig);

    // Get primary facilitator for logging
    const primaryFacilitator = this.registry.get(facilitatorConfig.primary);
    
    console.log(`[MoltsPay] Loaded ${this.manifest.services.length} services from ${servicesPath}`);
    console.log(`[MoltsPay] Provider: ${this.manifest.provider.name}`);
    console.log(`[MoltsPay] Receive wallet: ${this.manifest.provider.wallet}`);
    
    // Log configured chains
    const chains = this.manifest.provider.chains;
    if (chains && chains.length > 0) {
      const chainNames = chains.map(c => c.chain || c.network).join(', ');
      console.log(`[MoltsPay] Chains: ${chainNames} (multi-chain enabled)`);
    } else {
      const networkName = this.useMainnet ? 'Base mainnet' : 'Base Sepolia (testnet)';
      console.log(`[MoltsPay] Network: ${this.networkId} (${networkName})`);
    }
    
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
   * Get all configured chains for this provider
   * Returns array of { network, wallet, tokens } for each chain
   */
  private getProviderChains(): Array<{ network: string; wallet: string; tokens: string[] }> {
    const provider = this.manifest.provider;
    
    // Helper to get the right wallet for a chain
    const getWalletForChain = (chainName: string, explicitWallet?: string): string => {
      // If explicit wallet provided (object format), use it
      if (explicitWallet) return explicitWallet;
      // For Solana chains, use solana_wallet if available
      if ((chainName === 'solana' || chainName === 'solana_devnet') && provider.solana_wallet) {
        return provider.solana_wallet;
      }
      // Default to EVM wallet
      return provider.wallet;
    };
    
    // If chains array is defined, use it
    // Supports both string array ["base", "polygon"] and object array [{chain, wallet, tokens}]
    if (provider.chains && provider.chains.length > 0) {
      return provider.chains.map(c => {
        const chainName = typeof c === 'string' ? c : c.chain;
        const explicitWallet = typeof c === 'object' ? c.wallet : null;
        return {
          network: CHAIN_TO_NETWORK[chainName] || 'eip155:8453',
          wallet: getWalletForChain(chainName, explicitWallet || undefined),
          tokens: (typeof c === 'object' ? c.tokens : null) || ['USDC'],
        };
      });
    }
    
    // Fallback to single chain (backward compat)
    const chain = provider.chain || 'base';
    const network = CHAIN_TO_NETWORK[chain] || this.networkId;
    return [{
      network,
      wallet: getWalletForChain(chain),
      tokens: ['USDC'],
    }];
  }

  /**
   * Get wallet address for a specific network
   */
  private getWalletForNetwork(network: string): string {
    const chains = this.getProviderChains();
    const chain = chains.find(c => c.network === network);
    return chain?.wallet || this.manifest.provider.wallet;
  }

  /**
   * Check if a network is accepted by this provider
   */
  private isNetworkAccepted(network: string): boolean {
    const chains = this.getProviderChains();
    return chains.some(c => c.network === network);
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
      console.log(`  POST /proxy        - Proxy payment for external services`);
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'X-Payment-Required, X-Payment-Response, WWW-Authenticate, Payment-Receipt');

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

      // Standard discovery endpoint
      if (url.pathname === '/.well-known/agent-services.json' && req.method === 'GET') {
        return this.handleAgentServicesDiscovery(res);
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return await this.handleHealthCheck(res);
      }

      if (url.pathname === '/execute' && req.method === 'POST') {
        const body = await this.readBody(req);
        const paymentHeader = req.headers[PAYMENT_HEADER] as string | undefined;
        return await this.handleExecute(body, paymentHeader, res);
      }

      if (url.pathname === '/proxy' && req.method === 'POST') {
        // Check IP whitelist
        const clientIP = (req.headers['x-real-ip'] as string) || 
                         (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                         req.socket.remoteAddress || '';
        if (!this.isProxyAllowed(clientIP)) {
          return this.sendJson(res, 403, { error: 'Forbidden: IP not allowed' });
        }
        const body = await this.readBody(req);
        const paymentHeader = req.headers[PAYMENT_HEADER] as string | undefined;
        const authHeader = req.headers[MPP_AUTH_HEADER] as string | undefined;
        return await this.handleProxy(body, paymentHeader, authHeader, res);
      }

      // MPP Protocol: Handle service-specific endpoints like /text-to-video, /ping
      // Check if URL matches a registered service ID
      const servicePath = url.pathname.replace(/^\//, ''); // Remove leading slash
      const skill = this.skills.get(servicePath);
      if (skill && (req.method === 'POST' || req.method === 'GET')) {
        const body = req.method === 'POST' ? await this.readBody(req) : {};
        const authHeader = req.headers[MPP_AUTH_HEADER] as string | undefined;
        const x402Header = req.headers[PAYMENT_HEADER] as string | undefined;
        return await this.handleMPPRequest(skill, body, authHeader, x402Header, res);
      }

      // Not found
      this.sendJson(res, 404, { error: 'Not found' });
    } catch (err: any) {
      console.error('[MoltsPay] Error:', err);
      this.sendJson(res, 500, { error: err.message || 'Internal error' });
    }
  }

  /**
   * GET /.well-known/agent-services.json - Standard discovery endpoint
   */
  private handleAgentServicesDiscovery(res: ServerResponse): void {
    const services = this.manifest.services.map(s => ({
      id: s.id,
      name: s.name,
      description: s.description,
      price: s.price,
      currency: s.currency,
      acceptedCurrencies: getAcceptedCurrencies(s),
      input: s.input,
      output: s.output,
      available: this.skills.has(s.id),
    }));

    this.sendJson(res, 200, {
      version: '1.0',
      provider: {
        name: this.manifest.provider.name,
        description: this.manifest.provider.description,
        wallet: this.manifest.provider.wallet,
        chain: this.manifest.provider.chain || 'base',
        solana_wallet: this.manifest.provider.solana_wallet,
        chains: this.manifest.provider.chains,
      },
      services,
      endpoints: {
        services: '/services',
        execute: '/execute',
        health: '/health',
      },
      payment: {
        protocol: 'x402',
        version: X402_VERSION,
        network: this.networkId,
        schemes: ['exact'],
        mainnet: this.useMainnet,
      },
    });
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
      acceptedCurrencies: getAcceptedCurrencies(s),
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

    // Detect which token is being used
    const paymentToken = this.detectPaymentToken(payment);
    if (paymentToken && !this.isTokenAccepted(skill.config, paymentToken)) {
      const accepted = getAcceptedCurrencies(skill.config);
      return this.sendJson(res, 402, { 
        error: `Token ${paymentToken} not accepted. Accepted: ${accepted.join(', ')}` 
      });
    }

    // Auto-detect chain from payment header (key insight: client specifies chain via --chain flag)
    // payment.network contains "eip155:8453" (base) or "eip155:84532" (base_sepolia) etc.
    // This allows provider to serve both mainnet and testnet without separate configuration
    const paymentNetwork = payment.accepted?.network || payment.network || this.networkId;
    const paymentWallet = this.getWalletForNetwork(paymentNetwork);

    // Build requirements for facilitator using the detected token and network
    const requirements = this.buildPaymentRequirements(skill.config, paymentNetwork, paymentWallet, paymentToken);

    // Verify payment with facilitator (via registry)
    console.log(`[MoltsPay] Verifying payment on ${paymentNetwork}...`);
    const verifyResult = await this.registry.verify(payment, requirements);
    if (!verifyResult.valid) {
      return this.sendJson(res, 402, { 
        error: `Payment verification failed: ${verifyResult.error}`,
        facilitator: verifyResult.facilitator,
      });
    }
    console.log(`[MoltsPay] Verified by ${verifyResult.facilitator}`);

    // For Solana: settle FIRST (blockhash expires quickly ~60s)
    // For EVM: pay-for-success (execute first, settle after)
    const isSolana = isSolanaNetwork(paymentNetwork);
    let settlement: any = null;

    if (isSolana) {
      console.log(`[MoltsPay] Solana detected - settling payment FIRST (blockhash expiry protection)`);
      try {
        settlement = await this.registry.settle(payment, requirements);
        console.log(`[MoltsPay] Payment settled by ${settlement.facilitator}: ${settlement.transaction || 'pending'}`);
      } catch (err: any) {
        console.error('[MoltsPay] Solana settlement failed:', err.message);
        return this.sendJson(res, 402, {
          error: 'Payment settlement failed',
          message: err.message,
        });
      }
    }

    // Execute skill (with timeout)
    const timeoutSeconds = parseInt(process.env.SKILL_TIMEOUT_SECONDS || '1200');
    console.log(`[MoltsPay] Executing skill: ${service} (timeout: ${timeoutSeconds}s)`);
    let result: any;
    try {
      result = await Promise.race([
        skill.handler(params || {}),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Skill timeout after ${timeoutSeconds}s`)), timeoutSeconds * 1000)
        )
      ]);
    } catch (err: any) {
      console.error('[MoltsPay] Skill execution failed:', err.message);
      // For Solana: payment already settled, skill failed - no refund (user accepted risk)
      // For EVM: payment not settled yet, user keeps their money
      return this.sendJson(res, 500, {
        error: 'Service execution failed',
        message: err.message,
        paymentSettled: isSolana ? true : false,
        note: isSolana ? 'Payment was settled before execution. Contact support for refund.' : undefined,
      });
    }

    // For EVM: settle payment now (pay-for-success)
    if (!isSolana) {
      console.log(`[MoltsPay] Skill succeeded, settling payment...`);
      try {
        settlement = await this.registry.settle(payment, requirements);
        console.log(`[MoltsPay] Payment settled by ${settlement.facilitator}: ${settlement.transaction || 'pending'}`);
      } catch (err: any) {
        console.error('[MoltsPay] Settlement failed:', err.message);
      }
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
   * Handle MPP (Machine Payments Protocol) request
   * Supports both x402 and MPP protocols on service endpoints
   */
  private async handleMPPRequest(
    skill: RegisteredSkill,
    body: any,
    authHeader: string | undefined,
    x402Header: string | undefined,
    res: ServerResponse
  ): Promise<void> {
    const config = skill.config;
    const params = body || {};

    // Check for x402 payment header first (backward compatibility)
    if (x402Header) {
      return await this.handleExecute({ service: config.id, params }, x402Header, res);
    }

    // Check for MPP payment credential
    if (authHeader && authHeader.toLowerCase().startsWith('payment ')) {
      return await this.handleMPPPayment(skill, params, authHeader, res);
    }

    // No payment provided - return 402 with both x402 and MPP headers
    return this.sendMPPPaymentRequired(config, res);
  }

  /**
   * Handle MPP payment verification and service execution
   */
  private async handleMPPPayment(
    skill: RegisteredSkill,
    params: any,
    authHeader: string,
    res: ServerResponse
  ): Promise<void> {
    const config = skill.config;

    // Parse MPP credential: "Payment <base64>"
    const credentialMatch = authHeader.match(/Payment\s+(.+)/i);
    if (!credentialMatch) {
      return this.sendJson(res, 400, { error: 'Invalid Authorization header format' });
    }

    let mppCredential: {
      challenge: {
        id: string;
        realm: string;
        method: string;
        intent: string;
        request: any;
      };
      payload: {
        hash?: string;
        signature?: string;
        type: 'hash' | 'transaction';
      };
      source?: string;
    };
    
    try {
      // mppx uses base64url encoding without padding
      const base64 = credentialMatch[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      mppCredential = JSON.parse(decoded);
    } catch (err) {
      console.error('[MoltsPay] Failed to parse MPP credential:', err);
      return this.sendJson(res, 400, { error: 'Invalid payment credential encoding' });
    }

    // Extract transaction hash from payload
    let txHash: string | undefined;
    if (mppCredential.payload?.type === 'hash' && mppCredential.payload?.hash) {
      txHash = mppCredential.payload.hash;
    } else if (mppCredential.payload?.type === 'transaction') {
      // For 'transaction' type, server would need to submit the signed tx
      // For now, we only support 'hash' type (push mode)
      return this.sendJson(res, 400, { 
        error: 'Transaction type not supported. Please use push mode (hash type).' 
      });
    }

    if (!txHash) {
      return this.sendJson(res, 400, { error: 'Missing transaction hash in credential' });
    }

    // Extract chainId from challenge or source
    let chainId = mppCredential.challenge?.request?.methodDetails?.chainId;
    if (!chainId && mppCredential.source) {
      const chainMatch = mppCredential.source.match(/eip155:(\d+)/);
      if (chainMatch) chainId = parseInt(chainMatch[1], 10);
    }
    chainId = chainId || 42431; // Default to Tempo Moderato

    // Determine network from chainId
    const network = `eip155:${chainId}`;

    if (!this.isNetworkAccepted(network)) {
      return this.sendJson(res, 402, { 
        error: `Network not accepted: ${network}` 
      });
    }

    // Build requirements for verification
    const requirements = this.buildPaymentRequirements(
      config,
      network,
      this.getWalletForNetwork(network),
      'USDC'
    );

    // Create x402-compatible payload for facilitator
    const paymentPayload: X402PaymentPayload = {
      x402Version: X402_VERSION,
      scheme: 'exact',
      network,
      payload: {
        txHash,
        chainId,
      },
    };

    console.log(`[MoltsPay] Verifying MPP payment: txHash=${txHash}, chainId=${chainId}`);

    // Verify payment using facilitator registry
    const verification = await this.registry.verify(paymentPayload, requirements);
    
    if (!verification.valid) {
      return this.sendJson(res, 402, { 
        error: `Payment verification failed: ${verification.error}` 
      });
    }

    console.log(`[MoltsPay] Payment verified! Executing service: ${config.id}`);

    // Execute the skill
    let result: any;
    try {
      result = await skill.handler(params);
    } catch (err: any) {
      console.error(`[MoltsPay] Skill execution error:`, err);
      return this.sendJson(res, 500, { 
        error: `Service execution failed: ${err.message}` 
      });
    }

    // Build receipt
    const receipt = {
      success: true,
      txHash,
      network,
      facilitator: verification.facilitator,
    };
    const receiptEncoded = Buffer.from(JSON.stringify(receipt)).toString('base64');

    // Return success with MPP receipt header
    res.writeHead(200, {
      'Content-Type': 'application/json',
      [MPP_RECEIPT_HEADER]: receiptEncoded,
    });
    res.end(JSON.stringify({
      success: true,
      result,
      payment: {
        txHash,
        status: 'verified',
        facilitator: verification.facilitator,
      },
    }, null, 2));
  }

  /**
   * Return 402 with both x402 and MPP payment requirements
   */
  private sendMPPPaymentRequired(config: ServiceConfig, res: ServerResponse): void {
    const acceptedTokens = getAcceptedCurrencies(config);
    const providerChains = this.getProviderChains();
    
    // === x402 format (existing) ===
    const accepts: X402PaymentRequirements[] = [];
    for (const chainConfig of providerChains) {
      for (const token of acceptedTokens) {
        if (chainConfig.tokens.includes(token)) {
          accepts.push(this.buildPaymentRequirements(config, chainConfig.network, chainConfig.wallet, token));
        }
      }
    }

    const x402PaymentRequired = {
      x402Version: X402_VERSION,
      accepts,
      acceptedCurrencies: acceptedTokens,
      resource: {
        url: `/${config.id}`,
        description: `${config.name} - $${config.price} ${config.currency}`,
      },
    };
    const x402Encoded = Buffer.from(JSON.stringify(x402PaymentRequired)).toString('base64');

    // === MPP format ===
    // Find Tempo chain if available
    const tempoChain = providerChains.find(c => c.network === 'eip155:42431');
    
    let mppWwwAuth = '';
    if (tempoChain) {
      const challengeId = this.generateChallengeId();
      const amountInUnits = Math.floor(config.price * 1e6).toString();
      const tokenAddress = TOKEN_ADDRESSES['eip155:42431']?.USDC || '0x20c0000000000000000000000000000000000000';
      
      const mppRequest = {
        amount: amountInUnits,
        currency: tokenAddress,
        methodDetails: {
          chainId: 42431,
          feePayer: true,
        },
        recipient: tempoChain.wallet,
      };
      const mppRequestEncoded = Buffer.from(JSON.stringify(mppRequest)).toString('base64');
      
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      
      mppWwwAuth = `Payment id="${challengeId}", realm="${this.manifest.provider.name}", method="tempo", intent="charge", request="${mppRequestEncoded}", description="${config.name}", expires="${expiresAt}"`;
    }

    // Build response headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/problem+json',
      [PAYMENT_REQUIRED_HEADER]: x402Encoded,
    };
    
    if (mppWwwAuth) {
      headers[MPP_WWW_AUTH_HEADER] = mppWwwAuth;
    }

    res.writeHead(402, headers);
    res.end(JSON.stringify({
      type: 'https://paymentauth.org/problems/payment-required',
      title: 'Payment Required',
      status: 402,
      detail: `Payment is required (${config.name}).`,
      service: config.id,
      price: config.price,
      currency: config.currency,
      acceptedCurrencies: acceptedTokens,
    }, null, 2));
  }

  /**
   * Generate a unique challenge ID for MPP
   */
  private generateChallengeId(): string {
    const bytes = new Uint8Array(24);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
    return Buffer.from(bytes).toString('base64url');
  }

  /**
   * Return 402 with x402 payment requirements (v2 format)
   * Includes requirements for all chains and all accepted currencies
   */
  private sendPaymentRequired(config: ServiceConfig, res: ServerResponse): void {
    const acceptedTokens = getAcceptedCurrencies(config);
    const providerChains = this.getProviderChains();
    
    // Build requirements for each chain x token combination
    const accepts: X402PaymentRequirements[] = [];
    for (const chainConfig of providerChains) {
      for (const token of acceptedTokens) {
        // Only add if this chain supports this token
        if (chainConfig.tokens.includes(token)) {
          accepts.push(this.buildPaymentRequirements(config, chainConfig.network, chainConfig.wallet, token));
        }
      }
    }

    // Get list of accepted chains for response
    const acceptedChains = providerChains.map(c => {
      // Convert network ID to chain name for readability
      if (c.network === 'eip155:8453') return 'base';
      if (c.network === 'eip155:137') return 'polygon';
      return c.network;
    });

    const paymentRequired = {
      x402Version: X402_VERSION,
      accepts,
      acceptedCurrencies: acceptedTokens,
      acceptedChains,
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
      acceptedCurrencies: acceptedTokens,
      acceptedChains,
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
    const network = payment.accepted?.network || payment.network || this.networkId;

    if (scheme !== 'exact') {
      return { valid: false, error: `Unsupported scheme: ${scheme}` };
    }

    // Check if payment network is one of our accepted networks
    if (!this.isNetworkAccepted(network)) {
      const acceptedChains = this.getProviderChains().map(c => c.network).join(', ');
      return { valid: false, error: `Network not accepted: ${network}. Accepted: ${acceptedChains}` };
    }

    return { valid: true };
  }

  /**
   * Build payment requirements for facilitator
   * Now supports multi-chain: takes network and wallet as parameters
   */
  private buildPaymentRequirements(
    config: ServiceConfig, 
    network?: string, 
    wallet?: string,
    token?: string
  ): X402PaymentRequirements {
    const amountInUnits = Math.floor(config.price * 1e6).toString();
    const acceptedTokens = getAcceptedCurrencies(config);
    
    // Use specified values or defaults
    const selectedNetwork = network || this.networkId;
    const selectedWallet = wallet || this.manifest.provider.wallet;
    const selectedToken = token && acceptedTokens.includes(token) ? token : acceptedTokens[0];
    
    const tokenAddresses = TOKEN_ADDRESSES[selectedNetwork] || {};
    const tokenAddress = tokenAddresses[selectedToken];
    const tokenDomain = getTokenDomain(selectedNetwork, selectedToken);

    const requirements: X402PaymentRequirements = {
      scheme: 'exact',
      network: selectedNetwork,
      asset: tokenAddress,
      amount: amountInUnits,
      payTo: selectedWallet,
      maxTimeoutSeconds: 300,
      extra: tokenDomain,
    };
    
    // For Solana: include fee payer pubkey if available (gasless mode)
    if (selectedNetwork === 'solana:mainnet' || selectedNetwork === 'solana:devnet') {
      const solanaFacilitator = this.registry.get('solana') as any;
      const feePayerPubkey = solanaFacilitator?.getFeePayerPubkey?.();
      if (feePayerPubkey) {
        (requirements.extra as any) = {
          ...(requirements.extra || {}),
          solanaFeePayer: feePayerPubkey,
        };
      }
    }
    
    // For BNB: include spender address for client approval
    if (selectedNetwork === 'eip155:56' || selectedNetwork === 'eip155:97') {
      const bnbFacilitator = this.registry.get('bnb') as any;
      const spenderAddress = bnbFacilitator?.getSpenderAddress?.();
      if (spenderAddress) {
        (requirements.extra as any) = {
          ...(requirements.extra || {}),
          bnbSpender: spenderAddress,
        };
      }
    }
    
    return requirements;
  }

  /**
   * Detect which token is being used in the payment
   * Checks across all supported networks
   */
  private detectPaymentToken(payment: X402PaymentPayload): string | undefined {
    const asset = payment.accepted?.asset || (payment.payload as any)?.asset;
    if (!asset) return undefined;

    // Get payment network to check correct token addresses
    const paymentNetwork = payment.accepted?.network || payment.network || this.networkId;
    const tokenAddresses = TOKEN_ADDRESSES[paymentNetwork] || {};
    
    for (const [symbol, address] of Object.entries(tokenAddresses)) {
      if (address && (address as string).toLowerCase() === asset.toLowerCase()) {
        return symbol;
      }
    }
    return undefined;
  }

  /**
   * Check if payment token is accepted for service
   */
  private isTokenAccepted(config: ServiceConfig, token: string): boolean {
    const accepted = getAcceptedCurrencies(config);
    return accepted.includes(token);
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

  /**
   * Check if IP is allowed for /proxy endpoint
   */
  private isProxyAllowed(clientIP: string): boolean {
    const allowedIPs = process.env.PROXY_ALLOWED_IPS?.split(',').map(ip => ip.trim()) || [];
    
    // If no whitelist configured, deny all (secure by default)
    if (allowedIPs.length === 0) {
      console.log(`[MoltsPay] /proxy denied: no PROXY_ALLOWED_IPS configured`);
      return false;
    }
    
    // Normalize IPv6 localhost
    const normalizedIP = clientIP === '::1' ? '127.0.0.1' : clientIP.replace('::ffff:', '');
    
    const allowed = allowedIPs.includes(normalizedIP) || allowedIPs.includes(clientIP);
    if (!allowed) {
      console.log(`[MoltsPay] /proxy denied for IP: ${clientIP} (normalized: ${normalizedIP})`);
    }
    return allowed;
  }

  /**
   * POST /proxy - Handle payment for external services (moltspay-creators)
   * 
   * This endpoint allows other services to delegate x402/MPP payment handling.
   * It does NOT execute any skill - just handles payment verification/settlement.
   * 
   * Request body:
   *   { wallet, amount, currency, chain, memo, serviceId, description }
   * 
   * For x402 (base, polygon, base_sepolia):
   *   Without X-Payment header: returns 402 with X-Payment-Required
   *   With X-Payment header: verifies payment via CDP
   * 
   * For MPP (tempo_moderato):
   *   Without Authorization header: returns 402 with WWW-Authenticate
   *   With Authorization: Payment header: verifies tx on Tempo chain
   */
  private async handleProxy(
    body: any,
    paymentHeader: string | undefined,
    authHeader: string | undefined,
    res: ServerResponse
  ): Promise<void> {
    const { wallet, amount, currency, chain, memo, serviceId, description } = body;

    // Validate required fields
    if (!wallet || !amount) {
      return this.sendJson(res, 400, { error: 'Missing required fields: wallet, amount' });
    }

    // Validate chain if provided
    const supportedChains = ['base', 'polygon', 'base_sepolia', 'tempo_moderato', 'bnb', 'bnb_testnet', 'solana', 'solana_devnet'];
    if (chain && !supportedChains.includes(chain)) {
      return this.sendJson(res, 400, { error: `Unsupported chain: ${chain}. Supported: ${supportedChains.join(', ')}` });
    }

    // Validate wallet format based on chain
    const isSolanaChain = chain === 'solana' || chain === 'solana_devnet';
    const isValidEvmAddress = /^0x[a-fA-F0-9]{40}$/.test(wallet);
    const isValidSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet);
    
    if (isSolanaChain && !isValidSolanaAddress) {
      return this.sendJson(res, 400, { error: 'Invalid Solana wallet address format' });
    }
    if (!isSolanaChain && !isValidEvmAddress) {
      return this.sendJson(res, 400, { error: 'Invalid EVM wallet address format' });
    }

    // Validate amount
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return this.sendJson(res, 400, { error: 'Invalid amount' });
    }

    // Build a synthetic service config for payment
    const proxyConfig: ServiceConfig = {
      id: serviceId || 'proxy',
      name: description || 'Proxy Payment',
      description: description || '',
      price: amountNum,
      currency: currency || 'USDC',
      function: '', // Not used
      input: {},
      output: {},
    };

    // ========== MPP Protocol for tempo_moderato ==========
    if (chain === 'tempo_moderato') {
      return await this.handleProxyMPP(body, proxyConfig, authHeader, res);
    }

    // ========== x402 Protocol for other chains ==========
    // Build payment requirements with the provided wallet and chain
    const requirements = this.buildProxyPaymentRequirements(proxyConfig, wallet, currency, chain);

    // If no payment header, return 402 with payment requirements
    if (!paymentHeader) {
      return this.sendProxyPaymentRequired(proxyConfig, wallet, memo, chain, res);
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
    if (payment.x402Version !== X402_VERSION) {
      return this.sendJson(res, 402, { error: `Unsupported x402 version: ${payment.x402Version}` });
    }

    const scheme = payment.accepted?.scheme || payment.scheme;
    const network = payment.accepted?.network || payment.network;

    if (scheme !== 'exact') {
      return this.sendJson(res, 402, { error: `Unsupported scheme: ${scheme}` });
    }

    // Validate network matches requested chain (or default to provider's network)
    const expectedNetwork = chain ? (CHAIN_TO_NETWORK[chain] || this.networkId) : this.networkId;
    if (network !== expectedNetwork) {
      return this.sendJson(res, 402, { error: `Network mismatch: expected ${expectedNetwork}, got ${network}` });
    }

    // Verify payment with facilitator
    console.log(`[MoltsPay] /proxy: Verifying payment for ${wallet}...`);
    const verifyResult = await this.registry.verify(payment, requirements);
    if (!verifyResult.valid) {
      return this.sendJson(res, 402, { 
        success: false,
        error: `Payment verification failed: ${verifyResult.error}`,
        facilitator: verifyResult.facilitator,
      });
    }
    console.log(`[MoltsPay] /proxy: Verified by ${verifyResult.facilitator}`);

    // Check if execution requested
    const { execute, service, params } = body;
    
    // If execute requested, handle skill + payment
    if (execute && service) {
      const skill = this.skills.get(service);
      if (!skill) {
        // Service not found - don't settle, return error
        console.log(`[MoltsPay] /proxy: Service not found: ${service} - NOT settling`);
        return this.sendJson(res, 404, {
          success: false,
          paymentSettled: false,
          error: `Service not found: ${service}`,
        });
      }

      // For Solana: settle FIRST (blockhash expires quickly ~60s)
      // For EVM: pay-for-success (execute first, settle after)
      const isSolana = isSolanaNetwork(network);
      let settlement: any = null;

      if (isSolana) {
        console.log(`[MoltsPay] /proxy: Solana detected - settling payment FIRST`);
        try {
          settlement = await this.registry.settle(payment, requirements);
          console.log(`[MoltsPay] /proxy: Payment settled by ${settlement.facilitator}: ${settlement.transaction || 'pending'}`);
          
          // Check if settlement actually succeeded (registry returns {success: false} on failure)
          if (!settlement.success) {
            console.error(`[MoltsPay] /proxy: Solana settlement failed: ${settlement.error}`);
            return this.sendJson(res, 402, {
              success: false,
              paymentSettled: false,
              error: `Payment settlement failed: ${settlement.error || 'Unknown error'}`,
            });
          }
        } catch (err: any) {
          console.error('[MoltsPay] /proxy: Solana settlement failed:', err.message);
          return this.sendJson(res, 402, {
            success: false,
            paymentSettled: false,
            error: `Payment settlement failed: ${err.message}`,
          });
        }
      } else {
        console.log(`[MoltsPay] /proxy: Executing skill first (pay on success): ${service}`);
      }

      // Execute skill (with timeout)
      const timeoutSeconds = parseInt(process.env.SKILL_TIMEOUT_SECONDS || '1200');
      let result: any;
      try {
        result = await Promise.race([
          skill.handler(params || {}),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Skill timeout after ${timeoutSeconds}s`)), timeoutSeconds * 1000)
          )
        ]);
        console.log(`[MoltsPay] /proxy: Skill succeeded`);
      } catch (err: any) {
        // Skill failed or timeout
        console.error(`[MoltsPay] /proxy: Skill failed: ${err.message}`);
        // For Solana: payment already settled, skill failed - no refund (user accepted risk)
        // For EVM: payment not settled yet, user keeps their money
        return this.sendJson(res, 500, {
          success: false,
          paymentSettled: isSolana ? true : false,
          error: `Service execution failed: ${err.message}`,
          note: isSolana ? 'Payment was settled before execution. Contact support for refund.' : undefined,
        });
      }

      // For EVM: settle payment now (pay-for-success)
      if (!isSolana) {
        console.log(`[MoltsPay] /proxy: Settling payment...`);
        try {
          settlement = await this.registry.settle(payment, requirements);
          console.log(`[MoltsPay] /proxy: Payment settled by ${settlement.facilitator}: ${settlement.transaction || 'pending'}`);
        } catch (err: any) {
          console.error('[MoltsPay] /proxy: Settlement failed:', err.message);
          // Skill succeeded but settlement failed - return result anyway with warning
          return this.sendJson(res, 200, {
            success: true,
            verified: true,
            settled: false,
            settlementError: err.message,
            from: (payment.payload as any)?.authorization?.from,
            paidTo: wallet,
            amount: amountNum,
            currency: currency || 'USDC',
            memo,
            result,
          });
        }
      }

      return this.sendJson(res, 200, {
        success: true,
        verified: true,
        settled: settlement?.success || false,
        txHash: settlement?.transaction,
        from: (payment.payload as any)?.authorization?.from,
        paidTo: wallet,
        amount: amountNum,
        currency: currency || 'USDC',
        facilitator: settlement?.facilitator,
        memo,
        result,
      });
    }

    // No execution requested - settle immediately (payment-only mode)
    console.log(`[MoltsPay] /proxy: Settling payment (no execution)...`);
    let settlement: any = null;
    try {
      settlement = await this.registry.settle(payment, requirements);
      console.log(`[MoltsPay] /proxy: Payment settled by ${settlement.facilitator}: ${settlement.transaction || 'pending'}`);
    } catch (err: any) {
      console.error('[MoltsPay] /proxy: Settlement failed:', err.message);
      return this.sendJson(res, 500, {
        success: false,
        error: `Settlement failed: ${err.message}`,
      });
    }

    // Return success (payment only, no execution)
    this.sendJson(res, 200, {
      success: true,
      verified: true,
      settled: settlement?.success || false,
      txHash: settlement?.transaction,
      from: (payment.payload as any)?.authorization?.from,  // Buyer's wallet address
      paidTo: wallet,
      amount: amountNum,
      currency: currency || 'USDC',
      facilitator: settlement?.facilitator,
      memo,
    });
  }

  /**
   * Handle MPP payment flow for /proxy endpoint (tempo_moderato chain)
   */
  private async handleProxyMPP(
    body: any,
    config: ServiceConfig,
    authHeader: string | undefined,
    res: ServerResponse
  ): Promise<void> {
    const { wallet, amount, memo, serviceId } = body;
    const amountNum = parseFloat(amount);
    const amountInUnits = Math.floor(amountNum * 1e6).toString();
    
    // If no Authorization header, return 402 with WWW-Authenticate
    if (!authHeader || !authHeader.toLowerCase().startsWith('payment ')) {
      const challengeId = this.generateChallengeId();
      const tokenAddress = TOKEN_ADDRESSES['eip155:42431']?.USDC || '0x20c0000000000000000000000000000000000000';
      
      const mppRequest = {
        amount: amountInUnits,
        currency: tokenAddress,
        methodDetails: {
          chainId: 42431,
          feePayer: true,
        },
        recipient: wallet,
      };
      const mppRequestEncoded = Buffer.from(JSON.stringify(mppRequest)).toString('base64');
      
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      
      const wwwAuth = `Payment id="${challengeId}", realm="MoltsPay Proxy", method="tempo", intent="charge", request="${mppRequestEncoded}", description="${config.name}", expires="${expiresAt}"`;
      
      res.writeHead(402, {
        'Content-Type': 'application/problem+json',
        [MPP_WWW_AUTH_HEADER]: wwwAuth,
      });
      res.end(JSON.stringify({
        type: 'https://paymentauth.org/problems/payment-required',
        title: 'Payment Required',
        status: 402,
        detail: `Payment is required (${config.name}).`,
        service: serviceId || 'proxy',
        price: amountNum,
        currency: 'USDC',
      }, null, 2));
      return;
    }

    // Parse MPP credential: "Payment <base64>"
    const credentialMatch = authHeader.match(/Payment\s+(.+)/i);
    if (!credentialMatch) {
      return this.sendJson(res, 400, { error: 'Invalid Authorization header format' });
    }

    let mppCredential: {
      challenge: { id: string; realm: string; method: string; intent: string; request: any };
      payload: { hash?: string; type: 'hash' | 'transaction' };
      source?: string;
    };
    
    try {
      const base64 = credentialMatch[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(base64, 'base64').toString('utf-8');
      mppCredential = JSON.parse(decoded);
    } catch (err) {
      console.error('[MoltsPay] /proxy MPP: Failed to parse credential:', err);
      return this.sendJson(res, 400, { error: 'Invalid payment credential encoding' });
    }

    // Extract transaction hash
    let txHash: string | undefined;
    if (mppCredential.payload?.type === 'hash' && mppCredential.payload?.hash) {
      txHash = mppCredential.payload.hash;
    } else {
      return this.sendJson(res, 400, { error: 'Missing transaction hash in credential' });
    }

    console.log(`[MoltsPay] /proxy MPP: Verifying tx ${txHash} on Tempo...`);

    // Build requirements for verification
    const requirements = this.buildPaymentRequirements(config, 'eip155:42431', wallet, 'USDC');

    // Create x402-compatible payload for facilitator
    const paymentPayload: X402PaymentPayload = {
      x402Version: X402_VERSION,
      scheme: 'exact',
      network: 'eip155:42431',
      payload: { txHash, chainId: 42431 },
    };

    // Verify payment using facilitator registry
    const verification = await this.registry.verify(paymentPayload, requirements);
    
    if (!verification.valid) {
      return this.sendJson(res, 402, { 
        error: `Payment verification failed: ${verification.error}` 
      });
    }

    console.log(`[MoltsPay] /proxy MPP: Payment verified by ${verification.facilitator}`);

    // Check if execution requested
    const { execute, service, params } = body;
    
    if (execute && service) {
      console.log(`[MoltsPay] /proxy MPP: Executing skill: ${service}`);
      const skill = this.skills.get(service);
      if (!skill) {
        return this.sendJson(res, 404, {
          success: false,
          paymentSettled: true,  // Payment already happened on Tempo
          error: `Service not found: ${service}`,
        });
      }

      // Execute skill
      const timeoutSeconds = parseInt(process.env.SKILL_TIMEOUT_SECONDS || '1200');
      let result: any;
      try {
        result = await Promise.race([
          skill.handler(params || {}),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error(`Skill timeout after ${timeoutSeconds}s`)), timeoutSeconds * 1000)
          )
        ]);
      } catch (err: any) {
        console.error(`[MoltsPay] /proxy MPP: Skill failed: ${err.message}`);
        return this.sendJson(res, 500, {
          success: false,
          paymentSettled: true,
          error: `Service execution failed: ${err.message}`,
        });
      }

      return this.sendJson(res, 200, {
        success: true,
        verified: true,
        txHash,
        chain: 'tempo_moderato',
        paidTo: wallet,
        amount: amountNum,
        currency: 'USDC',
        facilitator: verification.facilitator,
        memo,
        result,
      });
    }

    // No execution requested - just return verification success
    this.sendJson(res, 200, {
      success: true,
      verified: true,
      txHash,
      chain: 'tempo_moderato',
      paidTo: wallet,
      amount: amountNum,
      currency: 'USDC',
      facilitator: verification.facilitator,
      memo,
    });
  }

  /**
   * Build payment requirements for proxy endpoint (uses provided wallet)
   */
  private buildProxyPaymentRequirements(config: ServiceConfig, wallet: string, token?: string, chain?: string): X402PaymentRequirements {
    const amountInUnits = Math.floor(config.price * 1e6).toString();
    const acceptedTokens = getAcceptedCurrencies(config);
    
    // Determine network from chain parameter or use default
    const networkId = chain ? (CHAIN_TO_NETWORK[chain] || this.networkId) : this.networkId;
    
    // Use specified token or default to first accepted
    const selectedToken = token && acceptedTokens.includes(token) ? token : acceptedTokens[0];
    const tokenAddresses = TOKEN_ADDRESSES[networkId] || TOKEN_ADDRESSES[this.networkId] || {};
    const tokenAddress = tokenAddresses[selectedToken];
    const tokenDomain = getTokenDomain(networkId, selectedToken);

    return {
      scheme: 'exact',
      network: networkId,
      asset: tokenAddress,
      amount: amountInUnits,
      payTo: wallet, // Use provided wallet, not manifest
      maxTimeoutSeconds: 300,
      extra: tokenDomain,
    };
  }

  /**
   * Return 402 with x402 payment requirements for proxy endpoint
   */
  private sendProxyPaymentRequired(
    config: ServiceConfig, 
    wallet: string,
    memo: string | undefined,
    chain: string | undefined,
    res: ServerResponse
  ): void {
    const requirements = this.buildProxyPaymentRequirements(config, wallet, config.currency, chain);

    const paymentRequired = {
      x402Version: X402_VERSION,
      accepts: [requirements],
      resource: {
        url: `/proxy`,
        description: `${config.name} - $${config.price} ${config.currency}`,
        mimeType: 'application/json',
        memo,
      },
    };

    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

    res.writeHead(402, {
      'Content-Type': 'application/json',
      [PAYMENT_REQUIRED_HEADER]: encoded,
    });
    res.end(JSON.stringify({
      error: 'Payment required',
      message: `Payment requires $${config.price} ${config.currency}`,
      x402: paymentRequired,
    }, null, 2));
  }
}
