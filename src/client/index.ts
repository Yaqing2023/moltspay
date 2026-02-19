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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Wallet, ethers } from 'ethers';
import { getChain, type ChainName } from '../chains/index.js';
import {
  ClientConfig,
  WalletData,
  ServicesResponse,
  MoltsPayClientOptions,
} from './types.js';

export * from './types.js';

// x402 constants
const X402_VERSION = 2;
const PAYMENT_REQUIRED_HEADER = 'x-payment-required';
const PAYMENT_HEADER = 'x-payment';

interface X402PaymentRequirements {
  scheme: string;
  network: string;
  // v2 fields
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  // v1 fields (legacy)
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
}

interface EIP3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

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
  private todaySpending: number = 0;
  private lastSpendingReset: number = 0;

  constructor(options: MoltsPayClientOptions = {}) {
    this.configDir = options.configDir || join(homedir(), '.moltspay');
    this.config = this.loadConfig();
    this.walletData = this.loadWallet();
    
    if (this.walletData) {
      this.wallet = new Wallet(this.walletData.privateKey);
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
    const res = await fetch(`${serverUrl}/services`);
    if (!res.ok) {
      throw new Error(`Failed to get services: ${res.statusText}`);
    }
    return res.json() as Promise<ServicesResponse>;
  }

  /**
   * Pay for a service and get the result (x402 protocol)
   * 
   * This is GASLESS for the client - server pays gas to claim payment.
   * This is PAY-FOR-SUCCESS - payment only claimed if service succeeds.
   */
  async pay(
    serverUrl: string,
    service: string,
    params: Record<string, any>
  ): Promise<Record<string, any>> {
    if (!this.wallet || !this.walletData) {
      throw new Error('Client not initialized. Run: npx moltspay init');
    }

    // Step 1: Make initial request without payment
    console.log(`[MoltsPay] Requesting service: ${service}`);
    const initialRes = await fetch(`${serverUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, params }),
    });

    // If not 402, check for success or error
    if (initialRes.status !== 402) {
      const data = await initialRes.json() as any;
      if (initialRes.ok && data.result) {
        return data.result;
      }
      throw new Error(data.error || 'Unexpected response');
    }

    // Step 2: Parse payment requirements from 402 response
    const paymentRequiredHeader = initialRes.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!paymentRequiredHeader) {
      throw new Error('Missing x-payment-required header');
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

    // Find matching requirement for our chain
    const chain = getChain(this.config.chain as ChainName);
    const network = `eip155:${chain.chainId}`;
    const req = requirements.find(r => r.scheme === 'exact' && r.network === network);
    
    if (!req) {
      throw new Error(`No matching payment option for ${network}`);
    }

    // Step 3: Check limits
    // v2 uses 'amount', v1 uses 'maxAmountRequired'
    const amountRaw = req.amount || req.maxAmountRequired;
    if (!amountRaw) {
      throw new Error('Missing amount in payment requirements');
    }
    const amount = Number(amountRaw) / 1e6;
    this.checkLimits(amount);

    console.log(`[MoltsPay] Signing payment: $${amount} USDC (gasless)`);

    // Step 4: Sign EIP-3009 authorization (GASLESS - just signing)
    // payTo is the recipient address (v2 format)
    const payTo = req.payTo || req.resource; // fallback for v1 compatibility
    if (!payTo) {
      throw new Error('Missing payTo address in payment requirements');
    }
    const authorization = await this.signEIP3009(payTo, amount, chain);

    // Step 5: Create x402 payment payload
    const payload = {
      x402Version: X402_VERSION,
      scheme: 'exact',
      network,
      payload: authorization,
    };
    const paymentHeader = Buffer.from(JSON.stringify(payload)).toString('base64');

    // Step 6: Retry with payment header
    console.log(`[MoltsPay] Sending request with payment...`);
    const paidRes = await fetch(`${serverUrl}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PAYMENT_HEADER]: paymentHeader,
      },
      body: JSON.stringify({ service, params }),
    });

    const result = await paidRes.json() as any;

    if (!paidRes.ok) {
      throw new Error(result.error || 'Service execution failed');
    }

    // Update spending tracking
    this.recordSpending(amount);

    console.log(`[MoltsPay] Success! Payment: ${result.payment?.status || 'claimed'}`);
    
    return result.result;
  }

  /**
   * Sign EIP-3009 transferWithAuthorization (GASLESS)
   * This only signs - no on-chain transaction, no gas needed.
   */
  private async signEIP3009(
    to: string,
    amount: number,
    chain: { chainId: number; usdc: string }
  ): Promise<{ authorization: EIP3009Authorization; signature: string }> {
    const validAfter = 0;
    const validBefore = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const value = BigInt(Math.floor(amount * 1e6)).toString();

    const authorization: EIP3009Authorization = {
      from: this.wallet!.address,
      to,
      value,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    };

    // EIP-712 domain for USDC
    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId: chain.chainId,
      verifyingContract: chain.usdc,
    };

    // EIP-3009 types
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };

    const signature = await this.wallet!.signTypedData(domain, types, authorization);

    return { authorization, signature };
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
    }

    // Check daily limit
    if (this.todaySpending + amount > this.config.limits.maxPerDay) {
      throw new Error(
        `Would exceed daily limit ($${this.todaySpending} + $${amount} > $${this.config.limits.maxPerDay})`
      );
    }
  }

  /**
   * Record spending
   */
  private recordSpending(amount: number): void {
    this.todaySpending += amount;
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

  private loadWallet(): WalletData | null {
    const walletPath = join(this.configDir, 'wallet.json');
    if (existsSync(walletPath)) {
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

    // Save wallet
    const walletPath = join(configDir, 'wallet.json');
    writeFileSync(walletPath, JSON.stringify(walletData, null, 2));

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
   * Get wallet balance
   */
  async getBalance(): Promise<{ usdc: number; native: number }> {
    if (!this.wallet) {
      throw new Error('Client not initialized');
    }

    let chain;
    try {
      chain = getChain(this.config.chain as ChainName);
    } catch {
      throw new Error(`Unknown chain: ${this.config.chain}`);
    }

    const provider = new ethers.JsonRpcProvider(chain.rpc);

    // Get native balance
    const nativeBalance = await provider.getBalance(this.wallet.address);

    // Get USDC balance
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new ethers.Contract(chain.usdc, usdcAbi, provider);
    const usdcBalance = await usdc.balanceOf(this.wallet.address);

    return {
      usdc: parseFloat(ethers.formatUnits(usdcBalance, 6)),
      native: parseFloat(ethers.formatEther(nativeBalance)),
    };
  }
}
