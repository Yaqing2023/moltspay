/**
 * MoltsPay Client - Pay for AI Agent services
 * 
 * Uses x402 protocol for gasless, pay-for-success payments.
 * 
 * Usage:
 *   const client = new MoltsPayClient();  // Loads from ~/.moltspay/
 *   const services = await client.getServices('http://provider:3000');
 *   const result = await client.pay('http://provider:3000', 'text-to-video', { prompt: '...' });
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { Wallet, ethers } from 'ethers';
import { getChain, type ChainName, type EvmChainName, type TokenSymbol, type ChainConfig } from '../../chains/index.js';
import { SOLANA_CHAINS, type SolanaChainName } from '../../chains/solana.js';
import { loadSolanaWallet, getSolanaAddress } from '../../wallet/solana.js';
import { createSolanaPaymentTransaction } from '../../facilitators/solana.js';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import {
  ClientConfig,
  WalletData,
  ServicesResponse,
  MoltsPayClientOptions,
} from '../types.js';
import {
  X402_VERSION,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_HEADER,
  type X402PaymentRequirements,
  type EIP3009Authorization,
  networkToChainName as coreNetworkToChainName,
  type ChainName as CoreChainName,
  buildEIP3009TypedData,
  buildBnbIntentTypedData,
} from '../core/index.js';
import type { PaymentSigner } from '../signer.js';
import { NodeSigner } from './signer.js';
import { AlipayClient } from '../alipay/index.js';
import { WechatClient, type WechatPaymentSession } from '../wechat/index.js';
import { timeStep } from '../alipay/log.js';
import { selectRail, ALIPAY_RAIL, WECHAT_RAIL, BALANCE_RAIL } from '../alipay/router.js';
import { buildDeductMessage } from '../../facilitators/balance/auth.js';

export * from '../types.js';

/** A recoverable balance top-up session, persisted under `<configDir>/balance-topup-sessions`. */
export interface BalanceTopupSession {
  out_trade_no: string;
  buyer_id: string;
  pack: string;
  server_url: string;
  code_url: string;
  status: 'pending' | 'credited' | 'expired';
  created_at: string;
  expires_at: string;
  context?: Record<string, any>;
  tx_id?: string;
  balance?: string;
}

export interface PayOptions {
  /** Token to pay with (default: USDC, or auto-select based on balance) */
  token?: TokenSymbol;
  /** Auto-select token based on balance (default: false) */
  autoSelect?: boolean;
  /** Chain to pay on */
  chain?: 'base' | 'polygon' | 'base_sepolia' | 'tempo_moderato' | 'bnb' | 'bnb_testnet' | 'solana' | 'solana_devnet';
  /** Send raw data at top level instead of wrapped in { params } */
  rawData?: boolean;
  /**
   * Explicit payment rail (2.0.0): `'alipay'` or a chain name. When set,
   * routing skips the default crypto path. `'alipay'` dispatches to the
   * alipay-bot-backed {@link AlipayClient} and needs no EVM wallet.
   */
  rail?: string;
  /**
   * Balance rail (2.2.0): buyer identity for password-free payment.
   * Falls back to the persisted `config.buyerId`. Bearer semantics.
   */
  buyerId?: string;
  /** Alipay: surfaced once the payment URL + tradeNo are known. */
  onPaymentPending?: (info: { paymentUrl: string; shortenUrl?: string; tradeNo: string }) => void;
  /** Alipay: forward CLI output to the user verbatim (line by line). */
  onLine?: (line: string) => void;
  /** Alipay: overall budget; defaults to the challenge's pay_before window. */
  timeoutMs?: number;
  /** Cancellation (alipay poll loop). */
  signal?: AbortSignal;
  /**
   * WeChat: after `startWechatPayment()`, let the SDK client poll in the
   * background and invoke the callbacks below. `pay --rail wechat` always polls
   * because it is the blocking terminal wrapper.
   */
  autoPoll?: boolean;
  /** WeChat: called when the background poll fulfills the resource. */
  onWechatPaymentCompleted?: (session: WechatPaymentSession) => void | Promise<void>;
  /** WeChat: called when background poll expires, fails, or is cancelled. */
  onWechatPaymentFailed?: (session: WechatPaymentSession) => void | Promise<void>;
  /**
   * Balance rail (2.3.0): when a password-free deduct finds an insufficient
   * balance, auto-fund via a WeChat top-up pack, then retry once. Default true.
   * Set false to fail fast instead.
   */
  autoTopup?: boolean;
  /**
   * Balance rail top-up mode (2.5.0). `'auto'` (default): block through the
   * top-up scan + retry (terminal use). `'manual'`: on an insufficient
   * balance, create the order, surface the QR via `onTopupRequired`, and
   * return a `{ status: 'topup_required', out_trade_no, code_url, pack,
   * server_url }` result WITHOUT polling — the caller confirms + retries in
   * later turns (recoverable flow for turn-based agents).
   */
  topupMode?: 'auto' | 'manual';
  /** Balance rail: pack to fund with; defaults to the server's `default_pack`. */
  topupPack?: string;
  /** Balance rail: poll interval while waiting for the top-up scan (default 2000ms). */
  topupPollIntervalMs?: number;
  /** Balance rail: called when a top-up pack QR must be shown (scan once).
   *  `outTradeNo` identifies the order — name any file written from `codeUrl`
   *  after it, since two orders for the same pack would otherwise collide. */
  onTopupRequired?: (pack: string, codeUrl: string, outTradeNo: string) => void;
  /** Balance rail: called after the top-up is credited (new balance). */
  onTopupCredited?: (balance: string) => void;
}

// x402 constants, X402PaymentRequirements, and EIP3009Authorization
// are re-exported from `../core/index.js` (imported above).

const DEFAULT_CONFIG: ClientConfig = {
  chain: 'base',
  limits: {
    maxPerTx: 100,
    maxPerDay: 1000,
  },
};

export class MoltsPayClient {
  private configDir: string;
  private config: ClientConfig;
  private walletData: WalletData | null = null;
  private wallet: Wallet | null = null;
  private signer: PaymentSigner | null = null;
  private todaySpending: number = 0;
  private lastSpendingReset: number = 0;
  private railPreference?: string[];
  private alipaySessionId?: string;

  constructor(options: MoltsPayClientOptions = {}) {
    this.configDir = options.configDir || join(homedir(), '.moltspay');
    this.config = this.loadConfig();
    // Rail preference: explicit option wins over persisted config.
    this.railPreference = options.railPreference ?? this.config.railPreference;
    this.alipaySessionId = options.alipaySessionId;
    this.walletData = this.loadWallet();
    this.loadSpending(); // Load persisted spending data

    if (this.walletData) {
      this.wallet = new Wallet(this.walletData.privateKey);
      // Signer abstracts all signing. Solana key is loaded lazily so we don't
      // touch disk for callers that only pay on EVM chains.
      const configDir = this.configDir;
      this.signer = new NodeSigner(this.wallet, {
        getSolanaKeypair: () => loadSolanaWallet(configDir),
      });
    }
  }

  /**
   * Check if client is initialized (has wallet)
   */
  get isInitialized(): boolean {
    return this.wallet !== null;
  }

  /**
   * Get wallet address
   */
  get address(): string | null {
    return this.wallet?.address || null;
  }

  /**
   * Get wallet instance (for direct operations like approvals)
   */
  getWallet(): Wallet | null {
    return this.wallet;
  }

  /**
   * Get current config
   */
  getConfig(): ClientConfig {
    return { ...this.config };
  }

  /**
   * Update config
   */
  updateConfig(updates: Partial<ClientConfig['limits']>): void {
    if (updates.maxPerTx !== undefined) {
      this.config.limits.maxPerTx = updates.maxPerTx;
    }
    if (updates.maxPerDay !== undefined) {
      this.config.limits.maxPerDay = updates.maxPerDay;
    }
    this.saveConfig();
  }

  /**
   * Get services from a provider
   */
  async getServices(serverUrl: string): Promise<ServicesResponse> {
    // Normalize URL - don't append /services if already present
    const normalizedUrl = serverUrl.replace(/\/(services|api\/services|registry\/services)\/?$/, '');
    
    // Try /services first (standard provider endpoint)
    const endpoints = ['/services', '/api/services', '/registry/services'];
    
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${normalizedUrl}${endpoint}`);
        if (!res.ok) continue;
        
        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) continue;
        
        return await res.json() as ServicesResponse;
      } catch {
        continue;
      }
    }
    
    throw new Error(`Failed to get services: no valid endpoint found at ${normalizedUrl}`);
  }

  /**
   * Pay for a service and get the result (x402 protocol)
   * 
   * This is GASLESS for the client - server pays gas to claim payment.
   * This is PAY-FOR-SUCCESS - payment only claimed if service succeeds.
   * 
   * @param serverUrl - Server URL
   * @param service - Service ID
   * @param params - Service parameters
   * @param options - Payment options (token selection)
   */
  async pay(
    serverUrl: string,
    service: string,
    params: Record<string, any>,
    options: PayOptions = {}
  ): Promise<Record<string, any>> {
    // Alipay fiat rail (2.0.0): when the caller explicitly asks for alipay,
    // dispatch BEFORE the EVM wallet check — the alipay rail is backed by
    // alipay-bot and needs no EVM wallet.
    if (options.rail === ALIPAY_RAIL) {
      return this.payViaAlipay(serverUrl, service, params, options);
    }

    // WeChat Pay Native fiat rail (2.1.0): like Alipay, dispatch before the EVM
    // wallet check — the buyer scans a QR, no crypto wallet is needed.
    if (options.rail === WECHAT_RAIL) {
      return this.payViaWechat(serverUrl, service, params, options);
    }

    // Custodial balance rail (2.2.0): password-free, needs a buyer id but no
    // EVM wallet — dispatch before the wallet check.
    if (options.rail === BALANCE_RAIL) {
      return this.payViaBalance(serverUrl, service, params, options);
    }

    if (!this.wallet || !this.walletData) {
      throw new Error('Client not initialized. Run: moltspay init');
    }

    // Step 1: Discover service endpoint
    console.log(`[MoltsPay] Requesting service: ${service}`);
    let executeUrl = `${serverUrl}/execute`;  // Default fallback
    
    try {
      const services = await this.getServices(serverUrl);
      const svc = services.services?.find((s: any) => s.id === service);
      if (svc?.endpoint) {
        // Use the endpoint from service discovery (for Cloudflare Workers, etc.)
        executeUrl = `${serverUrl}${svc.endpoint}`;
        console.log(`[MoltsPay] Using service endpoint: ${svc.endpoint}`);
      }
    } catch {
      // Fall back to /execute if service discovery fails
    }
    
    // Build request body - raw mode sends data at top level, standard mode wraps in { params }
    let requestBody: any;
    if (options.rawData) {
      // Raw mode: { service, chain, ...params } - user's data at top level
      requestBody = { service, ...params };
    } else {
      // Standard mode: { service, params } - wrapped format
      requestBody = { service, params };
    }
    if (options.chain) {
      requestBody.chain = options.chain;
    }
    const initialRes = await fetch(executeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    // If not 402, check for success or error
    if (initialRes.status !== 402) {
      const data = await initialRes.json() as any;
      if (initialRes.ok && data.result) {
        return data.result;
      }
      throw new Error(data.error || 'Unexpected response');
    }

    // Step 2: Detect protocol from 402 response
    // MPP uses WWW-Authenticate header, x402 uses X-Payment-Required header
    const wwwAuthHeader = initialRes.headers.get('www-authenticate');
    const paymentRequiredHeader = initialRes.headers.get(PAYMENT_REQUIRED_HEADER);
    
    // If WWW-Authenticate with Payment scheme, use MPP flow
    if (wwwAuthHeader && wwwAuthHeader.toLowerCase().includes('payment')) {
      console.log('[MoltsPay] Detected MPP protocol, using Tempo flow...');
      return await this.handleMPPPayment(executeUrl, service, params, wwwAuthHeader, options);
    }
    
    if (!paymentRequiredHeader) {
      throw new Error('Missing payment header (x-payment-required or www-authenticate)');
    }

    let requirements: X402PaymentRequirements[];
    try {
      const decoded = Buffer.from(paymentRequiredHeader, 'base64').toString('utf-8');
      const parsed = JSON.parse(decoded);
      
      // Handle both v1 (array) and v2 (object with accepts) formats
      if (Array.isArray(parsed)) {
        // v1 format: direct array of requirements
        requirements = parsed;
      } else if (parsed.accepts && Array.isArray(parsed.accepts)) {
        // v2 format: { x402Version: 2, accepts: [...] }
        requirements = parsed.accepts;
      } else {
        // Single requirement object
        requirements = [parsed];
      }
    } catch {
      throw new Error('Invalid x-payment-required header');
    }

    // Get server's accepted chains (uses shared core mapping — same output as 1.5.x)
    const serverChains = requirements
      .map(r => coreNetworkToChainName(r.network))
      .filter((c): c is CoreChainName => c !== null);

    // Determine which chain to use
    const userSpecifiedChain = options.chain;
    let selectedChain: string;

    if (userSpecifiedChain) {
      // User specified --chain, validate it's accepted by server
      if (!serverChains.includes(userSpecifiedChain)) {
        throw new Error(
          `Server doesn't accept '${userSpecifiedChain}'.\n` +
          `Server accepts: ${serverChains.join(', ')}`
        );
      }
      selectedChain = userSpecifiedChain;
    } else {
      // No --chain provided
      if (serverChains.length === 1 && serverChains[0] === 'base') {
        // Only default to base if server ONLY accepts base
        selectedChain = 'base';
      } else {
        throw new Error(
          `Server accepts: ${serverChains.join(', ')}\n` +
          `Please specify: --chain <chain_name>`
        );
      }
    }

    // Handle Solana chains separately
    if (selectedChain === 'solana' || selectedChain === 'solana_devnet') {
      const solanaChain = selectedChain as SolanaChainName;
      const network = solanaChain === 'solana' ? 'solana:mainnet' : 'solana:devnet';
      const req = requirements.find(r => r.network === network);
      
      if (!req) {
        throw new Error(`Failed to find payment requirement for ${selectedChain}`);
      }
      
      return await this.handleSolanaPayment(executeUrl, service, params, req, solanaChain, options);
    }

    // EVM chain handling
    const chainName = selectedChain as EvmChainName;
    const chain = getChain(chainName);
    const network = `eip155:${chain.chainId}`;
    const req = requirements.find(r => r.scheme === 'exact' && r.network === network);

    if (!req) {
      throw new Error(`Failed to find payment requirement for ${chainName}`);
    }

    // Step 3: Check limits
    // v2 uses 'amount', v1 uses 'maxAmountRequired'
    const amountRaw = req.amount || req.maxAmountRequired;
    if (!amountRaw) {
      throw new Error('Missing amount in payment requirements');
    }
    const amount = Number(amountRaw) / 1e6;
    this.checkLimits(amount);

    // Determine which token to use
    let token: TokenSymbol = options.token || 'USDC';
    
    // Auto-select token based on balance if requested
    if (options.autoSelect) {
      const balances = await this.getBalance();
      if (balances.usdc >= amount) {
        token = 'USDC';
      } else if (balances.usdt >= amount) {
        token = 'USDT';
      } else {
        throw new Error(`Insufficient balance: need $${amount}, have ${balances.usdc} USDC / ${balances.usdt} USDT`);
      }
    }

    // USDT does not support gasless transfers (no EIP-2612 permit)
    // It requires on-chain approve + transfer, meaning the user pays gas
    if (token === 'USDT') {
      const balances = await this.getBalance();
      if (balances.native < 0.0001) {
        throw new Error(
          `USDT requires ETH for gas (~$0.01 on Base). ` +
          `Your ETH balance: ${balances.native.toFixed(6)} ETH. ` +
          `Please add a small amount of ETH to your wallet, or use USDC (gasless).`
        );
      }
      console.log(`[MoltsPay] ⚠️  USDT requires gas (~$0.01). Proceeding with payment...`);
    } else {
      console.log(`[MoltsPay] Signing payment: $${amount} ${token} (gasless)`);
    }

    // BNB chains use intent-based flow (pre-approval + intent signature)
    if (chainName === 'bnb' || chainName === 'bnb_testnet') {
      console.log(`[MoltsPay] Using BNB intent-based payment flow...`);
      const payTo = req.payTo || req.resource;
      if (!payTo) {
        throw new Error('Missing payTo address in payment requirements');
      }
      // Get spender address from server response (dynamic, not hardcoded)
      const bnbSpender = (req.extra as any)?.bnbSpender;
      if (!bnbSpender) {
        throw new Error('Server did not provide bnbSpender address. Server may not support BNB payments.');
      }
      return await this.handleBNBPayment(executeUrl, service, params, {
        to: payTo,
        amount,
        token,
        chainName,
        chain,
        spender: bnbSpender,
      }, options);
    }

    // Step 4: Sign EIP-3009 authorization (GASLESS - just signing)
    // payTo is the recipient address (v2 format)
    const payTo = req.payTo || req.resource; // fallback for v1 compatibility
    if (!payTo) {
      throw new Error('Missing payTo address in payment requirements');
    }
    
    // Use server's extra field for domain info (contains correct EIP-712 domain for the token on this network)
    const domainOverride = (req.extra && typeof req.extra === 'object' && req.extra.name) 
      ? { name: req.extra.name as string, version: (req.extra.version as string) || '2' }
      : undefined;
    
    const authorization = await this.signEIP3009(payTo, amount, chain, token, domainOverride);

    // Get token-specific info for accepted field
    const tokenConfig = chain.tokens[token];

    // Step 5: Create x402 payment payload (v2 requires scheme, network, payload, AND accepted)
    // Use server's extra field if provided (contains correct EIP-712 domain for the token on this network)
    // Fall back to local config for backward compatibility
    const extra = (req.extra && typeof req.extra === 'object') 
      ? req.extra 
      : {
          name: (tokenConfig as any).eip712Name || 'USD Coin',
          version: '2',
        };
    
    const payload = {
      x402Version: X402_VERSION,
      scheme: 'exact',
      network,
      payload: authorization, // { authorization: {...}, signature: "0x..." }
      accepted: {
        scheme: 'exact',
        network,
        asset: tokenConfig.address,
        amount: amountRaw,
        payTo,
        maxTimeoutSeconds: req.maxTimeoutSeconds || 300,
        extra,
      },
    };
    const paymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');

    // Step 6: Retry with payment header
    console.log(`[MoltsPay] Sending request with payment...`);
    const paidRequestBody: any = options.rawData
      ? { service, ...params }
      : { service, params };
    if (options.chain) {
      paidRequestBody.chain = options.chain;
    }
    const paidRes = await fetch(executeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PAYMENT_HEADER]: paymentHeader,
      },
      body: JSON.stringify(paidRequestBody),
    });

    const result = await paidRes.json() as any;

    if (!paidRes.ok) {
      throw new Error(result.error || 'Service execution failed');
    }

    // Update spending tracking
    this.recordSpending(amount);

    console.log(`[MoltsPay] Success! Payment: ${result.payment?.status || 'claimed'}`);

    // Support both MoltsPay Server format ({ result: ... }) and direct response format
    return result.result || result;
  }

  /**
   * Pay for a service over the Alipay fiat rail (2.0.0).
   *
   * Unlike the crypto path this needs no EVM wallet — it shells out to
   * alipay-bot via {@link AlipayClient}. Flow: hit the resource with no
   * payment to get the 402 challenge, confirm the server actually offers the
   * alipay rail (selectRail), then run the 8-step state machine and return the
   * resource body.
   */
  private async payViaAlipay(
    serverUrl: string,
    service: string,
    params: Record<string, any>,
    options: PayOptions,
  ): Promise<Record<string, any>> {
    // Flow correlation id for the pre-spawn (local) timing nodes.
    const flow = this.alipaySessionId;

    // Discover the resource endpoint (same as the crypto path).
    let executeUrl = `${serverUrl}/execute`;
    try {
      const services = await timeStep('discover-services', flow, () =>
        this.getServices(serverUrl),
      );
      const svc = services.services?.find((s: any) => s.id === service);
      if (svc?.endpoint) executeUrl = `${serverUrl}${svc.endpoint}`;
    } catch {
      // Fall back to /execute.
    }

    const requestBody: any = options.rawData ? { service, ...params } : { service, params };
    const bodyJson = JSON.stringify(requestBody);

    // Trigger the 402 challenge.
    const res = await timeStep('challenge-402', flow, () =>
      fetch(executeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyJson,
      }),
    );
    if (res.status !== 402) {
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data as any).result) return (data as any).result;
      throw new Error((data as any).error || `Expected 402, got ${res.status}`);
    }

    const header = res.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!header) throw new Error('Missing x-payment-required header on 402');
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    const accepts: X402PaymentRequirements[] = Array.isArray(parsed)
      ? parsed
      : parsed.accepts ?? [parsed];

    // Confirm the server offers alipay (throws UnsupportedRailError otherwise).
    const { requirement } = selectRail({
      serverAccepts: accepts,
      explicitRail: ALIPAY_RAIL,
      preference: this.railPreference,
      availability: { evmReady: this.isInitialized },
    });

    const onLine = options.onLine ?? ((line: string) => process.stdout.write(line + '\n'));
    const alipay = new AlipayClient({
      sessionId: this.alipaySessionId,
      configDir: this.configDir,
    });
    const result = await alipay.pay402({
      resourceUrl: executeUrl,
      requirement,
      method: 'POST',
      data: bodyJson,
      onLine,
      onPaymentPending: options.onPaymentPending,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    // Best-effort: parse a JSON body, else return it raw under `body`.
    try {
      const json = JSON.parse(result.body);
      return json.result ?? json;
    } catch {
      return { body: result.body, payment: result.payment, media: result.media };
    }
  }

  /**
   * Pay for a service over the WeChat Pay Native fiat rail (2.1.0).
   *
   * Mirrors {@link payViaAlipay} and needs no EVM wallet. The server placed the
   * Native order when it built the 402, so its `wechatpay-native` accepts[]
   * entry already carries `extra.code_url` + `extra.out_trade_no`. Flow: hit the
   * resource to get the 402, confirm the server offers the wechat rail, surface
   * the code_url (caller renders a QR), then poll the resource with the
   * out_trade_no proof until the server verifies the order paid and delivers.
   */
  private async payViaWechat(
    serverUrl: string,
    service: string,
    params: Record<string, any>,
    options: PayOptions,
  ): Promise<Record<string, any>> {
    const session = await this.startWechatPayment(serverUrl, service, params, options);

    const wechat = new WechatClient({ configDir: this.configDir });
    const result = await wechat.pollSession(session.paymentSessionId, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });

    if (result.status !== 'completed') {
      throw new Error(result.lastError || `WeChat payment ended with status ${result.status}`);
    }

    // Best-effort: parse a JSON body, else return it raw under `body`.
    try {
      const json = JSON.parse(result.resultBody ?? '');
      return json.result ?? json;
    } catch {
      return { body: result.resultBody ?? '' };
    }
  }

  /**
   * The ethers wallet used to sign balance-rail deductions: the client's EVM
   * wallet if it has one, else a per-configDir identity key persisted at
   * `<configDir>/balance-identity.key` (0600) so a balance-only client works
   * without a full crypto wallet. Under `agent 统一代付`, one key spends every
   * account the agent tops up.
   */
  private balanceSigner(): Wallet {
    if (this.wallet) return this.wallet;
    const p = join(this.configDir, 'balance-identity.key');
    let pk: string;
    if (existsSync(p)) {
      pk = readFileSync(p, 'utf-8').trim();
    } else {
      mkdirSync(this.configDir, { recursive: true });
      pk = Wallet.createRandom().privateKey;
      writeFileSync(p, pk, { mode: 0o600 });
    }
    return new Wallet(pk);
  }

  /** The balance-rail spending signer address (lowercase 0x…). Stable per
   *  configDir; this is the identity the server TOFU-binds and later verifies. */
  getBalanceSignerAddress(): string {
    return this.balanceSigner().address.toLowerCase();
  }

  /** The buyer id for the balance rail: explicit option > persisted config. */
  private resolveBuyerId(explicit?: string): string {
    const buyerId = explicit ?? this.config.buyerId;
    if (!buyerId) {
      throw new Error(
        'Balance rail needs a buyer id. Pass { buyerId } or persist one with setBuyerId().'
      );
    }
    return buyerId;
  }

  /**
   * Pay via the custodial balance rail (2.2.0, password-free).
   *
   * No wallet, no QR: the request carries `{buyer_id, request_id}` in the
   * X-Payment payload and the server deducts the prepaid balance atomically
   * before running the skill. The client-generated `request_id` makes the
   * charge idempotent — a network retry can never double-deduct.
   */
  private async payViaBalance(
    serverUrl: string,
    service: string,
    params: Record<string, any>,
    options: PayOptions,
  ): Promise<Record<string, any>> {
    const buyerId = this.resolveBuyerId(options.buyerId);

    // First attempt: password-free deduct.
    let attempt = await this.balanceDeduct(serverUrl, service, params, options, buyerId);
    if (attempt.ok) return attempt.result;

    // Recoverable via a top-up: an empty account (buyer_not_found) or a short
    // balance (insufficient_balance). Limit/frozen errors are not -- topping up
    // would not help -- so they fail fast.
    const fundable = attempt.status === 402 && (
      attempt.code === 'buyer_not_found' || attempt.code === 'insufficient_balance' ||
      /insufficient balance|unknown buyer|top up first/i.test(attempt.error || '')
    );
    if (!fundable || options.autoTopup === false) {
      throw new Error(attempt.error || `Balance payment failed with HTTP ${attempt.status}`);
    }

    // Manual mode (recoverable): create the order, surface the QR, and return a
    // topup_required result without blocking. The caller confirms + retries.
    if (options.topupMode === 'manual') {
      const order = await this.createBalanceTopupOrder(serverUrl, {
        pack: options.topupPack,
        buyerId,
        context: { service },
      });
      options.onTopupRequired?.(order.pack, order.codeUrl, order.outTradeNo);
      return {
        status: 'topup_required',
        out_trade_no: order.outTradeNo,
        code_url: order.codeUrl,
        pack: order.pack,
        server_url: serverUrl,
      };
    }

    const credited = await this.topupBalancePack(serverUrl, {
      pack: options.topupPack,
      buyerId,
      pollIntervalMs: options.topupPollIntervalMs,
      signal: options.signal,
      onCodeUrl: (pack, codeUrl, outTradeNo) => options.onTopupRequired?.(pack, codeUrl, outTradeNo),
    });
    options.onTopupCredited?.(credited.balance);

    attempt = await this.balanceDeduct(serverUrl, service, params, options, buyerId);
    if (attempt.ok) return attempt.result;
    throw new Error(attempt.error || 'Balance payment failed after top-up');
  }

  /** One password-free deduct attempt. Never throws on an HTTP error; the
   *  caller inspects `{ ok, status, error }` to decide whether to auto-fund. */
  private async balanceDeduct(
    serverUrl: string,
    service: string,
    params: Record<string, any>,
    options: PayOptions,
    buyerId: string,
  ): Promise<{ ok: boolean; result?: any; status: number; error?: string; code?: string }> {
    // Discover the resource endpoint (same as the other rails).
    let executeUrl = `${serverUrl}/execute`;
    try {
      const services = await this.getServices(serverUrl);
      const svc = services.services?.find((s: any) => s.id === service);
      if (svc?.endpoint) executeUrl = `${serverUrl}${svc.endpoint}`;
    } catch {
      // Fall back to /execute.
    }

    const requestBody: any = options.rawData ? { service, ...params } : { service, params };
    // Sign the deduction (user auth): the server recovers the signer address
    // and TOFU-binds / checks it per its auth_mode. request_id is the
    // idempotency key and part of the signed message.
    const requestId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await this.balanceSigner().signMessage(
      buildDeductMessage({ buyerId, requestId, service, timestamp }),
    );
    const xPayment = Buffer.from(JSON.stringify({
      x402Version: 2,
      scheme: BALANCE_RAIL,
      network: BALANCE_RAIL,
      payload: { buyer_id: buyerId, request_id: requestId, auth: { timestamp, signature } },
    })).toString('base64');

    const res = await fetch(executeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Payment': xPayment },
      body: JSON.stringify(requestBody),
      signal: options.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, error: data.error, code: data.code };
    return { ok: true, status: res.status, result: data.result ?? data };
  }

  /**
   * Non-blocking: POST /balance/topup/order, persist a recoverable session, and
   * return at once (no polling). Use with {@link confirmBalanceTopup} for
   * turn-based agents; the blocking {@link topupBalancePack} is built on this.
   */
  async createBalanceTopupOrder(
    serverUrl: string,
    opts: { pack?: string; buyerId?: string; context?: Record<string, any> } = {},
  ): Promise<{ outTradeNo: string; codeUrl: string; pack: string; maxTimeoutSeconds: number }> {
    const id = this.resolveBuyerId(opts.buyerId);
    const orderRes = await fetch(`${serverUrl}/balance/topup/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Carry the spending signer so the server binds it to the account on
      // confirm (topup-time binding). The same key signs deductions later.
      body: JSON.stringify({ buyer_id: id, pack: opts.pack, signer_address: this.getBalanceSignerAddress() }),
    });
    const order: any = await orderRes.json().catch(() => ({}));
    if (!orderRes.ok) throw new Error(order.error || `Top-up order failed with HTTP ${orderRes.status}`);

    const maxTimeoutSeconds = order.max_timeout_seconds ?? 300;
    const now = Date.now();
    this.saveBalanceTopupSession({
      out_trade_no: order.out_trade_no,
      buyer_id: id,
      pack: order.pack,
      server_url: serverUrl,
      code_url: order.code_url,
      status: 'pending',
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + maxTimeoutSeconds * 1000).toISOString(),
      context: opts.context,
    });
    return { outTradeNo: order.out_trade_no, codeUrl: order.code_url, pack: order.pack, maxTimeoutSeconds };
  }

  /**
   * One-shot: POST /balance/topup/confirm for a single order. No polling.
   * Updates the persisted session on credit. `serverUrl` defaults to the one
   * recorded in the session (recover by out_trade_no alone).
   */
  async confirmBalanceTopup(
    outTradeNo: string,
    opts: { serverUrl?: string } = {},
  ): Promise<{ credited: boolean; pending?: boolean; balance?: string; txId?: string; reason?: string }> {
    const session = this.getBalanceTopupSession(outTradeNo);
    const serverUrl = opts.serverUrl || session?.server_url;
    if (!serverUrl) {
      return { credited: false, reason: `No server URL for ${outTradeNo}: pass serverUrl or run topup-order first` };
    }
    const confRes = await fetch(`${serverUrl}/balance/topup/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ out_trade_no: outTradeNo }),
    });
    const conf: any = await confRes.json().catch(() => ({}));
    if (!confRes.ok) return { credited: false, reason: conf.error || `Confirm failed with HTTP ${confRes.status}` };
    if (conf.credited) {
      if (session) {
        session.status = 'credited';
        session.tx_id = conf.tx_id;
        session.balance = conf.balance;
        this.saveBalanceTopupSession(session);
      }
      return { credited: true, balance: conf.balance, txId: conf.tx_id };
    }
    return { credited: false, pending: !!conf.pending, reason: conf.reason };
  }

  /**
   * Blocking terminal wrapper: create the order then poll confirm until the
   * scan is credited (or the order expires). Built on
   * {@link createBalanceTopupOrder} + {@link confirmBalanceTopup}.
   */
  async topupBalancePack(
    serverUrl: string,
    opts: {
      pack?: string;
      buyerId?: string;
      pollIntervalMs?: number;
      signal?: AbortSignal;
      onCodeUrl?: (pack: string, codeUrl: string, outTradeNo: string) => void;
    } = {},
  ): Promise<{ balance: string; outTradeNo: string; txId?: string }> {
    const order = await this.createBalanceTopupOrder(serverUrl, { pack: opts.pack, buyerId: opts.buyerId });
    opts.onCodeUrl?.(order.pack, order.codeUrl, order.outTradeNo);

    const interval = opts.pollIntervalMs ?? 2000;
    const deadline = Date.now() + order.maxTimeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('Top-up aborted');
      const conf = await this.confirmBalanceTopup(order.outTradeNo, { serverUrl });
      if (conf.credited) return { balance: conf.balance!, outTradeNo: order.outTradeNo, txId: conf.txId };
      await this.sleep(interval, opts.signal);
    }
    throw new Error('Top-up timed out before the payment was confirmed');
  }

  // --- Recoverable balance top-up sessions (<configDir>/balance-topup-sessions) ---

  private balanceTopupSessionDir(): string {
    return join(this.configDir, 'balance-topup-sessions');
  }

  private saveBalanceTopupSession(session: BalanceTopupSession): void {
    const dir = this.balanceTopupSessionDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${session.out_trade_no}.json`), JSON.stringify(session, null, 2));
  }

  /** Read a persisted top-up session by out_trade_no, or null. */
  getBalanceTopupSession(outTradeNo: string): BalanceTopupSession | null {
    const p = join(this.balanceTopupSessionDir(), `${outTradeNo}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as BalanceTopupSession;
    } catch {
      return null;
    }
  }

  /** List persisted top-up sessions, newest first. */
  listBalanceTopupSessions(): BalanceTopupSession[] {
    const dir = this.balanceTopupSessionDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as BalanceTopupSession; } catch { return null; }
      })
      .filter((s): s is BalanceTopupSession => s !== null)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  }

  /** Abortable sleep used by the top-up poll loop. */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('aborted'));
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
  }

  /** Persist the buyer id used by the balance rail (bearer semantics). */
  setBuyerId(buyerId: string): void {
    this.config.buyerId = buyerId;
    this.saveConfig();
  }

  /** GET /balance — custodial balance, limits, and today's spend for a buyer. */
  async getBuyerBalance(serverUrl: string, buyerId?: string): Promise<Record<string, any>> {
    const id = this.resolveBuyerId(buyerId);
    const res = await fetch(`${serverUrl}/balance?buyer_id=${encodeURIComponent(id)}`);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Balance query failed with HTTP ${res.status}`);
    return data;
  }

  /**
   * POST /balance/topup — report an externally settled payment (on-chain
   * tx hash / Alipay trade_no / WeChat out_trade_no) so the server verifies
   * and credits the ledger. Idempotent per reference.
   */
  async topupBalance(
    serverUrl: string,
    opts: {
      rail: 'crypto' | 'alipay' | 'wechat';
      amount: string;
      buyerId?: string;
      txHash?: string;
      chain?: string;
      tradeNo?: string;
      outTradeNo?: string;
    }
  ): Promise<Record<string, any>> {
    const id = this.resolveBuyerId(opts.buyerId);
    const res = await fetch(`${serverUrl}/balance/topup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        buyer_id: id,
        rail: opts.rail,
        amount: opts.amount,
        tx_hash: opts.txHash,
        chain: opts.chain,
        trade_no: opts.tradeNo,
        out_trade_no: opts.outTradeNo,
      }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Top-up failed with HTTP ${res.status}`);
    return data;
  }

  /** GET /balance/transactions — ledger history for a buyer, newest first. */
  async listBalanceTransactions(
    serverUrl: string,
    opts: { buyerId?: string; limit?: number; offset?: number } = {}
  ): Promise<Record<string, any>> {
    const id = this.resolveBuyerId(opts.buyerId);
    const qs = new URLSearchParams({ buyer_id: id });
    if (opts.limit) qs.set('limit', String(opts.limit));
    if (opts.offset) qs.set('offset', String(opts.offset));
    const res = await fetch(`${serverUrl}/balance/transactions?${qs}`);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Transaction query failed with HTTP ${res.status}`);
    return data;
  }

  /**
   * Start a recoverable WeChat Pay Native session and return immediately with
   * QR metadata. The SDK client persists enough context to poll/fulfill later.
   */
  async startWechatPayment(
    serverUrl: string,
    service: string,
    params: Record<string, any>,
    options: PayOptions = {},
  ): Promise<WechatPaymentSession> {
    // Discover the resource endpoint (same as the crypto/alipay path).
    let executeUrl = `${serverUrl}/execute`;
    try {
      const services = await this.getServices(serverUrl);
      const svc = services.services?.find((s: any) => s.id === service);
      if (svc?.endpoint) executeUrl = `${serverUrl}${svc.endpoint}`;
    } catch {
      // Fall back to /execute.
    }

    const requestBody: any = options.rawData ? { service, ...params } : { service, params };
    const bodyJson = JSON.stringify(requestBody);

    // Trigger the 402 challenge (this is also what created the Native order).
    const res = await fetch(executeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyJson,
    });
    if (res.status !== 402) {
      const data = await res.json().catch(() => ({}));
      if (res.ok && (data as any).result) return (data as any).result;
      throw new Error((data as any).error || `Expected 402, got ${res.status}`);
    }

    const header = res.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!header) throw new Error('Missing x-payment-required header on 402');
    const parsed = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    const accepts: X402PaymentRequirements[] = Array.isArray(parsed)
      ? parsed
      : parsed.accepts ?? [parsed];

    // Confirm the server offers wechat (throws UnsupportedRailError otherwise).
    const { requirement } = selectRail({
      serverAccepts: accepts,
      explicitRail: WECHAT_RAIL,
      preference: this.railPreference,
      availability: { evmReady: this.isInitialized },
    });

    const wechat = new WechatClient({ configDir: this.configDir });
    const session = wechat.start402({
      resourceUrl: executeUrl,
      requirement,
      method: 'POST',
      data: bodyJson,
      onPaymentPending: options.onPaymentPending
        ? (info) => options.onPaymentPending!({ paymentUrl: info.codeUrl, tradeNo: info.outTradeNo })
        : undefined,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      context: {
        serverUrl,
        service,
        params,
        rawData: options.rawData ?? false,
        rail: WECHAT_RAIL,
      },
    });

    if (options.autoPoll || options.onWechatPaymentCompleted || options.onWechatPaymentFailed) {
      void wechat.pollSession(session.paymentSessionId, {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      }).then(async (finalSession) => {
        if (finalSession.status === 'completed') {
          await options.onWechatPaymentCompleted?.(finalSession);
        } else {
          await options.onWechatPaymentFailed?.(finalSession);
        }
      }).catch(async (error: unknown) => {
        const failed = await wechat.fulfill(session.paymentSessionId).catch(() => ({
          ...session,
          status: 'failed' as const,
          lastError: error instanceof Error ? error.message : String(error),
        }));
        await options.onWechatPaymentFailed?.(failed);
      });
    }

    return session;
  }

  /**
   * Query a persisted WeChat session once. This is also the fulfillment step:
   * on a 200 it stores the result body and marks the session completed, and a
   * completed session returns that stored body without another request.
   */
  async getWechatPaymentStatus(identifier: string): Promise<WechatPaymentSession> {
    return new WechatClient({ configDir: this.configDir }).status(identifier);
  }

  /** @deprecated Alias for {@link getWechatPaymentStatus} — querying is what fulfills. */
  async fulfillWechatPayment(identifier: string): Promise<WechatPaymentSession> {
    return this.getWechatPaymentStatus(identifier);
  }

  /** Mark a local WeChat session as cancelled. */
  cancelWechatPayment(identifier: string): WechatPaymentSession {
    return new WechatClient({ configDir: this.configDir }).cancel(identifier);
  }

  /** List persisted WeChat sessions, newest first. */
  listWechatPaymentSessions(): WechatPaymentSession[] {
    return new WechatClient({ configDir: this.configDir }).listSessions();
  }

  /**
   * Handle MPP (Machine Payments Protocol) payment flow
   * Called when pay() detects WWW-Authenticate header in 402 response
   */
  private async handleMPPPayment(
    executeUrl: string,
    service: string,
    params: Record<string, any>,
    wwwAuthHeader: string,
    options: PayOptions = {}
  ): Promise<Record<string, any>> {
    // Dynamic imports for ESM-only packages
    const { privateKeyToAccount } = await import('viem/accounts');
    const { createWalletClient, createPublicClient, http } = await import('viem');
    const { tempoModerato } = await import('viem/chains');
    const { Actions } = await import('viem/tempo');

    // Get private key from wallet data
    const privateKey = this.walletData!.privateKey as `0x${string}`;
    const account = privateKeyToAccount(privateKey);

    console.log(`[MoltsPay] Using MPP protocol on Tempo`);
    console.log(`[MoltsPay] Account: ${account.address}`);

    // Parse WWW-Authenticate: Payment id="...", method="tempo", request="..."
    const parseAuthParam = (header: string, key: string): string | null => {
      const match = header.match(new RegExp(`${key}="([^"]+)"`, 'i'));
      return match ? match[1] : null;
    };

    const challengeId = parseAuthParam(wwwAuthHeader, 'id');
    const method = parseAuthParam(wwwAuthHeader, 'method');
    const realm = parseAuthParam(wwwAuthHeader, 'realm');
    const requestB64 = parseAuthParam(wwwAuthHeader, 'request');

    if (method !== 'tempo') {
      throw new Error(`Unsupported payment method: ${method}`);
    }

    if (!requestB64) {
      throw new Error('Missing request in WWW-Authenticate');
    }

    // Decode payment request
    const requestJson = Buffer.from(requestB64, 'base64').toString('utf-8');
    const paymentRequest = JSON.parse(requestJson);
    
    const { amount, currency, recipient, methodDetails } = paymentRequest;
    const chainId = methodDetails?.chainId || 42431;
    const amountDisplay = Number(amount) / 1e6;

    console.log(`[MoltsPay] Payment: $${amountDisplay} to ${recipient}`);

    // Check limits
    this.checkLimits(amountDisplay);

    // Execute transfer on Tempo
    console.log(`[MoltsPay] Sending transaction on Tempo...`);

    const tempoChain = { ...tempoModerato, feeToken: currency as `0x${string}` };
    
    const publicClient = createPublicClient({
      chain: tempoChain,
      transport: http('https://rpc.moderato.tempo.xyz'),
    });

    const walletClient = createWalletClient({
      account,
      chain: tempoChain,
      transport: http('https://rpc.moderato.tempo.xyz'),
    });

    // TIP-20 transfer
    const txHash = await Actions.token.transfer(walletClient, {
      to: recipient as `0x${string}`,
      amount: BigInt(amount),
      token: currency as `0x${string}`,
    });

    console.log(`[MoltsPay] Transaction: ${txHash}`);

    // Wait for confirmation
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`[MoltsPay] Confirmed! Retrying with credential...`);

    // Build credential
    const credential = {
      challenge: {
        id: challengeId,
        realm,
        method: 'tempo',
        intent: 'charge',
        request: paymentRequest,
      },
      payload: { hash: txHash, type: 'hash' },
      source: `did:pkh:eip155:${chainId}:${account.address}`,
    };

    const credentialB64 = Buffer.from(JSON.stringify(credential))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // Retry with credential - respect rawData option
    const retryBody = options.rawData 
      ? { service, ...params, chain: 'tempo_moderato' }
      : { service, params, chain: 'tempo_moderato' };
    
    const paidRes = await fetch(executeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Payment ${credentialB64}`,
      },
      body: JSON.stringify(retryBody),
    });

    const result = await paidRes.json() as any;

    if (!paidRes.ok) {
      throw new Error(result.error || 'Payment verification failed');
    }

    // Update spending tracking
    this.recordSpending(amountDisplay);

    console.log(`[MoltsPay] Success!`);
    return result.result || result;
  }

  /**
   * Handle BNB Chain payment flow (pre-approval + intent signature)
   * 
   * Flow:
   * 1. Check client has approved server wallet (done via `moltspay init`)
   * 2. Sign EIP-712 payment intent (no gas, just signature)
   * 3. Send intent to server
   * 4. Server executes service
   * 5. Server calls transferFrom if successful (pay-for-success)
   */
  private async handleBNBPayment(
    executeUrl: string,
    service: string,
    params: Record<string, any>,
    paymentDetails: {
      to: string;
      amount: number;
      token: TokenSymbol;
      chainName: ChainName;
      chain: ChainConfig;
      spender: string;
    },
    options: PayOptions = {}
  ): Promise<Record<string, any>> {
    const { to, amount, token, chainName, chain, spender } = paymentDetails;
    const tokenConfig = chain.tokens[token];
    
    // Check approval status
    const provider = new ethers.JsonRpcProvider(chain.rpc);
    const allowance = await this.checkAllowance(tokenConfig.address, spender, provider);
    const amountWeiCheck = BigInt(Math.floor(amount * (10 ** tokenConfig.decimals)));
    
    if (allowance < amountWeiCheck) {
      // Check if user has enough BNB for gas to approve
      const nativeBalance = await provider.getBalance(this.wallet!.address);
      const minGasBalance = ethers.parseEther('0.0005'); // ~0.0005 BNB minimum for approval
      
      if (nativeBalance < minGasBalance) {
        const nativeBNB = parseFloat(ethers.formatEther(nativeBalance)).toFixed(4);
        const isTestnet = chainName === 'bnb_testnet';
        
        if (isTestnet) {
          throw new Error(
            `❌ Insufficient tBNB for approval transaction\n\n` +
            `   Current tBNB: ${nativeBNB}\n` +
            `   Required:     ~0.001 tBNB\n\n` +
            `   Get testnet tokens: moltspay faucet --chain bnb_testnet\n` +
            `   (Gives USDC + tBNB for gas)`
          );
        } else {
          throw new Error(
            `❌ Insufficient BNB for approval transaction\n\n` +
            `   Current BNB: ${nativeBNB}\n` +
            `   Required:    ~0.001 BNB (~$0.60)\n\n` +
            `   To get BNB:\n` +
            `   • Withdraw from Binance/exchange to your wallet\n` +
            `   • Most exchanges include BNB dust with withdrawals\n\n` +
            `   After funding, run:\n` +
            `   moltspay approve --chain ${chainName} --spender ${spender}`
          );
        }
      }
      
      throw new Error(
        `Insufficient allowance for ${spender.slice(0, 10)}...\n` +
        `Run: moltspay approve --chain ${chainName} --spender ${spender}`
      );
    }
    
    // Convert amount to wei (BNB uses 18 decimals)
    const amountWei = BigInt(Math.floor(amount * (10 ** tokenConfig.decimals))).toString();

    // Build PaymentIntent envelope via shared core builder, sign through PaymentSigner.
    const intentNonce = Date.now();
    const intentDeadline = Date.now() + 3600000; // 1 hour
    const envelope = buildBnbIntentTypedData({
      from: this.wallet!.address,
      to,
      amount: amountWei,
      tokenAddress: tokenConfig.address,
      service,
      nonce: intentNonce,
      deadline: intentDeadline,
      chainId: chain.chainId,
    });

    console.log(`[MoltsPay] Signing BNB payment intent...`);
    const signature = await this.signer!.signTypedData(envelope);
    const intent = envelope.message;

    // Create x402 payment payload with BNB-specific format
    const network = `eip155:${chain.chainId}`;
    const payload = {
      x402Version: 2,
      scheme: 'exact',
      network,
      payload: {
        intent: {
          ...intent,
          signature,
        },
        chainId: chain.chainId,
      },
      accepted: {
        scheme: 'exact',
        network,
        asset: tokenConfig.address,
        amount: amountWei,
        payTo: to,
        maxTimeoutSeconds: 300,
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');

    // Send request with payment - respect rawData option
    console.log(`[MoltsPay] Sending BNB payment request...`);
    const bnbRequestBody = options.rawData
      ? { service, ...params, chain: chainName }
      : { service, params, chain: chainName };
    const paidRes = await fetch(executeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': paymentHeader,
      },
      body: JSON.stringify(bnbRequestBody),
    });

    const result = await paidRes.json() as any;

    if (!paidRes.ok) {
      throw new Error(result.error || 'BNB payment failed');
    }

    // Update spending tracking
    this.recordSpending(amount);

    console.log(`[MoltsPay] Success! BNB payment settled.`);
    return result.result || result;
  }

  /**
   * Handle Solana payment flow
   * 
   * Solana uses SPL token transfers with pay-for-success model:
   * 1. Client creates and signs a transfer transaction
   * 2. Server submits the transaction after service completes
   */
  private async handleSolanaPayment(
    executeUrl: string,
    service: string,
    params: Record<string, any>,
    requirements: X402PaymentRequirements,
    chain: SolanaChainName,
    options: PayOptions = {}
  ): Promise<Record<string, any>> {
    // Load Solana wallet
    const solanaWallet = loadSolanaWallet(this.configDir);
    if (!solanaWallet) {
      throw new Error('No Solana wallet found. Run: moltspay init --chain solana_devnet');
    }

    const amount = Number(requirements.amount);
    const amountUSDC = amount / 1e6;
    
    // Check limits
    this.checkLimits(amountUSDC);

    console.log(`[MoltsPay] Creating Solana payment: $${amountUSDC} USDC`);

    // Validate payTo address
    if (!requirements.payTo) {
      throw new Error('Missing payTo address in payment requirements');
    }

    // Check for gasless mode (server pays fees)
    const solanaFeePayer = (requirements.extra as any)?.solanaFeePayer;
    const feePayerPubkey = solanaFeePayer ? new PublicKey(solanaFeePayer) : undefined;
    
    if (feePayerPubkey) {
      console.log(`[MoltsPay] Gasless mode: server pays fees`);
    }

    // Create the transfer transaction
    const recipientPubkey = new PublicKey(requirements.payTo);
    const transaction = await createSolanaPaymentTransaction(
      solanaWallet.publicKey,
      recipientPubkey,
      BigInt(amount),
      chain,
      feePayerPubkey  // Optional fee payer for gasless mode
    );

    // Sign the transaction through PaymentSigner (partial sign in gasless mode).
    // Serializing before signing keeps the Web Client (Phase 4) wallet-adapter
    // flow identical to this one.
    const unsignedBase64 = transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
    const signedTx = await this.signer!.signSolanaTransaction!({
      transactionBase64: unsignedBase64,
      partialSign: !!feePayerPubkey,
    });

    console.log(`[MoltsPay] Transaction signed, sending to server...`);

    // Create x402 payload with Solana-specific format
    const network = chain === 'solana' ? 'solana:mainnet' : 'solana:devnet';
    const payload = {
      x402Version: 2,
      scheme: 'exact',
      network,
      payload: {
        signedTransaction: signedTx,
        sender: solanaWallet.publicKey.toBase58(),
        chain,
      },
      accepted: {
        scheme: 'exact',
        network,
        asset: requirements.asset,
        amount: requirements.amount,
        payTo: requirements.payTo,
        maxTimeoutSeconds: 300,
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');

    // Send request with payment - respect rawData option
    const solanaRequestBody = options.rawData
      ? { service, ...params, chain }
      : { service, params, chain };
    const paidRes = await fetch(executeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': paymentHeader,
      },
      body: JSON.stringify(solanaRequestBody),
    });

    const result = await paidRes.json() as any;

    if (!paidRes.ok) {
      throw new Error(result.error || 'Solana payment failed');
    }

    // Update spending tracking
    this.recordSpending(amountUSDC);

    console.log(`[MoltsPay] Success! Solana payment settled.`);
    if (result.payment?.transaction) {
      const explorerUrl = chain === 'solana' 
        ? `https://solscan.io/tx/${result.payment.transaction}`
        : `https://solscan.io/tx/${result.payment.transaction}?cluster=devnet`;
      console.log(`[MoltsPay] Transaction: ${explorerUrl}`);
    }

    return result.result || result;
  }

  /**
   * Check ERC20 allowance for a spender
   */
  private async checkAllowance(
    tokenAddress: string,
    spender: string,
    provider: ethers.JsonRpcProvider
  ): Promise<bigint> {
    const contract = new ethers.Contract(
      tokenAddress,
      ['function allowance(address owner, address spender) view returns (uint256)'],
      provider
    );
    return await contract.allowance(this.wallet!.address, spender);
  }

  /**
   * Sign EIP-3009 transferWithAuthorization (GASLESS)
   * This only signs - no on-chain transaction, no gas needed.
   * Supports both USDC and USDT.
   *
   * Delegates typed-data construction to `core/eip3009.ts` and the signature
   * itself to `this.signer`. That way Web Client (Phase 4) can reuse the same
   * flow with an EIP-1193 signer without duplicating typed-data layout.
   */
  private async signEIP3009(
    to: string,
    amount: number,
    chain: { chainId: number; tokens: Record<TokenSymbol, { address: string; decimals: number }> },
    token: TokenSymbol = 'USDC',
    domainOverride?: { name: string; version: string }
  ): Promise<{ authorization: EIP3009Authorization; signature: string }> {
    const tokenConfig = chain.tokens[token];
    const value = BigInt(Math.floor(amount * (10 ** tokenConfig.decimals))).toString();
    const nonce = ethers.hexlify(ethers.randomBytes(32));

    // EIP-712 domain - use server's domain info if provided (handles mainnet vs testnet differences)
    // Fall back to local token config for backward compatibility.
    const tokenName = domainOverride?.name || (tokenConfig as any).eip712Name || (token === 'USDC' ? 'USD Coin' : 'Tether USD');
    const tokenVersion = domainOverride?.version || '2';

    const envelope = buildEIP3009TypedData({
      from: this.wallet!.address,
      to,
      value,
      nonce,
      chainId: chain.chainId,
      tokenAddress: tokenConfig.address,
      tokenName,
      tokenVersion,
    });

    const signature = await this.signer!.signTypedData(envelope);
    return { authorization: envelope.message, signature };
  }

  /**
   * Check spending limits
   */
  private checkLimits(amount: number): void {
    // Check per-tx limit
    if (amount > this.config.limits.maxPerTx) {
      throw new Error(
        `Amount $${amount} exceeds max per transaction ($${this.config.limits.maxPerTx})`
      );
    }

    // Reset daily spending if new day
    const today = new Date().setHours(0, 0, 0, 0);
    if (today > this.lastSpendingReset) {
      this.todaySpending = 0;
      this.lastSpendingReset = today;
      this.saveSpending(); // Persist reset
    }

    // Check daily limit
    if (this.todaySpending + amount > this.config.limits.maxPerDay) {
      throw new Error(
        `Would exceed daily limit ($${this.todaySpending} + $${amount} > $${this.config.limits.maxPerDay})`
      );
    }
  }

  /**
   * Record spending and persist to disk
   */
  private recordSpending(amount: number): void {
    this.todaySpending += amount;
    this.saveSpending();
  }

  // --- Config & Wallet Management ---

  private loadConfig(): ClientConfig {
    const configPath = join(this.configDir, 'config.json');
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
    }
    return { ...DEFAULT_CONFIG };
  }

  private saveConfig(): void {
    mkdirSync(this.configDir, { recursive: true });
    const configPath = join(this.configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(this.config, null, 2));
  }

  /**
   * Load spending data from disk
   */
  private loadSpending(): void {
    const spendingPath = join(this.configDir, 'spending.json');
    if (existsSync(spendingPath)) {
      try {
        const data = JSON.parse(readFileSync(spendingPath, 'utf-8'));
        const today = new Date().setHours(0, 0, 0, 0);
        
        // Only load if it's from today
        if (data.date && data.date === today) {
          this.todaySpending = data.amount || 0;
          this.lastSpendingReset = data.date;
        } else {
          // Data is from a previous day, reset
          this.todaySpending = 0;
          this.lastSpendingReset = today;
        }
      } catch {
        // Ignore parse errors, start fresh
        this.todaySpending = 0;
        this.lastSpendingReset = new Date().setHours(0, 0, 0, 0);
      }
    }
  }

  /**
   * Save spending data to disk
   */
  private saveSpending(): void {
    mkdirSync(this.configDir, { recursive: true });
    const spendingPath = join(this.configDir, 'spending.json');
    const data = {
      date: this.lastSpendingReset || new Date().setHours(0, 0, 0, 0),
      amount: this.todaySpending,
      updatedAt: Date.now(),
    };
    writeFileSync(spendingPath, JSON.stringify(data, null, 2));
  }

  private loadWallet(): WalletData | null {
    const walletPath = join(this.configDir, 'wallet.json');
    if (existsSync(walletPath)) {
      // POSIX-only: Windows reports synthesized mode bits and chmod can't
      // express NTFS ACLs, so the check is meaningless there.
      if (process.platform !== 'win32') {
        try {
          const stats = statSync(walletPath);
          const mode = stats.mode & 0o777;
          if (mode !== 0o600) {
            console.warn(`[MoltsPay] WARNING: wallet.json has insecure permissions (${mode.toString(8)})`);
            console.warn(`[MoltsPay] Fixing permissions to 0600...`);
            chmodSync(walletPath, 0o600);
          }
        } catch {
          /* ignored */
        }
      }

      const content = readFileSync(walletPath, 'utf-8');
      return JSON.parse(content);
    }
    return null;
  }

  /**
   * Initialize a new wallet (called by CLI)
   */
  static init(
    configDir: string,
    options: { chain: string; maxPerTx: number; maxPerDay: number }
  ): { address: string; configDir: string } {
    mkdirSync(configDir, { recursive: true });

    // Create wallet
    const wallet = Wallet.createRandom();
    const walletData: WalletData = {
      address: wallet.address,
      privateKey: wallet.privateKey,
      createdAt: Date.now(),
    };

    // Save wallet with secure permissions (0o600 = owner read/write only)
    const walletPath = join(configDir, 'wallet.json');
    writeFileSync(walletPath, JSON.stringify(walletData, null, 2), { mode: 0o600 });

    // Save config
    const config: ClientConfig = {
      chain: options.chain,
      limits: {
        maxPerTx: options.maxPerTx,
        maxPerDay: options.maxPerDay,
      },
    };
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    return { address: wallet.address, configDir };
  }

  /**
   * Get wallet balance (USDC, USDT, and native token) on default chain
   */
  async getBalance(): Promise<{ usdc: number; usdt: number; native: number }> {
    if (!this.wallet) {
      throw new Error('Client not initialized');
    }

    let chain;
    try {
      chain = getChain(this.config.chain as EvmChainName);
    } catch {
      throw new Error(`Unknown chain: ${this.config.chain}`);
    }

    const provider = new ethers.JsonRpcProvider(chain.rpc);
    const tokenAbi = ['function balanceOf(address) view returns (uint256)'];

    // Get all balances in parallel
    const [nativeBalance, usdcBalance, usdtBalance] = await Promise.all([
      provider.getBalance(this.wallet.address),
      new ethers.Contract(chain.tokens.USDC.address, tokenAbi, provider).balanceOf(this.wallet.address),
      new ethers.Contract(chain.tokens.USDT.address, tokenAbi, provider).balanceOf(this.wallet.address),
    ]);

    return {
      usdc: parseFloat(ethers.formatUnits(usdcBalance, chain.tokens.USDC.decimals)),
      usdt: parseFloat(ethers.formatUnits(usdtBalance, chain.tokens.USDT.decimals)),
      native: parseFloat(ethers.formatEther(nativeBalance)),
    };
  }

  /**
   * Get wallet balances on all supported chains (Base + Polygon + Tempo)
   */
  async getAllBalances(): Promise<Record<string, { usdc: number; usdt: number; native: number; tempo?: { pathUSD: number; alphaUSD: number; betaUSD: number; thetaUSD: number } }>> {
    if (!this.wallet) {
      throw new Error('Client not initialized');
    }

    const supportedChains: EvmChainName[] = ['base', 'polygon', 'base_sepolia', 'tempo_moderato', 'bnb', 'bnb_testnet'];
    const tokenAbi = ['function balanceOf(address) view returns (uint256)'];
    const results: Record<string, { usdc: number; usdt: number; native: number; tempo?: { pathUSD: number; alphaUSD: number; betaUSD: number; thetaUSD: number } }> = {};

    // Tempo testnet token addresses
    const tempoTokens = {
      pathUSD: '0x20c0000000000000000000000000000000000000',
      alphaUSD: '0x20c0000000000000000000000000000000000001',
      betaUSD: '0x20c0000000000000000000000000000000000002',
      thetaUSD: '0x20c0000000000000000000000000000000000003',
    };

    // Query all chains in parallel
    await Promise.all(
      supportedChains.map(async (chainName) => {
        try {
          const chain = getChain(chainName);
          const provider = new ethers.JsonRpcProvider(chain.rpc);

          if (chainName === 'tempo_moderato') {
            // Tempo: fetch all 4 testnet tokens
            const [nativeBalance, pathUSD, alphaUSD, betaUSD, thetaUSD] = await Promise.all([
              provider.getBalance(this.wallet!.address),
              new ethers.Contract(tempoTokens.pathUSD, tokenAbi, provider).balanceOf(this.wallet!.address),
              new ethers.Contract(tempoTokens.alphaUSD, tokenAbi, provider).balanceOf(this.wallet!.address),
              new ethers.Contract(tempoTokens.betaUSD, tokenAbi, provider).balanceOf(this.wallet!.address),
              new ethers.Contract(tempoTokens.thetaUSD, tokenAbi, provider).balanceOf(this.wallet!.address),
            ]);

            results[chainName] = {
              usdc: parseFloat(ethers.formatUnits(pathUSD, 6)), // pathUSD as default USDC
              usdt: parseFloat(ethers.formatUnits(alphaUSD, 6)), // alphaUSD as default USDT
              native: parseFloat(ethers.formatEther(nativeBalance)),
              tempo: {
                pathUSD: parseFloat(ethers.formatUnits(pathUSD, 6)),
                alphaUSD: parseFloat(ethers.formatUnits(alphaUSD, 6)),
                betaUSD: parseFloat(ethers.formatUnits(betaUSD, 6)),
                thetaUSD: parseFloat(ethers.formatUnits(thetaUSD, 6)),
              },
            };
          } else {
            // Other chains: fetch USDC and USDT
            const [nativeBalance, usdcBalance, usdtBalance] = await Promise.all([
              provider.getBalance(this.wallet!.address),
              new ethers.Contract(chain.tokens.USDC.address, tokenAbi, provider).balanceOf(this.wallet!.address),
              new ethers.Contract(chain.tokens.USDT.address, tokenAbi, provider).balanceOf(this.wallet!.address),
            ]);

            results[chainName] = {
              usdc: parseFloat(ethers.formatUnits(usdcBalance, chain.tokens.USDC.decimals)),
              usdt: parseFloat(ethers.formatUnits(usdtBalance, chain.tokens.USDT.decimals)),
              native: parseFloat(ethers.formatEther(nativeBalance)),
            };
          }
        } catch (err) {
          // If chain query fails, show zeros
          results[chainName] = { usdc: 0, usdt: 0, native: 0 };
        }
      })
    );

    return results;
  }

  /**
   * Pay for a service using MPP (Machine Payments Protocol)
   * 
   * This implements the MPP flow manually for EOA wallets:
   * 1. Request service → get 402 with WWW-Authenticate
   * 2. Parse payment requirements
   * 3. Execute transfer on Tempo chain
   * 4. Retry with transaction hash as credential
   * 
   * @param url - Full URL of the MPP-enabled endpoint
   * @param options - Request options (body, headers)
   * @returns Response from the service
   */
  async payWithMPP(
    url: string,
    options: {
      body?: any;
      headers?: Record<string, string>;
    } = {}
  ): Promise<any> {
    if (!this.wallet || !this.walletData) {
      throw new Error('Client not initialized. Run: moltspay init');
    }

    // Dynamic imports for ESM-only packages
    const { privateKeyToAccount } = await import('viem/accounts');
    const { createWalletClient, createPublicClient, http } = await import('viem');
    const { tempoModerato } = await import('viem/chains');
    const { Actions } = await import('viem/tempo');

    // Get private key from wallet data
    const privateKey = this.walletData.privateKey as `0x${string}`;
    const account = privateKeyToAccount(privateKey);

    console.log(`[MoltsPay] Making MPP request to: ${url}`);
    console.log(`[MoltsPay] Using account: ${account.address}`);

    // Step 1: Initial request to get 402 with payment requirements
    const initResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    // If not 402, handle directly
    if (initResponse.status !== 402) {
      if (initResponse.ok) {
        return initResponse.json();
      }
      const errorText = await initResponse.text();
      throw new Error(`Request failed (${initResponse.status}): ${errorText}`);
    }

    // Step 2: Parse WWW-Authenticate header
    const wwwAuth = initResponse.headers.get('www-authenticate');
    if (!wwwAuth || !wwwAuth.toLowerCase().includes('payment')) {
      throw new Error('No WWW-Authenticate Payment challenge in 402 response');
    }

    console.log(`[MoltsPay] Got 402, parsing payment challenge...`);

    // Parse WWW-Authenticate: Payment id="...", method="tempo", request="..."
    const parseAuthParam = (header: string, key: string): string | null => {
      const match = header.match(new RegExp(`${key}="([^"]+)"`, 'i'));
      return match ? match[1] : null;
    };

    const challengeId = parseAuthParam(wwwAuth, 'id');
    const method = parseAuthParam(wwwAuth, 'method');
    const realm = parseAuthParam(wwwAuth, 'realm');
    const requestB64 = parseAuthParam(wwwAuth, 'request');

    if (method !== 'tempo') {
      throw new Error(`Unsupported payment method: ${method}`);
    }

    if (!requestB64) {
      throw new Error('Missing request in WWW-Authenticate');
    }

    // Decode payment request
    const requestJson = Buffer.from(requestB64, 'base64').toString('utf-8');
    const paymentRequest = JSON.parse(requestJson);
    
    console.log(`[MoltsPay] Payment request:`, paymentRequest);

    const { amount, currency, recipient, methodDetails } = paymentRequest;
    const chainId = methodDetails?.chainId || 42431;

    // Step 3: Execute transfer on Tempo
    console.log(`[MoltsPay] Executing transfer on Tempo (chainId: ${chainId})...`);
    console.log(`[MoltsPay] Amount: ${amount}, To: ${recipient}`);

    // Create viem client for Tempo (with feeToken for gas-free transactions)
    const tempoChain = { ...tempoModerato, feeToken: currency as `0x${string}` };
    
    const publicClient = createPublicClient({
      chain: tempoChain,
      transport: http('https://rpc.moderato.tempo.xyz'),
    });

    const walletClient = createWalletClient({
      account,
      chain: tempoChain,
      transport: http('https://rpc.moderato.tempo.xyz'),
    });

    // Use viem's Tempo Actions for TIP-20 transfer
    const txHash = await Actions.token.transfer(walletClient, {
      to: recipient as `0x${string}`,
      amount: BigInt(amount),
      token: currency as `0x${string}`,
    });

    console.log(`[MoltsPay] Transaction sent: ${txHash}`);

    // Wait for confirmation
    console.log(`[MoltsPay] Waiting for confirmation...`);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`[MoltsPay] Transaction confirmed!`);

    // Step 4: Build credential and retry
    const challenge = {
      id: challengeId,
      realm,
      method: 'tempo',
      intent: 'charge',
      request: paymentRequest,
    };

    const credential = {
      challenge,
      payload: { hash: txHash, type: 'hash' },
      source: `did:pkh:eip155:${chainId}:${account.address}`,
    };

    const credentialB64 = Buffer.from(JSON.stringify(credential))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''); // base64url without padding

    console.log(`[MoltsPay] Retrying with payment credential...`);

    // Retry with credential
    const paidResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Payment ${credentialB64}`,
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!paidResponse.ok) {
      const errorText = await paidResponse.text();
      throw new Error(`Payment verification failed (${paidResponse.status}): ${errorText}`);
    }

    console.log(`[MoltsPay] Payment verified! Service completed.`);
    return paidResponse.json();
  }
}
