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

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Wallet, ethers } from 'ethers';
import { getChain, type ChainName, type EvmChainName, type TokenSymbol, type ChainConfig } from '../chains/index.js';
import { SOLANA_CHAINS, type SolanaChainName } from '../chains/solana.js';
import { loadSolanaWallet, getSolanaAddress } from '../wallet/solana.js';
import { createSolanaPaymentTransaction } from '../facilitators/solana.js';
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import {
  ClientConfig,
  WalletData,
  ServicesResponse,
  MoltsPayClientOptions,
} from './types.js';

export * from './types.js';

export interface PayOptions {
  /** Token to pay with (default: USDC, or auto-select based on balance) */
  token?: TokenSymbol;
  /** Auto-select token based on balance (default: false) */
  autoSelect?: boolean;
  /** Chain to pay on */
  chain?: 'base' | 'polygon' | 'base_sepolia' | 'tempo_moderato' | 'bnb' | 'bnb_testnet' | 'solana' | 'solana_devnet';
}

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
    this.loadSpending(); // Load persisted spending data
    
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
    if (!this.wallet || !this.walletData) {
      throw new Error('Client not initialized. Run: npx moltspay init');
    }

    // Step 1: Make initial request without payment
    console.log(`[MoltsPay] Requesting service: ${service}`);
    const requestBody: any = { service, params };
    if (options.chain) {
      requestBody.chain = options.chain;
    }
    const initialRes = await fetch(`${serverUrl}/execute`, {
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
      return await this.handleMPPPayment(serverUrl, service, params, wwwAuthHeader);
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

    // Helper to convert network ID to chain name
    const networkToChainName = (network: string): string | null => {
      // Handle Solana networks
      if (network === 'solana:mainnet') return 'solana';
      if (network === 'solana:devnet') return 'solana_devnet';
      
      // Handle EVM networks
      const match = network.match(/^eip155:(\d+)$/);
      if (!match) return null;
      const chainId = parseInt(match[1]);
      if (chainId === 8453) return 'base';
      if (chainId === 137) return 'polygon';
      if (chainId === 84532) return 'base_sepolia';
      if (chainId === 42431) return 'tempo_moderato';
      if (chainId === 56) return 'bnb';
      if (chainId === 97) return 'bnb_testnet';
      return null;
    };

    // Get server's accepted chains
    const serverChains = requirements
      .map(r => networkToChainName(r.network))
      .filter((c): c is string => c !== null);

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
      
      return await this.handleSolanaPayment(serverUrl, service, params, req, solanaChain);
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
      return await this.handleBNBPayment(serverUrl, service, params, {
        to: payTo,
        amount,
        token,
        chainName,
        chain,
        spender: bnbSpender,
      });
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
    const paidRequestBody: any = { service, params };
    if (options.chain) {
      paidRequestBody.chain = options.chain;
    }
    const paidRes = await fetch(`${serverUrl}/execute`, {
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
    
    return result.result;
  }

  /**
   * Handle MPP (Machine Payments Protocol) payment flow
   * Called when pay() detects WWW-Authenticate header in 402 response
   */
  private async handleMPPPayment(
    serverUrl: string,
    service: string,
    params: Record<string, any>,
    wwwAuthHeader: string
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

    // Retry with credential
    const paidRes = await fetch(`${serverUrl}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Payment ${credentialB64}`,
      },
      body: JSON.stringify({ service, params, chain: 'tempo_moderato' }),
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
    serverUrl: string,
    service: string,
    params: Record<string, any>,
    paymentDetails: {
      to: string;
      amount: number;
      token: TokenSymbol;
      chainName: ChainName;
      chain: ChainConfig;
      spender: string;
    }
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
            `   Get testnet tokens: npx moltspay faucet --chain bnb_testnet\n` +
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
            `   npx moltspay approve --chain ${chainName} --spender ${spender}`
          );
        }
      }
      
      throw new Error(
        `Insufficient allowance for ${spender.slice(0, 10)}...\n` +
        `Run: npx moltspay approve --chain ${chainName} --spender ${spender}`
      );
    }
    
    // Convert amount to wei (BNB uses 18 decimals)
    const amountWei = BigInt(Math.floor(amount * (10 ** tokenConfig.decimals))).toString();
    
    // Create payment intent
    const intent = {
      from: this.wallet!.address,
      to,
      amount: amountWei,
      token: tokenConfig.address,
      service,
      nonce: Date.now(), // Use timestamp as nonce for simplicity
      deadline: Date.now() + 3600000, // 1 hour
    };

    // EIP-712 domain
    const domain = {
      name: 'MoltsPay',
      version: '1',
      chainId: chain.chainId,
    };

    // EIP-712 types
    const types = {
      PaymentIntent: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'token', type: 'address' },
        { name: 'service', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    // Sign the intent
    console.log(`[MoltsPay] Signing BNB payment intent...`);
    const signature = await this.wallet!.signTypedData(domain, types, intent);

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

    // Send request with payment
    console.log(`[MoltsPay] Sending BNB payment request...`);
    const paidRes = await fetch(`${serverUrl}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': paymentHeader,
      },
      body: JSON.stringify({ service, params, chain: chainName }),
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
    serverUrl: string,
    service: string,
    params: Record<string, any>,
    requirements: X402PaymentRequirements,
    chain: SolanaChainName
  ): Promise<Record<string, any>> {
    // Load Solana wallet
    const solanaWallet = loadSolanaWallet(this.configDir);
    if (!solanaWallet) {
      throw new Error('No Solana wallet found. Run: npx moltspay init --chain solana_devnet');
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

    // Sign the transaction (partial sign if gasless mode)
    if (feePayerPubkey) {
      // Gasless mode: only sign for token transfer authority
      transaction.partialSign(solanaWallet);
    } else {
      // Normal mode: sign as both authority and fee payer
      transaction.sign(solanaWallet);
    }
    const signedTx = transaction.serialize({ requireAllSignatures: false }).toString('base64');

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

    // Send request with payment
    const paidRes = await fetch(`${serverUrl}/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': paymentHeader,
      },
      body: JSON.stringify({ service, params, chain }),
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
   */
  private async signEIP3009(
    to: string,
    amount: number,
    chain: { chainId: number; tokens: Record<TokenSymbol, { address: string; decimals: number }> },
    token: TokenSymbol = 'USDC',
    domainOverride?: { name: string; version: string }
  ): Promise<{ authorization: EIP3009Authorization; signature: string }> {
    const validAfter = 0;
    const validBefore = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    
    const tokenConfig = chain.tokens[token];
    const value = BigInt(Math.floor(amount * (10 ** tokenConfig.decimals))).toString();

    const authorization: EIP3009Authorization = {
      from: this.wallet!.address,
      to,
      value,
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    };

    // EIP-712 domain - use server's domain info if provided (handles mainnet vs testnet differences)
    // Fall back to local token config for backward compatibility
    const tokenName = domainOverride?.name || (tokenConfig as any).eip712Name || (token === 'USDC' ? 'USD Coin' : 'Tether USD');
    const tokenVersion = domainOverride?.version || '2';
    const domain = {
      name: tokenName,
      version: tokenVersion,
      chainId: chain.chainId,
      verifyingContract: tokenConfig.address,
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
      // Security check: warn and fix if permissions are too open
      try {
        const stats = statSync(walletPath);
        const mode = stats.mode & 0o777;
        if (mode !== 0o600) {
          console.warn(`[MoltsPay] WARNING: wallet.json has insecure permissions (${mode.toString(8)})`);
          console.warn(`[MoltsPay] Fixing permissions to 0600...`);
          chmodSync(walletPath, 0o600);
        }
      } catch (err) {
        // Ignore permission check errors on Windows
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
      throw new Error('Client not initialized. Run: npx moltspay init');
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
