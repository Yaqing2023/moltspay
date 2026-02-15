/**
 * AgentWallet - Zero-config wallet for AI Agents
 * 
 * Design principles:
 * - Auto-initialize on first use (no manual setup)
 * - Generate address locally (no gas needed)
 * - Owner authorizes via Permit (can be CLI or UI)
 * - Agent only needs gas when actually spending
 */

import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';
import { getChain, ERC20_ABI } from '../chains/index.js';
import type { ChainName, ChainConfig } from '../types/index.js';

export interface OwnerPermit {
  owner: string;
  value: string;
  deadline: number;
  nonce: number;
  v: number;
  r: string;
  s: string;
}

export interface AgentWalletConfig {
  /** Storage directory for wallet data (default: ~/.moltspay) */
  storageDir?: string;
  /** Chain to use */
  chain?: ChainName;
  /** Custom RPC URL */
  rpcUrl?: string;
}

export interface SpendResult {
  success: boolean;
  txHash?: string;
  error?: string;
  from: string;
  to: string;
  amount: number;
  remainingAllowance?: string;
  explorerUrl?: string;
}

const PERMIT_ABI = [
  ...ERC20_ABI,
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
];

export class AgentWallet {
  readonly chain: ChainName;
  readonly chainConfig: ChainConfig;
  readonly storageDir: string;
  
  private _address: string | null = null;
  private _privateKey: string | null = null;
  private _wallet: ethers.Wallet | null = null;
  private _provider: ethers.JsonRpcProvider | null = null;
  private _permits: Map<string, OwnerPermit> = new Map();

  constructor(config: AgentWalletConfig = {}) {
    this.chain = config.chain || 'base';
    this.chainConfig = getChain(this.chain);
    this.storageDir = config.storageDir || this.getDefaultStorageDir();
    
    // Auto-initialize: load existing wallet or create new one
    this.ensureInitialized();
  }

  private getDefaultStorageDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || '.';
    return path.join(home, '.moltspay');
  }

  private getWalletPath(): string {
    return path.join(this.storageDir, 'wallet.json');
  }

  private getPermitsPath(): string {
    return path.join(this.storageDir, 'permits.json');
  }

  /**
   * Auto-initialize: create wallet if not exists
   * This is called automatically in constructor
   */
  private ensureInitialized(): void {
    // Ensure storage directory exists
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }

    const walletPath = this.getWalletPath();
    
    if (fs.existsSync(walletPath)) {
      // Load existing wallet
      const data = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
      this._address = data.address;
      this._privateKey = data.privateKey;
    } else {
      // Generate new wallet (local only, no gas needed)
      const wallet = ethers.Wallet.createRandom();
      this._address = wallet.address;
      this._privateKey = wallet.privateKey;
      
      // Save to disk
      fs.writeFileSync(walletPath, JSON.stringify({
        address: this._address,
        privateKey: this._privateKey,
        createdAt: new Date().toISOString(),
        chain: this.chain,
      }, null, 2), { mode: 0o600 });  // Restricted permissions
    }

    // Load stored permits
    const permitsPath = this.getPermitsPath();
    if (fs.existsSync(permitsPath)) {
      const permits = JSON.parse(fs.readFileSync(permitsPath, 'utf-8'));
      for (const [owner, permit] of Object.entries(permits)) {
        this._permits.set(owner.toLowerCase(), permit as OwnerPermit);
      }
    }
  }

  /** Agent's address (auto-generated on first use) */
  get address(): string {
    return this._address!;
  }

  private get wallet(): ethers.Wallet {
    if (!this._wallet) {
      this._wallet = new ethers.Wallet(this._privateKey!, this.provider);
    }
    return this._wallet;
  }

  private get provider(): ethers.JsonRpcProvider {
    if (!this._provider) {
      this._provider = new ethers.JsonRpcProvider(this.chainConfig.rpc);
    }
    return this._provider;
  }

  /**
   * Store a Permit from Owner
   */
  storePermit(permit: OwnerPermit): void {
    const ownerLower = permit.owner.toLowerCase();
    this._permits.set(ownerLower, permit);
    
    // Persist to disk
    const permitsPath = this.getPermitsPath();
    const permits: Record<string, OwnerPermit> = {};
    for (const [owner, p] of this._permits) {
      permits[owner] = p;
    }
    fs.writeFileSync(permitsPath, JSON.stringify(permits, null, 2));
  }

  /**
   * Get stored permit for an owner
   */
  getPermit(owner: string): OwnerPermit | undefined {
    return this._permits.get(owner.toLowerCase());
  }

  /**
   * Check allowance from an owner
   */
  async checkAllowance(owner: string): Promise<{
    allowance: string;
    ownerBalance: string;
    canSpend: boolean;
  }> {
    const usdcContract = new ethers.Contract(
      this.chainConfig.usdc,
      PERMIT_ABI,
      this.provider
    );

    const ownerAddress = ethers.getAddress(owner);
    const [allowance, balance] = await Promise.all([
      usdcContract.allowance(ownerAddress, this.address),
      usdcContract.balanceOf(ownerAddress),
    ]);

    return {
      allowance: (Number(allowance) / 1e6).toFixed(2),
      ownerBalance: (Number(balance) / 1e6).toFixed(2),
      canSpend: Number(allowance) > 0,
    };
  }

  /**
   * Spend USDC from Owner's wallet
   * 
   * @param to - Recipient (service provider)
   * @param amount - Amount in USDC
   * @param permit - Optional, uses stored permit if not provided
   */
  async spend(to: string, amount: number, permit?: OwnerPermit): Promise<SpendResult> {
    const toAddress = ethers.getAddress(to);
    const amountWei = BigInt(Math.floor(amount * 1e6));

    // Find permit
    let usePermit = permit;
    let ownerAddress: string;

    if (usePermit) {
      ownerAddress = ethers.getAddress(usePermit.owner);
      this.storePermit(usePermit);
    } else {
      // Find stored permit with sufficient allowance
      const usdcContract = new ethers.Contract(
        this.chainConfig.usdc,
        PERMIT_ABI,
        this.provider
      );

      for (const [owner, p] of this._permits) {
        const allowance = await usdcContract.allowance(owner, this.address);
        if (BigInt(allowance) >= amountWei) {
          ownerAddress = ethers.getAddress(owner);
          usePermit = p;
          break;
        }
      }

      if (!usePermit) {
        return {
          success: false,
          error: 'No valid permit. Ask Owner to authorize spending first.',
          from: '',
          to: toAddress,
          amount,
        };
      }
    }

    try {
      const usdcContract = new ethers.Contract(
        this.chainConfig.usdc,
        PERMIT_ABI,
        this.wallet
      );

      // Check current allowance
      const currentAllowance = await usdcContract.allowance(ownerAddress!, this.address);

      // If insufficient, submit permit first
      if (BigInt(currentAllowance) < amountWei) {
        const now = Math.floor(Date.now() / 1000);
        if (usePermit!.deadline < now) {
          return {
            success: false,
            error: 'Permit expired. Ask Owner for a new authorization.',
            from: ownerAddress!,
            to: toAddress,
            amount,
          };
        }

        // Submit permit on-chain
        const permitTx = await usdcContract.permit(
          ownerAddress!,
          this.address,
          usePermit!.value,
          usePermit!.deadline,
          usePermit!.v,
          usePermit!.r,
          usePermit!.s
        );
        await permitTx.wait();
      }

      // Execute transfer
      const tx = await usdcContract.transferFrom(ownerAddress!, toAddress, amountWei);
      await tx.wait();

      const newAllowance = await usdcContract.allowance(ownerAddress!, this.address);

      return {
        success: true,
        txHash: tx.hash,
        from: ownerAddress!,
        to: toAddress,
        amount,
        remainingAllowance: (Number(newAllowance) / 1e6).toFixed(2),
        explorerUrl: `${this.chainConfig.explorerTx}${tx.hash}`,
      };

    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
        from: ownerAddress!,
        to: toAddress,
        amount,
      };
    }
  }

  /**
   * Get USDC balance
   */
  async getBalance(): Promise<{ usdc: string; eth: string }> {
    const usdcContract = new ethers.Contract(
      this.chainConfig.usdc,
      PERMIT_ABI,
      this.provider
    );
    
    const [usdcBalance, ethBalance] = await Promise.all([
      usdcContract.balanceOf(this.address),
      this.provider.getBalance(this.address),
    ]);
    
    return {
      usdc: (Number(usdcBalance) / 1e6).toFixed(2),
      eth: ethers.formatEther(ethBalance),
    };
  }

  /**
   * Transfer USDC to a recipient (direct payment)
   * 
   * This is the simplest payment method - Agent pays directly from its wallet.
   * Requires Agent wallet to have USDC (funded by Owner).
   * 
   * @example
   * ```typescript
   * const wallet = new AgentWallet({ chain: 'base' });
   * 
   * // Check balance
   * const balance = await wallet.getBalance();
   * console.log('USDC:', balance.usdc);
   * 
   * // Pay for service
   * const result = await wallet.transfer({
   *   to: '0xServiceProvider...',
   *   amount: 0.99
   * });
   * console.log('Tx:', result.txHash);
   * ```
   */
  async transfer(params: { to: string; amount: number }): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
    from?: string;
    to?: string;
    amount?: number;
    explorerUrl?: string;
  }> {
    const { to, amount } = params;
    
    try {
      const toAddress = ethers.getAddress(to);
      const amountWei = BigInt(Math.floor(amount * 1e6));
      
      const usdcContract = new ethers.Contract(
        this.chainConfig.usdc,
        PERMIT_ABI,
        this.wallet
      );
      
      // Check balance
      const balance = await usdcContract.balanceOf(this.address);
      if (BigInt(balance) < amountWei) {
        return {
          success: false,
          error: `Insufficient USDC: have ${(Number(balance) / 1e6).toFixed(2)}, need ${amount}`,
        };
      }
      
      // Check gas
      if (!await this.hasGas()) {
        return {
          success: false,
          error: 'Insufficient ETH for gas. Need at least 0.0005 ETH.',
        };
      }
      
      // Execute transfer
      const tx = await usdcContract.transfer(toAddress, amountWei);
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        return {
          success: true,
          txHash: tx.hash,
          from: this.address,
          to: toAddress,
          amount,
          explorerUrl: `${this.chainConfig.explorerTx}${tx.hash}`,
        };
      } else {
        return {
          success: false,
          txHash: tx.hash,
          error: 'Transaction reverted',
        };
      }
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Pay for a service (transfer USDC to service provider)
   * 
   * This is the main method for Agent-to-Agent payments.
   * Returns payment data ready to submit to service API.
   * 
   * @example
   * ```typescript
   * const wallet = new AgentWallet({ chain: 'base' });
   * 
   * // Pay for Zen7 video service
   * const payment = await wallet.payService({
   *   provider: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
   *   amount: 0.99,
   *   service: 'video_generation'
   * });
   * 
   * if (payment.success) {
   *   // Submit to service API
   *   await fetch('/v1/video/generate', {
   *     body: JSON.stringify({
   *       prompt: "...",
   *       payment: payment.paymentData  // Ready to use!
   *     })
   *   });
   * }
   * ```
   */
  async payService(params: {
    provider: string;
    amount: number;
    service?: string;
  }): Promise<{
    success: boolean;
    txHash?: string;
    error?: string;
    paymentData?: {
      method: 'transfer';
      chain: string;
      tx_hash: string;
    };
    explorerUrl?: string;
  }> {
    const result = await this.transfer({
      to: params.provider,
      amount: params.amount,
    });

    if (result.success && result.txHash) {
      return {
        success: true,
        txHash: result.txHash,
        explorerUrl: result.explorerUrl,
        paymentData: {
          method: 'transfer',
          chain: this.chain,
          tx_hash: result.txHash,
        },
      };
    } else {
      return {
        success: false,
        error: result.error,
      };
    }
  }

  /**
   * Get gas balance (ETH needed for transactions)
   */
  async getGasBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.address);
    return ethers.formatEther(balance);
  }

  /**
   * Check if agent has enough gas
   */
  async hasGas(minEth: number = 0.0005): Promise<boolean> {
    const balance = await this.getGasBalance();
    return parseFloat(balance) >= minEth;
  }

  /**
   * Generate authorization request for Owner
   * Owner can sign this with CLI (ethers) or MetaMask
   */
  async generateAuthRequest(params: {
    ownerAddress: string;
    amount: number;
    expiresInHours?: number;
  }): Promise<{
    message: string;
    typedData: object;
    cliCommand: string;
  }> {
    const { ownerAddress, amount, expiresInHours = 168 } = params;  // 1 week default
    const deadline = Math.floor(Date.now() / 1000) + expiresInHours * 3600;
    const value = BigInt(Math.floor(amount * 1e6)).toString();

    // Get owner's nonce
    const usdcContract = new ethers.Contract(
      this.chainConfig.usdc,
      PERMIT_ABI,
      this.provider
    );
    const nonce = Number(await usdcContract.nonces(ownerAddress));

    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId: this.chainConfig.chainId,
      verifyingContract: this.chainConfig.usdc,
    };

    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const permitMessage = {
      owner: ownerAddress,
      spender: this.address,
      value,
      nonce,
      deadline,
    };

    const typedData = {
      types: { ...types, EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ]},
      primaryType: 'Permit',
      domain,
      message: permitMessage,
    };

    // CLI command for signing (if owner has private key)
    const cliCommand = `npx moltspay sign-permit \\
  --owner ${ownerAddress} \\
  --spender ${this.address} \\
  --amount ${amount} \\
  --deadline ${deadline} \\
  --nonce ${nonce} \\
  --chain ${this.chain}`;

    const message = `🔐 Authorization Request

I need permission to spend up to ${amount} USDC from your wallet.

**Details:**
- Your wallet: ${ownerAddress}
- My address: ${this.address}
- Amount: ${amount} USDC
- Expires: ${new Date(deadline * 1000).toISOString()}
- Chain: ${this.chainConfig.name}

**Option 1: Sign with CLI** (if you have the private key)
\`\`\`
${cliCommand}
\`\`\`

**Option 2: Sign with MetaMask**
Visit: https://moltspay.vercel.app/permit?data=${encodeURIComponent(JSON.stringify(typedData))}

After signing, send me the signature (v, r, s).`;

    return { message, typedData, cliCommand };
  }
}

/**
 * Quick helper to get agent address (auto-initializes if needed)
 */
export function getAgentAddress(config?: AgentWalletConfig): string {
  const wallet = new AgentWallet(config);
  return wallet.address;
}
