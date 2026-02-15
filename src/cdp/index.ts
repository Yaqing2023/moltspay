/**
 * CDP (Coinbase Developer Platform) Wallet Integration
 * 
 * Creates and manages wallets via Coinbase's CDP SDK.
 * These wallets are hosted by Coinbase, making them easy to use for AI Agents.
 * 
 * @see https://docs.cdp.coinbase.com/
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ChainName } from '../types/index.js';
import { getChain } from '../chains/index.js';

// CDP config file location
const DEFAULT_STORAGE_DIR = path.join(process.env.HOME || '.', '.moltspay');
const CDP_CONFIG_FILE = 'cdp-wallet.json';

export interface CDPWalletConfig {
  /** Storage directory (default: ~/.moltspay) */
  storageDir?: string;
  /** Chain name */
  chain?: ChainName;
  /** CDP API credentials (or use env vars) */
  apiKeyId?: string;
  apiKeySecret?: string;
  walletSecret?: string;
}

export interface CDPWalletData {
  /** Wallet address */
  address: string;
  /** CDP wallet ID */
  walletId: string;
  /** Chain */
  chain: ChainName;
  /** Created timestamp */
  createdAt: string;
  /** CDP account data (for restoration) */
  accountData?: string;
}

export interface CDPInitResult {
  success: boolean;
  address?: string;
  walletId?: string;
  isNew?: boolean;
  error?: string;
  storagePath?: string;
}

/**
 * Check if CDP SDK is available
 */
export function isCDPAvailable(): boolean {
  try {
    require.resolve('@coinbase/cdp-sdk');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get CDP credentials from environment
 */
function getCDPCredentials(config: CDPWalletConfig): {
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret?: string;
} | null {
  const apiKeyId = config.apiKeyId || process.env.CDP_API_KEY_ID;
  const apiKeySecret = config.apiKeySecret || process.env.CDP_API_KEY_SECRET;
  const walletSecret = config.walletSecret || process.env.CDP_WALLET_SECRET;

  if (!apiKeyId || !apiKeySecret) {
    return null;
  }

  return { apiKeyId, apiKeySecret, walletSecret };
}

/**
 * Initialize CDP wallet
 * 
 * Creates a new CDP wallet or loads existing one.
 * 
 * @example
 * ```bash
 * # Set credentials
 * export CDP_API_KEY_ID=your-key-id
 * export CDP_API_KEY_SECRET=your-key-secret
 * 
 * # Initialize
 * npx moltspay init --cdp --chain base
 * ```
 */
export async function initCDPWallet(config: CDPWalletConfig = {}): Promise<CDPInitResult> {
  const storageDir = config.storageDir || DEFAULT_STORAGE_DIR;
  const chain = config.chain || 'base';
  const storagePath = path.join(storageDir, CDP_CONFIG_FILE);

  // Check for existing wallet
  if (fs.existsSync(storagePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(storagePath, 'utf-8')) as CDPWalletData;
      return {
        success: true,
        address: data.address,
        walletId: data.walletId,
        isNew: false,
        storagePath,
      };
    } catch (error) {
      // Continue to create new
    }
  }

  // Check CDP availability
  if (!isCDPAvailable()) {
    return {
      success: false,
      error: 'CDP SDK not installed. Run: npm install @coinbase/cdp-sdk',
    };
  }

  // Get credentials
  const creds = getCDPCredentials(config);
  if (!creds) {
    return {
      success: false,
      error: 'CDP credentials not found. Set CDP_API_KEY_ID and CDP_API_KEY_SECRET environment variables.',
    };
  }

  try {
    // Dynamic import to avoid errors when CDP SDK is not installed
    const { CdpClient } = await import('@coinbase/cdp-sdk');

    // Initialize CDP client
    const cdp = new CdpClient({
      apiKeyId: creds.apiKeyId,
      apiKeySecret: creds.apiKeySecret,
      walletSecret: creds.walletSecret,
    });

    // Create EVM account
    const account = await cdp.evm.createAccount();

    // Ensure storage directory exists
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    // Save wallet data
    const walletData: CDPWalletData = {
      address: account.address,
      walletId: account.address, // CDP uses address as ID for EVM
      chain,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(storagePath, JSON.stringify(walletData, null, 2), { mode: 0o600 });

    return {
      success: true,
      address: account.address,
      walletId: account.address,
      isNew: true,
      storagePath,
    };
  } catch (error) {
    return {
      success: false,
      error: (error as Error).message,
    };
  }
}

/**
 * Load existing CDP wallet
 */
export function loadCDPWallet(config: CDPWalletConfig = {}): CDPWalletData | null {
  const storageDir = config.storageDir || DEFAULT_STORAGE_DIR;
  const storagePath = path.join(storageDir, CDP_CONFIG_FILE);

  if (!fs.existsSync(storagePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(storagePath, 'utf-8')) as CDPWalletData;
  } catch {
    return null;
  }
}

/**
 * Get CDP wallet address (quick check without full init)
 */
export function getCDPWalletAddress(storageDir?: string): string | null {
  const data = loadCDPWallet({ storageDir });
  return data?.address || null;
}

/**
 * CDP Wallet class for making payments
 * 
 * Uses CDP SDK for wallet operations with x402 support.
 */
export class CDPWallet {
  readonly address: string;
  readonly chain: ChainName;
  readonly chainConfig: ReturnType<typeof getChain>;
  private storageDir: string;

  constructor(config: CDPWalletConfig = {}) {
    this.storageDir = config.storageDir || DEFAULT_STORAGE_DIR;
    this.chain = config.chain || 'base';
    this.chainConfig = getChain(this.chain);

    // Load existing wallet
    const data = loadCDPWallet(config);
    if (!data) {
      throw new Error('CDP wallet not initialized. Run: npx moltspay init --cdp');
    }
    this.address = data.address;
  }

  /**
   * Get USDC balance
   */
  async getBalance(): Promise<{ usdc: string; eth: string }> {
    // Use ethers to check balance (read-only, no CDP needed)
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(this.chainConfig.rpc);
    
    const usdcContract = new ethers.Contract(
      this.chainConfig.usdc,
      ['function balanceOf(address) view returns (uint256)'],
      provider
    );

    const [usdcBalance, ethBalance] = await Promise.all([
      usdcContract.balanceOf(this.address),
      provider.getBalance(this.address),
    ]);

    return {
      usdc: (Number(usdcBalance) / 1e6).toFixed(2),
      eth: ethers.formatEther(ethBalance),
    };
  }

  /**
   * Transfer USDC to a recipient
   * 
   * Requires CDP SDK and credentials to sign transactions.
   */
  async transfer(params: { to: string; amount: number }): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
    explorerUrl?: string;
  }> {
    if (!isCDPAvailable()) {
      return { success: false, error: 'CDP SDK not installed' };
    }

    const creds = getCDPCredentials({});
    if (!creds) {
      return { success: false, error: 'CDP credentials not found' };
    }

    try {
      const { CdpClient } = await import('@coinbase/cdp-sdk');
      const { ethers } = await import('ethers');

      const cdp = new CdpClient({
        apiKeyId: creds.apiKeyId,
        apiKeySecret: creds.apiKeySecret,
        walletSecret: creds.walletSecret,
      });

      // Get the account
      const account = await cdp.evm.getAccount({ address: this.address as `0x${string}` });

      // Build transfer transaction
      const amountWei = BigInt(Math.floor(params.amount * 1e6));
      const iface = new ethers.Interface([
        'function transfer(address to, uint256 amount) returns (bool)',
      ]);
      const callData = iface.encodeFunctionData('transfer', [params.to, amountWei]);

      // Send transaction (use any to avoid type issues with CDP SDK versions)
      const txOptions: any = {
        to: this.chainConfig.usdc,
        data: callData,
      };
      const tx = await account.sendTransaction(txOptions);

      return {
        success: true,
        txHash: tx.transactionHash,
        explorerUrl: `${this.chainConfig.explorerTx}${tx.transactionHash}`,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Create viem-compatible signer for x402
   * 
   * This allows using CDP wallet with x402 protocol.
   */
  async getViemAccount(): Promise<unknown> {
    if (!isCDPAvailable()) {
      throw new Error('CDP SDK not installed');
    }

    const creds = getCDPCredentials({});
    if (!creds) {
      throw new Error('CDP credentials not found');
    }

    const { CdpClient } = await import('@coinbase/cdp-sdk');
    const { toAccount } = await import('viem/accounts');

    const cdp = new CdpClient({
      apiKeyId: creds.apiKeyId,
      apiKeySecret: creds.apiKeySecret,
      walletSecret: creds.walletSecret,
    });

    const account = await cdp.evm.getAccount({ address: this.address as `0x${string}` });
    return toAccount(account);
  }
}
