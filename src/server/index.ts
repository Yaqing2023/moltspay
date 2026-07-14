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

import { readFileSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import crypto from 'node:crypto';
import {
  FacilitatorRegistry,
  FacilitatorSelection,
  FacilitatorConfig,
  X402PaymentPayload,
  X402PaymentRequirements,
  SettleResult,
  AlipayFacilitator,
  AlipayFacilitatorConfig,
  ALIPAY_NETWORK,
  ALIPAY_SCHEME,
  WechatFacilitator,
  WechatFacilitatorConfig,
  WECHAT_NETWORK,
  WECHAT_SCHEME,
  WECHAT_TIME_EXPIRE_MS,
  BalanceFacilitator,
  BalanceFacilitatorConfig,
  BALANCE_SCHEME,
  extractBalancePayload,
  verifyDeductAuth,
} from '../facilitators/index.js';
import { toPem } from '../facilitators/alipay/encoding.js';
import { BalanceEndpoints } from './balance-endpoints.js';
import { isAlipayChainId, isWechatChainId, isBalanceChainId } from '../chains/index.js';
import {
  ServicesManifest,
  ServiceConfig,
  SkillFunction,
  RegisteredSkill,
  MoltsPayServerOptions,
  CorsOptions,
} from './types.js';

export * from './types.js';

// Server-internal constants and pure helpers (extracted to ./internal.ts).
import {
  X402_VERSION, PAYMENT_REQUIRED_HEADER, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER,
  MPP_AUTH_HEADER, MPP_WWW_AUTH_HEADER, MPP_RECEIPT_HEADER,
  ALIPAY_PAYMENT_NEEDED_HEADER, ALIPAY_PAYMENT_PROOF_HEADER,
  headerSafe, canonicalJson, TOKEN_ADDRESSES, CHAIN_TO_NETWORK, isSolanaNetwork,
  getTokenDomain, getAcceptedCurrencies, loadEnvFile,
} from './internal.js';

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
  /** Alipay AI Pay facilitator instance, set when `provider.alipay` is configured (2.0.0). */
  private alipayFacilitator: AlipayFacilitator | null = null;
  /** WeChat Pay Native facilitator instance, set when `provider.wechat` is configured (2.1.0). */
  private wechatFacilitator: WechatFacilitator | null = null;
  /** Custodial balance facilitator instance, set when `provider.balance` is configured (2.2.0). */
  private balanceFacilitator: BalanceFacilitator | null = null;
  private balanceEndpoints: BalanceEndpoints | null = null;
  /**
   * Pending WeChat Native order cache — the double-charge fix.
   *
   * Every `buildWechatChallenge` used to place a NEW Native order, so a client
   * that received two 402s (e.g. initial challenge + one poll re-request that
   * raced ahead of payment) could surface two live QRs and a buyer could pay
   * both (confirmed ¥0.07×2 on 2026-07-02). Now the unpaid order is cached
   * under a content-derived key — sha256(service id | canonical params |
   * price_cny) — and reused until it is paid or its `time_expire` window
   * nears expiry, so any number of 402 emits for the same purchase intent
   * share ONE order, even across separate client processes.
   * Storing the in-flight promise also dedupes concurrent 402 builds.
   * In-memory by design: on restart the worst case is one extra unpaid order,
   * which expires server-side per `time_expire` — never a double charge.
   */
  private wechatPendingChallenges: Map<string, {
    promise: Promise<{ accepts: X402PaymentRequirements; codeUrl: string; outTradeNo: string } | null>;
    expiresAtMs: number;
    outTradeNo?: string;
  }> = new Map();

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

    // ── Alipay AI Pay fiat rail (2.0.0): opt-in via provider.alipay ──
    // When configured, resolve the PEM key files (the manifest stores PATHS,
    // the facilitator wants PEM STRINGS) and register the facilitator in the
    // selection so registry.verify/settle route `network: "alipay"` to it.
    // Key-load failure is fatal: a misconfigured alipay rail must not start
    // silently and then 500 on the first payment.
    const providerAlipay = this.manifest.provider.alipay;
    if (providerAlipay) {
      try {
        const baseDir = path.dirname(servicesPath);
        // Alipay hands out keys as bare Base64 (no PEM armor); toPem normalizes
        // both that and already-armored PEM into the PEM the facilitator needs.
        const resolvePem = (p: string, kind: 'PRIVATE' | 'PUBLIC') =>
          toPem(readFileSync(path.isAbsolute(p) ? p : path.resolve(baseDir, p), 'utf-8'), kind);
        const alipayFacilitatorConfig: AlipayFacilitatorConfig = {
          seller_id: providerAlipay.seller_id,
          app_id: providerAlipay.app_id,
          seller_name: providerAlipay.seller_name,
          service_id_default: providerAlipay.service_id_default,
          private_key_pem: resolvePem(providerAlipay.private_key_path, 'PRIVATE'),
          alipay_public_key_pem: resolvePem(providerAlipay.alipay_public_key_path, 'PUBLIC'),
          gateway_url: providerAlipay.gateway_url,
          sign_type: providerAlipay.sign_type,
        };
        facilitatorConfig.config = {
          ...facilitatorConfig.config,
          alipay: alipayFacilitatorConfig as unknown as FacilitatorConfig,
        };
        facilitatorConfig.fallback = facilitatorConfig.fallback || [];
        if (facilitatorConfig.primary !== 'alipay' && !facilitatorConfig.fallback.includes('alipay')) {
          facilitatorConfig.fallback.push('alipay');
        }
      } catch (err: any) {
        throw new Error(`[MoltsPay] Alipay rail configured but key load failed: ${err.message}`);
      }
    }

    // ── WeChat Pay v3 Native fiat rail (2.1.0): opt-in via provider.wechat ──
    // Same model as Alipay: resolve the PEM key files (manifest stores PATHS,
    // the facilitator wants PEM STRINGS) and register the facilitator so
    // registry.verify/settle route `network: "wechat"` to it. The platform
    // public key may be a public-key PEM OR an X.509 certificate PEM; the
    // latter is normalized to a public-key PEM via X509Certificate. Key-load
    // failure is fatal — a misconfigured rail must not start silently.
    const providerWechat = this.manifest.provider.wechat;
    if (providerWechat) {
      try {
        const baseDir = path.dirname(servicesPath);
        const readPem = (p: string) =>
          readFileSync(path.isAbsolute(p) ? p : path.resolve(baseDir, p), 'utf-8');
        const toPublicKeyPem = (pem: string): string =>
          pem.includes('BEGIN CERTIFICATE')
            ? new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'pem' }).toString()
            : pem;
        const wechatFacilitatorConfig: WechatFacilitatorConfig = {
          mchid: providerWechat.mchid,
          appid: providerWechat.appid,
          serial_no: providerWechat.serial_no,
          private_key_pem: readPem(providerWechat.private_key_path),
          platform_public_key_pem: providerWechat.platform_public_key_path
            ? toPublicKeyPem(readPem(providerWechat.platform_public_key_path))
            : undefined,
          apiv3_key: providerWechat.apiv3_key,
          notify_url: providerWechat.notify_url,
          api_base: providerWechat.api_base,
        };
        facilitatorConfig.config = {
          ...facilitatorConfig.config,
          wechat: wechatFacilitatorConfig as unknown as FacilitatorConfig,
        };
        facilitatorConfig.fallback = facilitatorConfig.fallback || [];
        if (facilitatorConfig.primary !== 'wechat' && !facilitatorConfig.fallback.includes('wechat')) {
          facilitatorConfig.fallback.push('wechat');
        }
      } catch (err: any) {
        throw new Error(`[MoltsPay] WeChat rail configured but key load failed: ${err.message}`);
      }
    }

    // ── Custodial balance rail (2.2.0): opt-in via provider.balance ──
    // No key material — just resolve the ledger db path relative to the
    // manifest. Ledger construction (and the Node >= 22.5 check inside it)
    // happens when the registry instantiates the facilitator below; a
    // failure there is fatal, same as a fiat-rail key-load failure.
    const providerBalance = this.manifest.provider.balance;
    if (providerBalance) {
      const baseDir = path.dirname(servicesPath);
      const balanceFacilitatorConfig: BalanceFacilitatorConfig = {
        db_path: providerBalance.db_path === ':memory:'
          ? providerBalance.db_path
          : path.isAbsolute(providerBalance.db_path)
            ? providerBalance.db_path
            : path.resolve(baseDir, providerBalance.db_path),
        currency: providerBalance.currency,
        single_limit: providerBalance.single_limit,
        daily_limit: providerBalance.daily_limit,
        auth_mode: providerBalance.auth_mode,
      };
      facilitatorConfig.config = {
        ...facilitatorConfig.config,
        balance: balanceFacilitatorConfig as unknown as FacilitatorConfig,
      };
      facilitatorConfig.fallback = facilitatorConfig.fallback || [];
      if (facilitatorConfig.primary !== 'balance' && !facilitatorConfig.fallback.includes('balance')) {
        facilitatorConfig.fallback.push('balance');
      }
    }

    this.registry = new FacilitatorRegistry(facilitatorConfig);

    if (providerAlipay) {
      this.alipayFacilitator = this.registry.get('alipay') as AlipayFacilitator;
      console.log(`[MoltsPay] Alipay AI Pay rail enabled (seller ${providerAlipay.seller_id})`);
    }

    if (providerWechat) {
      this.wechatFacilitator = this.registry.get('wechat') as WechatFacilitator;
      console.log(`[MoltsPay] WeChat Pay rail enabled (mchid ${providerWechat.mchid})`);
    }

    if (providerBalance) {
      this.balanceFacilitator = this.registry.get('balance') as BalanceFacilitator;
      // WeChat is set up before balance, so wechatFacilitator is final here.
      this.balanceEndpoints = new BalanceEndpoints({
        manifest: this.manifest,
        balance: this.balanceFacilitator,
        wechat: this.wechatFacilitator,
        sendJson: (res, status, data) => this.sendJson(res, status, data),
        getOrCreatePendingWechatOrder: (cacheKey, logLabel, create) =>
          this.getOrCreatePendingWechatOrder(cacheKey, logLabel, create),
        invalidateWechatChallenge: (outTradeNo) => this.invalidateWechatChallenge(outTradeNo),
      });
      console.log(`[MoltsPay] Custodial balance rail enabled (ledger ${providerBalance.db_path})`);
    }

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
      return provider.chains
        // Fiat rails (alipay/wechat) and the balance rail carry no EVM
        // network/token; they are emitted separately via
        // buildAlipayChallenge/buildWechatChallenge/buildBalanceChallenge.
        // Excluding them here prevents a spurious base/USDC accepts[] entry.
        .filter(c => {
          const chainName = typeof c === 'string' ? c : c.chain;
          return !isAlipayChainId(chainName) && !isWechatChainId(chainName) && !isBalanceChainId(chainName);
        })
        .map(c => {
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
   * Apply CORS response headers according to the `cors` option.
   *
   * Default (`cors` unset or `true`): `Access-Control-Allow-Origin: *`. Matches 1.5.x behavior
   * and works for every browser client whose origin does not need to send cookies.
   *
   * `cors: false`: emit no CORS headers. Same-origin only.
   * `cors: string[]`: origin allowlist — echo the origin back iff it matches.
   * `cors: CorsOptions`: full control (allowlist + credentials + maxAge).
   *
   * The required-for-Web response headers are always exposed when CORS is active:
   * `X-Payment-Required, X-Payment-Response, WWW-Authenticate, Payment-Receipt`.
   */
  private applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
    const cors = (this.options as MoltsPayServerOptions).cors;

    // Explicitly disabled: no CORS headers at all (strict same-origin).
    if (cors === false) {
      return;
    }

    const requestOrigin = (req.headers.origin as string | undefined) ?? '*';

    // Default / explicit `true`: open to any origin (legacy 1.5.x behavior).
    if (cors === undefined || cors === true) {
      this.writeCorsHeaders(res, '*');
      return;
    }

    // Array shortcut: origins allowlist, no credentials, default maxAge.
    if (Array.isArray(cors)) {
      if (cors.includes(requestOrigin)) {
        this.writeCorsHeaders(res, requestOrigin);
        res.setHeader('Vary', 'Origin');
      }
      // Origin not on the allowlist → no CORS headers; browser will block.
      return;
    }

    // Full CorsOptions object.
    const opt = cors as CorsOptions;
    const isAllowed =
      typeof opt.origins === 'function'
        ? opt.origins(requestOrigin)
        : opt.origins.includes(requestOrigin);
    if (!isAllowed) {
      return;
    }
    this.writeCorsHeaders(res, requestOrigin);
    res.setHeader('Vary', 'Origin');
    if (opt.credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    const maxAge = opt.maxAge ?? 600;
    res.setHeader('Access-Control-Max-Age', String(maxAge));
  }

  private writeCorsHeaders(res: ServerResponse, origin: string): void {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Payment, Authorization, Payment-Proof');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'X-Payment-Required, X-Payment-Response, WWW-Authenticate, Payment-Receipt, Payment-Needed'
    );
  }

  /**
   * Handle incoming request
   */
  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS — honors the `cors` option (default true = allow any origin, matches 1.5.x).
    this.applyCorsHeaders(req, res);

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

      // Root path — a caller (human or agent) landing on the base URL should be
      // guided into service discovery, not met with a bare 404. Serve the same
      // discovery payload as the well-known endpoint.
      if (url.pathname === '/' && req.method === 'GET') {
        return this.handleAgentServicesDiscovery(res);
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        return await this.handleHealthCheck(res);
      }

      // Custodial balance rail management endpoints (2.2.0).
      if (url.pathname.startsWith('/balance') && this.balanceEndpoints) {
        if (url.pathname === '/balance' && req.method === 'GET') {
          return this.balanceEndpoints.handleQuery(url, res);
        }
        if (url.pathname === '/balance/topup/order' && req.method === 'POST') {
          const body = await this.readBody(req);
          return await this.balanceEndpoints.handleTopupOrder(body, res);
        }
        if (url.pathname === '/balance/topup/confirm' && req.method === 'POST') {
          const body = await this.readBody(req);
          return await this.balanceEndpoints.handleTopupConfirm(body, res);
        }
        if (url.pathname === '/balance/topup' && req.method === 'POST') {
          const body = await this.readBody(req);
          return await this.balanceEndpoints.handleTopup(body, res);
        }
        if (url.pathname === '/balance/refund' && req.method === 'POST') {
          const body = await this.readBody(req);
          return this.balanceEndpoints.handleRefund(body, res);
        }
        if (url.pathname === '/balance/transactions' && req.method === 'GET') {
          return this.balanceEndpoints.handleTransactions(url, res);
        }
      }

      if (url.pathname === '/execute' && req.method === 'POST') {
        const body = await this.readBody(req);
        const paymentHeader = req.headers[PAYMENT_HEADER] as string | undefined;
        const proofHeader = req.headers[ALIPAY_PAYMENT_PROOF_HEADER] as string | undefined;
        return await this.handleExecute(body, paymentHeader, res, proofHeader);
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
        const proofHeader = req.headers[ALIPAY_PAYMENT_PROOF_HEADER] as string | undefined;
        return await this.handleMPPRequest(skill, body, authHeader, x402Header, res, proofHeader);
      }

      // Not found — include discovery hints so a mistyped or unknown path still
      // points the caller at service discovery instead of a dead end.
      this.sendJson(res, 404, {
        error: 'Not found',
        discovery: `${this.publicBase}/.well-known/agent-services.json`,
        endpoints: [`${this.publicBase}/health`, `${this.publicBase}/services`, `${this.publicBase}/execute`],
      });
    } catch (err: any) {
      console.error('[MoltsPay] Error:', err);
      this.sendJson(res, 500, { error: err.message || 'Internal error' });
    }
  }

  /**
   * Public base URL prefix for self-describing links, from PUBLIC_BASE_URL
   * (trailing slash stripped). Empty when unset, so emitted paths stay
   * root-relative — behavior is unchanged for local / no-prefix deploys.
   *
   * Needed because nginx rewrites the deployment prefix (e.g.
   * `/t/moltspay-server`) away before proxying, so the process cannot infer
   * its own public prefix; a root-relative `/services` would otherwise
   * resolve against the domain root and hit the wrong backend.
   */
  private get publicBase(): string {
    return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  }

  /**
   * Per-service pricing across every configured rail, for the discovery
   * payloads. The top-level `price`/`currency` (crypto/USDC) stay unchanged
   * for back-compat; this surfaces the fiat + balance rails (CNY) that were
   * previously invisible in discovery even though the manifest defines them
   * and the 402 challenge already quotes them. `acceptedCurrencies` becomes
   * the union across rails so a client can see CNY is accepted without
   * first triggering a 402.
   */
  private describeServicePricing(s: ServiceConfig): {
    acceptedCurrencies: string[];
    pricing: Array<{ rail: string; currency: string; amount: string }>;
  } {
    const pricing: Array<{ rail: string; currency: string; amount: string }> = [];
    // Only advertise the crypto rail when the provider actually has crypto
    // chains configured. Otherwise discovery would promise a rail that the 402
    // challenge never offers (getProviderChains drives those accepts[]), and a
    // client would waste an attempt on a payment path that cannot succeed.
    if (this.getProviderChains().length > 0) {
      for (const currency of getAcceptedCurrencies(s)) {
        pricing.push({ rail: 'crypto', currency, amount: String(s.price) });
      }
    }
    if (s.alipay) pricing.push({ rail: 'alipay', currency: 'CNY', amount: s.alipay.price_cny });
    if (s.wechat) pricing.push({ rail: 'wechat', currency: 'CNY', amount: s.wechat.price_cny });
    if (s.balance) {
      pricing.push({
        rail: 'balance',
        currency: this.manifest.provider.balance?.currency ?? 'CNY',
        amount: s.balance.price ?? s.price.toFixed(2),
      });
    }
    return { acceptedCurrencies: [...new Set(pricing.map(p => p.currency))], pricing };
  }

  /** Shared service-list entry for the discovery and /services endpoints. */
  private buildDiscoveryService(s: ServiceConfig) {
    const { acceptedCurrencies, pricing } = this.describeServicePricing(s);
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      price: s.price,
      currency: s.currency,
      acceptedCurrencies,
      pricing,
      input: s.input,
      output: s.output,
      available: this.skills.has(s.id),
    };
  }

  /**
   * GET /.well-known/agent-services.json - Standard discovery endpoint
   */
  private handleAgentServicesDiscovery(res: ServerResponse): void {
    const services = this.manifest.services.map(s => this.buildDiscoveryService(s));

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
        services: `${this.publicBase}/services`,
        execute: `${this.publicBase}/execute`,
        health: `${this.publicBase}/health`,
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
    const services = this.manifest.services.map(s => this.buildDiscoveryService(s));

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
    res: ServerResponse,
    proofHeader?: string
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

    // Alipay fiat rail (2.0.0): a `Payment-Proof` header means the buyer paid
    // via alipay-bot and is re-requesting the resource with proof. Route to
    // the facilitator verify→fulfill path (the proof's Base64URL blob carries
    // payment_proof / trade_no / client_session).
    if (proofHeader) {
      const alipayPayment: X402PaymentPayload = {
        x402Version: X402_VERSION,
        scheme: ALIPAY_SCHEME,
        network: ALIPAY_NETWORK,
        payload: proofHeader,
      };
      return this.handleAlipayExecute(skill, params || {}, alipayPayment, res);
    }

    // If no payment header, return 402 with payment requirements
    if (!paymentHeader) {
      return this.sendPaymentRequired(skill.config, res, params || {});
    }

    // Parse payment payload
    let payment: X402PaymentPayload;
    try {
      const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
      payment = JSON.parse(decoded);
    } catch {
      return this.sendJson(res, 400, { error: 'Invalid X-Payment header' });
    }

    // Alipay fiat rail (2.0.0): route by scheme/network BEFORE the EVM path.
    // validatePayment() only accepts 'exact'/'permit' schemes + EVM/SVM
    // networks, so an alipay payment must branch off here or it'd be rejected.
    const payScheme = payment.accepted?.scheme || payment.scheme;
    const payNetwork = payment.accepted?.network || payment.network;
    if (payScheme === ALIPAY_SCHEME || (payNetwork ? isAlipayChainId(payNetwork) : false)) {
      return this.handleAlipayExecute(skill, params || {}, payment, res);
    }
    if (payScheme === WECHAT_SCHEME || (payNetwork ? isWechatChainId(payNetwork) : false)) {
      return this.handleWechatExecute(skill, params || {}, payment, res);
    }
    if (payScheme === BALANCE_SCHEME || (payNetwork ? isBalanceChainId(payNetwork) : false)) {
      return this.handleBalanceExecute(skill, params || {}, payment, res);
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
        settlement = { success: false, error: err.message, facilitator: 'none' };
      }

      // Match Solana semantics: settle failure → 402, do NOT claim payment
      // succeeded. Skill was already executed; provider absorbs the cost.
      if (!settlement?.success) {
        return this.sendJson(res, 402, {
          error: 'Payment settlement failed',
          message: settlement?.error || 'Settlement returned no success state',
          facilitator: settlement?.facilitator,
        });
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
   * Execute a service paid via the Alipay AI Pay fiat rail (2.0.0).
   *
   * Differs from the EVM/SVM path: no token detection, no EIP-3009/permit
   * validation. Verify hits the Alipay Open API (`payment.verify`). Settlement
   * (`fulfillment.confirm`) is FIRE-AND-FORGET per ALIPAY-INTEGRATION-DESIGN
   * §5.1: a confirm failure is logged but does NOT fail the already-delivered
   * response (the buyer's payment proof was already verified).
   */
  private async handleAlipayExecute(
    skill: RegisteredSkill,
    params: Record<string, any>,
    payment: X402PaymentPayload,
    res: ServerResponse
  ): Promise<void> {
    if (!this.alipayFacilitator) {
      return this.sendJson(res, 402, { error: 'Alipay rail not configured on this server' });
    }

    // Verify/settle ignore `requirements` (the proof carries everything), but
    // requirements.network drives registry routing to the alipay facilitator.
    const requirements: X402PaymentRequirements = {
      scheme: ALIPAY_SCHEME,
      network: ALIPAY_NETWORK,
      asset: 'CNY',
      amount: skill.config.alipay?.price_cny || '0',
      payTo: this.manifest.provider.alipay?.seller_id || '',
      maxTimeoutSeconds: 1800,
    };

    console.log(`[MoltsPay] Verifying Alipay payment...`);
    const verifyResult = await this.registry.verify(payment, requirements);
    if (!verifyResult.valid) {
      return this.sendJson(res, 402, {
        error: `Payment verification failed: ${verifyResult.error}`,
        facilitator: verifyResult.facilitator,
      });
    }
    console.log(`[MoltsPay] Alipay payment verified by ${verifyResult.facilitator}`);

    // Execute skill (same timeout contract as the EVM path).
    const timeoutSeconds = parseInt(process.env.SKILL_TIMEOUT_SECONDS || '1200');
    console.log(`[MoltsPay] Executing skill: ${skill.id} (timeout: ${timeoutSeconds}s)`);
    let result: any;
    try {
      result = await Promise.race([
        skill.handler(params),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Skill timeout after ${timeoutSeconds}s`)), timeoutSeconds * 1000)
        )
      ]);
    } catch (err: any) {
      console.error('[MoltsPay] Skill execution failed:', err.message);
      return this.sendJson(res, 500, {
        error: 'Service execution failed',
        message: err.message,
      });
    }

    // Fulfillment confirm — fire-and-forget: log failures, never roll back.
    let settlement: (SettleResult & { facilitator: string });
    try {
      settlement = await this.registry.settle(payment, requirements);
      if (settlement.success) {
        console.log(`[MoltsPay] Alipay fulfillment confirmed: ${settlement.transaction}`);
      } else {
        console.error(`[MoltsPay] Alipay fulfillment confirm failed (non-fatal): ${settlement.error}`);
      }
    } catch (err: any) {
      console.error(`[MoltsPay] Alipay fulfillment confirm threw (non-fatal): ${err.message}`);
      settlement = { success: false, error: err.message, facilitator: 'alipay' };
    }

    const responseHeaders: Record<string, string> = {};
    if (settlement.success) {
      responseHeaders[PAYMENT_RESPONSE_HEADER] = Buffer.from(JSON.stringify({
        success: true,
        transaction: settlement.transaction,
        network: ALIPAY_NETWORK,
        facilitator: settlement.facilitator,
      })).toString('base64');
    }

    this.sendJson(res, 200, {
      success: true,
      result,
      payment: settlement.success
        ? { transaction: settlement.transaction, status: 'fulfilled', facilitator: settlement.facilitator }
        : { status: 'delivered_unconfirmed', error: settlement.error },
    }, responseHeaders);
  }

  /**
   * Build the Alipay 402 challenge for a service, or null when the alipay rail
   * isn't configured for this server or this service. Returns the x402
   * `accepts[]` entry plus the Base64URL `Payment-Needed` header value so the
   * 402 responders can dual-emit both the x402 and legacy alipay-bot formats.
   */
  private async buildAlipayChallenge(
    config: ServiceConfig
  ): Promise<{ accepts: X402PaymentRequirements; paymentNeededHeader: string } | null> {
    if (!this.alipayFacilitator || !config.alipay) return null;
    try {
      const req = await this.alipayFacilitator.createPaymentRequirements({
        serviceId: config.alipay.service_id || this.manifest.provider.alipay!.service_id_default,
        priceCny: config.alipay.price_cny,
        goodsName: config.alipay.goods_name,
        resourceId: `/execute?service=${config.id}`,
      });
      return { accepts: req.x402Accepts, paymentNeededHeader: req.paymentNeededHeader };
    } catch (err: any) {
      console.error(`[MoltsPay] Alipay challenge build failed for ${config.id}: ${err.message}`);
      return null;
    }
  }

  /**
   * Execute a service paid via the WeChat Pay v3 Native fiat rail (2.1.0).
   *
   * Differs from the EVM/SVM path: no token detection, no EIP-3009/permit
   * validation. The buyer (a human) scanned the Native QR and paid; the
   * client re-requests carrying `out_trade_no` in the X-Payment payload.
   * Verify queries the order (`trade_state === SUCCESS`). Settlement is an
   * idempotent re-confirm and is FIRE-AND-FORGET (mirrors the Alipay path):
   * a confirm failure is logged but does NOT fail the delivered response —
   * the order was already verified SUCCESS.
   */
  private async handleWechatExecute(
    skill: RegisteredSkill,
    params: Record<string, any>,
    payment: X402PaymentPayload,
    res: ServerResponse
  ): Promise<void> {
    if (!this.wechatFacilitator) {
      return this.sendJson(res, 402, { error: 'WeChat rail not configured on this server' });
    }

    // Verify/settle extract out_trade_no from the payload; requirements.network
    // drives registry routing to the wechat facilitator. Pass the client's
    // out_trade_no through requirements.extra as a fallback for verify().
    const outTradeNo =
      typeof payment.accepted?.extra?.out_trade_no === 'string'
        ? payment.accepted.extra.out_trade_no
        : undefined;
    const requirements: X402PaymentRequirements = {
      scheme: WECHAT_SCHEME,
      network: WECHAT_NETWORK,
      asset: 'CNY',
      amount: skill.config.wechat?.price_cny || '0',
      payTo: this.manifest.provider.wechat?.mchid || '',
      maxTimeoutSeconds: 300,
      extra: outTradeNo ? { out_trade_no: outTradeNo } : undefined,
    };

    console.log(`[MoltsPay] Verifying WeChat payment...`);
    const verifyResult = await this.registry.verify(payment, requirements);
    if (!verifyResult.valid) {
      return this.sendJson(res, 402, {
        error: `Payment verification failed: ${verifyResult.error}`,
        facilitator: verifyResult.facilitator,
      });
    }
    console.log(`[MoltsPay] WeChat payment verified by ${verifyResult.facilitator}`);

    // The order is consumed (Native: one code, one payment) — drop it from the
    // pending-challenge cache so the next 402 mints a fresh order.
    if (outTradeNo) {
      this.invalidateWechatChallenge(outTradeNo);
    }

    // Execute skill (same timeout contract as the EVM path).
    const timeoutSeconds = parseInt(process.env.SKILL_TIMEOUT_SECONDS || '1200');
    console.log(`[MoltsPay] Executing skill: ${skill.id} (timeout: ${timeoutSeconds}s)`);
    let result: any;
    try {
      result = await Promise.race([
        skill.handler(params),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Skill timeout after ${timeoutSeconds}s`)), timeoutSeconds * 1000)
        )
      ]);
    } catch (err: any) {
      console.error('[MoltsPay] Skill execution failed:', err.message);
      return this.sendJson(res, 500, {
        error: 'Service execution failed',
        message: err.message,
      });
    }

    // Settlement confirm — fire-and-forget: log failures, never roll back.
    let settlement: (SettleResult & { facilitator: string });
    try {
      settlement = await this.registry.settle(payment, requirements);
      if (settlement.success) {
        console.log(`[MoltsPay] WeChat settlement confirmed: ${settlement.transaction}`);
      } else {
        console.error(`[MoltsPay] WeChat settlement confirm failed (non-fatal): ${settlement.error}`);
      }
    } catch (err: any) {
      console.error(`[MoltsPay] WeChat settlement confirm threw (non-fatal): ${err.message}`);
      settlement = { success: false, error: err.message, facilitator: 'wechat' };
    }

    const responseHeaders: Record<string, string> = {};
    if (settlement.success) {
      responseHeaders[PAYMENT_RESPONSE_HEADER] = Buffer.from(JSON.stringify({
        success: true,
        transaction: settlement.transaction,
        network: WECHAT_NETWORK,
        facilitator: settlement.facilitator,
      })).toString('base64');
    }

    this.sendJson(res, 200, {
      success: true,
      result,
      payment: settlement.success
        ? { transaction: settlement.transaction, status: 'fulfilled', facilitator: settlement.facilitator }
        : { status: 'delivered_unconfirmed', error: settlement.error },
    }, responseHeaders);
  }

  /**
   * Build the WeChat 402 challenge for a service, or null when the wechat rail
   * isn't configured for this server or this service. Placing a Native order
   * is a network call that returns a fresh `code_url` + `out_trade_no`; the
   * x402 `accepts[]` entry carries both in `extra` so the client can render
   * the QR and later echo `out_trade_no` back for verification.
   *
   * DOUBLE-CHARGE FIX: the unpaid order is cached per service id (see
   * `wechatPendingChallenges`), so repeated 402 emits within the order's
   * `time_expire` window return the SAME `code_url`/`out_trade_no` instead of
   * minting a new payable order each time. The entry is dropped once the
   * order is paid (`invalidateWechatChallenge`) or shortly before it expires
   * (refresh margin, so clients never receive a nearly-dead QR). A build
   * failure is not cached and degrades gracefully (the other rails'
   * accepts[] still ship).
   */
  private async buildWechatChallenge(
    config: ServiceConfig,
    params?: Record<string, any>
  ): Promise<{ accepts: X402PaymentRequirements } | null> {
    if (!this.wechatFacilitator || !config.wechat) return null;

    // Content-derived idempotency key: same service + same params + same
    // price ⇒ same pending order, even across separate client processes (a
    // client-random key could not dedupe two independent `pay` retries).
    // Distinct params get distinct orders, so one buyer's payment can never
    // cover another buyer's different work product. Documented limitation:
    // two buyers requesting the IDENTICAL service+params within the TTL share
    // one order (no buyer identity exists at 402 time — accepted).
    const cacheKey = crypto
      .createHash('sha256')
      .update(`${config.id}|${canonicalJson(params ?? {})}|${config.wechat.price_cny}`)
      .digest('hex');

    const result = await this.getOrCreatePendingWechatOrder(cacheKey, config.id, () =>
      this.wechatFacilitator!.createPaymentRequirements({
        priceCny: config.wechat!.price_cny,
        description: config.wechat!.description,
      }),
    );
    return result ? { accepts: result.accepts } : null;
  }

  /**
   * Get-or-create a pending WeChat Native order under `cacheKey`, deduping
   * concurrent builds and reusing an unpaid order until it nears expiry.
   * Shared by the 402 challenge path ({@link buildWechatChallenge}) and the
   * balance top-up order path ({@link handleBalanceTopupOrder}). See the
   * `wechatPendingChallenges` doc for the double-charge rationale.
   */
  private async getOrCreatePendingWechatOrder(
    cacheKey: string,
    logLabel: string,
    create: () => Promise<{ x402Accepts: X402PaymentRequirements; codeUrl: string; outTradeNo: string }>,
  ): Promise<{ accepts: X402PaymentRequirements; codeUrl: string; outTradeNo: string } | null> {
    const now = Date.now();
    const cached = this.wechatPendingChallenges.get(cacheKey);
    if (cached) {
      if (now < cached.expiresAtMs) {
        const hit = await cached.promise;
        if (hit) {
          console.log(`[MoltsPay] Reusing pending WeChat order ${hit.outTradeNo} for ${logLabel}`);
          return hit;
        }
        // Build failed after we joined it -- fall through to a fresh attempt.
      }
      this.wechatPendingChallenges.delete(cacheKey);
    }

    // Refresh 30s before the real order expiry so a just-served QR always has
    // usable life left (never less than half the window, for tiny expiries).
    const orderTtlMs = WECHAT_TIME_EXPIRE_MS;
    const cacheTtlMs = Math.max(orderTtlMs - 30_000, Math.floor(orderTtlMs / 2));

    const entry: {
      promise: Promise<{ accepts: X402PaymentRequirements; codeUrl: string; outTradeNo: string } | null>;
      expiresAtMs: number;
      outTradeNo?: string;
    } = {
      expiresAtMs: now + cacheTtlMs,
      promise: Promise.resolve(null),
    };
    entry.promise = (async () => {
      try {
        const req = await create();
        entry.outTradeNo = req.outTradeNo;
        return { accepts: req.x402Accepts, codeUrl: req.codeUrl, outTradeNo: req.outTradeNo };
      } catch (err: any) {
        console.error(`[MoltsPay] WeChat order build failed for ${logLabel}: ${err.message}`);
        // Never cache a failure -- the next attempt retries.
        this.wechatPendingChallenges.delete(cacheKey);
        return null;
      }
    })();
    this.wechatPendingChallenges.set(cacheKey, entry);

    return entry.promise;
  }

  /**
   * Drop the cached pending WeChat order that matches a paid `out_trade_no`,
   * so the next 402 mints a fresh order instead of re-serving a consumed one
   * (Native is one-code-one-payment).
   */
  private invalidateWechatChallenge(outTradeNo: string): void {
    for (const [cacheKey, entry] of this.wechatPendingChallenges) {
      if (entry.outTradeNo === outTradeNo) {
        this.wechatPendingChallenges.delete(cacheKey);
      }
    }
  }

  /**
   * Handle /execute for the custodial balance rail (2.2.0).
   *
   * Execution order is INVERTED relative to the QR rails: the deduction IS
   * the settlement, so it must land before the skill runs, and a skill
   * failure refunds it. `settle()` is idempotent on the client's
   * `request_id`, so a retried request never double-charges.
   *
   *   QR rails:  verify(paid?) → run skill → settle (confirm, fire-and-forget)
   *   balance:   verify implicit in settle (atomic deduct) → run skill → [fail → refund]
   */
  private async handleBalanceExecute(
    skill: RegisteredSkill,
    params: Record<string, any>,
    payment: X402PaymentPayload,
    res: ServerResponse
  ): Promise<void> {
    if (!this.balanceFacilitator) {
      return this.sendJson(res, 402, { error: 'Balance rail not configured on this server' });
    }

    const requirements = this.balanceRequirementsFor(skill.config);

    // User auth (1b): verify the originator signature and TOFU-bind the
    // account's signer. `off` skips entirely; `shadow` records but never
    // blocks; `enforce` rejects unsigned / wrong-signer deductions before any
    // charge. See docs/2026-07-13-wechat-fiat-auth-design.md.
    const authMode = this.balanceFacilitator.authMode;
    if (authMode !== 'off') {
      const bp = extractBalancePayload(payment);
      const buyerId = bp?.buyer_id ?? '';
      const requestId = bp?.request_id ?? '';
      const av = verifyDeductAuth({
        auth: bp?.auth ?? null,
        buyerId,
        requestId,
        service: skill.id,
        nowMs: Date.now(),
      });
      const ledger = this.balanceFacilitator.getLedger();
      let denyReason: string | undefined;
      if (av.ok && av.recovered) {
        const bind = ledger.bindSigner(buyerId, av.recovered);
        if (bind.conflict) denyReason = `wrong signer (account bound to ${bind.existing}, got ${av.recovered})`;
      } else {
        denyReason = `signature ${av.reason}`;
      }
      if (denyReason) {
        if (authMode === 'enforce') {
          console.warn(`[MoltsPay] Balance auth DENY (enforce) buyer=${buyerId} svc=${skill.id}: ${denyReason}`);
          return this.sendJson(res, 401, { error: `Balance auth failed: ${denyReason}`, facilitator: 'balance' });
        }
        console.warn(`[MoltsPay] Balance auth would-deny (shadow) buyer=${buyerId} svc=${skill.id}: ${denyReason}`);
      } else {
        console.log(`[MoltsPay] Balance auth ok (${authMode}) buyer=${buyerId} signer=${av.recovered}`);
      }
    }

    // Atomic deduct (settle). checkDeduct runs inside the same transaction,
    // so a separate verify() call here would only add a TOCTOU window.
    console.log(`[MoltsPay] Deducting balance for ${skill.id}...`);
    const settlement = await this.balanceFacilitator.settle(payment, requirements);
    if (!settlement.success) {
      return this.sendJson(res, 402, {
        error: `Balance deduction failed: ${settlement.error}`,
        code: settlement.status,
        facilitator: 'balance',
      });
    }
    console.log(`[MoltsPay] Balance deducted (tx ${settlement.transaction}${settlement.status === 'replayed' ? ', replayed' : ''})`);

    // Execute skill (same timeout contract as the other rails).
    const timeoutSeconds = parseInt(process.env.SKILL_TIMEOUT_SECONDS || '1200');
    console.log(`[MoltsPay] Executing skill: ${skill.id} (timeout: ${timeoutSeconds}s)`);
    let result: any;
    try {
      result = await Promise.race([
        skill.handler(params),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Skill timeout after ${timeoutSeconds}s`)), timeoutSeconds * 1000)
        )
      ]);
    } catch (err: any) {
      console.error('[MoltsPay] Skill execution failed:', err.message);
      // The buyer was already charged — reverse it. refund() is idempotent
      // per deduct, so a crash-retry of this path cannot double-credit.
      const refund = this.balanceFacilitator.refund(settlement.transaction!, `skill_failed: ${err.message}`.slice(0, 200));
      if (!refund.success) {
        console.error(`[MoltsPay] Balance refund FAILED for ${settlement.transaction}: ${refund.error} — manual reconciliation needed`);
      } else {
        console.log(`[MoltsPay] Balance refunded (tx ${refund.txId})`);
      }
      return this.sendJson(res, 500, {
        error: 'Service execution failed',
        message: err.message,
        refunded: refund.success,
      });
    }

    const responseHeaders: Record<string, string> = {
      [PAYMENT_RESPONSE_HEADER]: Buffer.from(JSON.stringify({
        success: true,
        transaction: settlement.transaction,
        network: 'balance',
        facilitator: 'balance',
      })).toString('base64'),
    };
    this.sendJson(res, 200, {
      success: true,
      result,
      payment: { transaction: settlement.transaction, status: 'fulfilled', facilitator: 'balance' },
    }, responseHeaders);
  }

  /** The balance rail's requirements for a service (price defaults to `config.price`). */
  private balanceRequirementsFor(config: ServiceConfig): X402PaymentRequirements {
    const price = config.balance?.price ?? config.price.toFixed(2);
    return {
      scheme: BALANCE_SCHEME,
      network: 'balance',
      asset: this.balanceFacilitator?.currency ?? 'USD',
      amount: price,
      payTo: 'custodial',
      maxTimeoutSeconds: 30,
      extra: { service_id: config.id },
    };
  }

  /**
   * Build the balance 402 challenge for a service, or null when the rail
   * isn't configured for this server or this service. Pure — nothing is
   * minted, so unlike the QR rails a 402 emit has no side effects.
   */
  private buildBalanceChallenge(config: ServiceConfig): { accepts: X402PaymentRequirements } | null {
    if (!this.balanceFacilitator || !config.balance) return null;
    try {
      return { accepts: this.balanceRequirementsFor(config) };
    } catch (err: any) {
      console.error(`[MoltsPay] Balance challenge build failed for ${config.id}: ${err.message}`);
      return null;
    }
  }

  /** GET /balance?buyer_id= — balance, limits, and today's spend. */
  /**
   * Handle MPP (Machine Payments Protocol) request
   * Supports both x402 and MPP protocols on service endpoints
   */
  private async handleMPPRequest(
    skill: RegisteredSkill,
    body: any,
    authHeader: string | undefined,
    x402Header: string | undefined,
    res: ServerResponse,
    proofHeader?: string
  ): Promise<void> {
    const config = skill.config;
    const params = body || {};

    // Alipay buyer re-request with a Payment-Proof header → verify + fulfill.
    if (proofHeader) {
      return await this.handleExecute({ service: config.id, params }, undefined, res, proofHeader);
    }

    // Check for x402 payment header first (backward compatibility)
    if (x402Header) {
      return await this.handleExecute({ service: config.id, params }, x402Header, res);
    }

    // Check for MPP payment credential
    if (authHeader && authHeader.toLowerCase().startsWith('payment ')) {
      return await this.handleMPPPayment(skill, params, authHeader, res);
    }

    // No payment provided - return 402 with both x402 and MPP headers
    return this.sendMPPPaymentRequired(config, res, params);
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
  private async sendMPPPaymentRequired(config: ServiceConfig, res: ServerResponse, params?: Record<string, any>): Promise<void> {
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

    // Alipay fiat rail (2.0.0): append the alipay x402 entry when configured.
    const alipayChallenge = await this.buildAlipayChallenge(config);
    if (alipayChallenge) {
      accepts.push(alipayChallenge.accepts);
    }

    // WeChat fiat rail (2.1.0): append the wechat x402 entry when configured.
    const wechatChallenge = await this.buildWechatChallenge(config, params);
    if (wechatChallenge) {
      accepts.push(wechatChallenge.accepts);
    }

    // Custodial balance rail (2.2.0): append the balance x402 entry when configured.
    const balanceChallenge = this.buildBalanceChallenge(config);
    if (balanceChallenge) {
      accepts.push(balanceChallenge.accepts);
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
      
      mppWwwAuth = `Payment id="${challengeId}", realm="${headerSafe(this.manifest.provider.name)}", method="tempo", intent="charge", request="${mppRequestEncoded}", description="${headerSafe(config.name)}", expires="${expiresAt}"`;
    }

    // Build response headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/problem+json',
      [PAYMENT_REQUIRED_HEADER]: x402Encoded,
    };

    if (mppWwwAuth) {
      headers[MPP_WWW_AUTH_HEADER] = mppWwwAuth;
    }
    // Dual-emit the legacy `Payment-Needed` header for alipay-bot clients.
    if (alipayChallenge) {
      headers[ALIPAY_PAYMENT_NEEDED_HEADER] = alipayChallenge.paymentNeededHeader;
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
  private async sendPaymentRequired(config: ServiceConfig, res: ServerResponse, params?: Record<string, any>): Promise<void> {
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

    // Alipay fiat rail (2.0.0): append the alipay x402 entry when configured.
    const alipayChallenge = await this.buildAlipayChallenge(config);
    if (alipayChallenge) {
      accepts.push(alipayChallenge.accepts);
    }

    // WeChat fiat rail (2.1.0): append the wechat x402 entry when configured.
    const wechatChallenge = await this.buildWechatChallenge(config, params);
    if (wechatChallenge) {
      accepts.push(wechatChallenge.accepts);
    }

    // Custodial balance rail (2.2.0): append the balance x402 entry when configured.
    const balanceChallenge = this.buildBalanceChallenge(config);
    if (balanceChallenge) {
      accepts.push(balanceChallenge.accepts);
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
        url: `${this.publicBase}/execute?service=${config.id}`,
        description: `${config.name} - $${config.price} ${config.currency}`,
        mimeType: 'application/json',
      },
    };

    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString('base64');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [PAYMENT_REQUIRED_HEADER]: encoded,
    };
    // Dual-emit the legacy `Payment-Needed` header for alipay-bot clients
    // (@alipay/agent-payment), which only read this header and ignore the
    // x402 `accepts[]`. Mirrors sendMPPPaymentRequired so /execute is
    // byte-for-byte compatible with un-upgraded skills.
    if (alipayChallenge) {
      headers[ALIPAY_PAYMENT_NEEDED_HEADER] = alipayChallenge.paymentNeededHeader;
    }

    // The human-readable body must describe the rails actually on offer. It
    // used to hardcode the USDC list price, which told an LLM agent to pay in
    // crypto even on a server that no longer accepts it -- the agent then
    // burned its first attempt on a rail with no accepts[] entry.
    const offered = this.describeServicePricing(config);
    const message = offered.pricing.length
      ? `Payment required — ${offered.pricing.map(p => `${p.rail}: ${p.amount} ${p.currency}`).join(' | ')}`
      : `Service requires $${config.price} ${config.currency}`;

    res.writeHead(402, headers);
    res.end(JSON.stringify({
      error: 'Payment required',
      message,
      acceptedCurrencies: offered.acceptedCurrencies,
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

    // Both schemes are supported: EIP-3009 `exact` (Base/Polygon/BNB/Solana) and
    // EIP-2612 `permit` (Tempo Moderato, added in 1.6.0). Facilitator routes
    // permit payloads to TempoFacilitator automatically.
    if (scheme !== 'exact' && scheme !== 'permit') {
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

    // Tempo Moderato uses EIP-2612 permit (pathUSD / AlphaUSD don't implement EIP-3009).
    // Every other network uses the standard x402 "exact" (EIP-3009) scheme.
    const isTempo = selectedNetwork === 'eip155:42431';
    const scheme = isTempo ? 'permit' : 'exact';

    const requirements: X402PaymentRequirements = {
      scheme,
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

    // For Tempo: include the settler EOA so the client can sign Permit(spender=settler).
    // If TEMPO_SETTLER_KEY is not configured, tempoSpender will be absent and Web Client
    // will surface a helpful error rather than sign a permit no one can fulfill.
    if (isTempo) {
      const tempoFacilitator = this.registry.get('tempo') as any;
      const tempoSpender = tempoFacilitator?.getSpenderAddress?.();
      if (tempoSpender) {
        (requirements.extra as any) = {
          ...(requirements.extra || {}),
          tempoSpender,
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
    
    // If no whitelist configured, allow all (for testing/open mode)
    if (allowedIPs.length === 0) {
      return true;
    }
    
    // If '*' is in the list, allow all
    if (allowedIPs.includes('*')) {
      return true;
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

    if (scheme !== 'exact' && scheme !== 'permit') {
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
      
      const wwwAuth = `Payment id="${challengeId}", realm="MoltsPay Proxy", method="tempo", intent="charge", request="${mppRequestEncoded}", description="${headerSafe(config.name)}", expires="${expiresAt}"`;
      
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

    const requirements: X402PaymentRequirements = {
      scheme: 'exact',
      network: networkId,
      asset: tokenAddress,
      amount: amountInUnits,
      payTo: wallet, // Use provided wallet, not manifest
      maxTimeoutSeconds: 300,
      extra: tokenDomain,
    };

    // For BNB: include spender address for client approval
    if (networkId === 'eip155:56' || networkId === 'eip155:97') {
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
