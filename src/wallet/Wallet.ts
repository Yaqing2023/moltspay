/**
 * Wallet - Basic Custody Wallet
 * 
 * Features:
 * - Query balance
 * - Send USDC transfer
 */

import { ethers } from 'ethers';
import { getChain, ERC20_ABI } from '../chains/index.js';
import type {
  ChainName,
  ChainConfig,
  WalletBalance,
  TransferResult,
} from '../types/index.js';

export interface WalletConfig {
  chain?: ChainName;
  privateKey?: string;
  rpcUrl?: string;
}

export class Wallet {
  readonly chain: ChainName;
  readonly chainConfig: ChainConfig;
  readonly address: string;
  
  private wallet: ethers.Wallet;
  private provider: ethers.JsonRpcProvider;
  private usdcContract: ethers.Contract;

  constructor(config: WalletConfig = {}) {
    this.chain = config.chain || 'base_sepolia';
    this.chainConfig = getChain(this.chain);
    
    const privateKey = config.privateKey || process.env.PAYMENT_AGENT_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('privateKey is required. Set via config or PAYMENT_AGENT_PRIVATE_KEY env var.');
    }

    const rpcUrl = config.rpcUrl || this.chainConfig.rpc;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
    
    this.usdcContract = new ethers.Contract(
      this.chainConfig.usdc,
      ERC20_ABI,
      this.wallet
    );
  }

  /**
   * Get wallet balance
   */
  async getBalance(): Promise<WalletBalance> {
    const [ethBalance, usdcBalance] = await Promise.all([
      this.provider.getBalance(this.address),
      this.usdcContract.balanceOf(this.address),
    ]);

    return {
      address: this.address,
      eth: ethers.formatEther(ethBalance),
      usdc: (Number(usdcBalance) / 1e6).toFixed(2),
      chain: this.chain,
    };
  }

  /**
   * Send USDC transfer
   */
  async transfer(to: string, amount: number): Promise<TransferResult> {
    try {
      // Validate address
      to = ethers.getAddress(to);
      
      // Convert amount (USDC 6 decimals)
      const amountWei = BigInt(Math.floor(amount * 1e6));

      // Check balance
      const balance = await this.usdcContract.balanceOf(this.address);
      if (BigInt(balance) < amountWei) {
        return {
          success: false,
          error: `Insufficient USDC balance: ${Number(balance) / 1e6} < ${amount}`,
        };
      }

      // Send transaction
      const tx = await this.usdcContract.transfer(to, amountWei);
      const receipt = await tx.wait();

      if (receipt.status === 1) {
        return {
          success: true,
          tx_hash: tx.hash,
          from: this.address,
          to,
          amount,
          gas_used: Number(receipt.gasUsed),
          block_number: receipt.blockNumber,
          explorer_url: `${this.chainConfig.explorerTx}${tx.hash}`,
        };
      } else {
        return {
          success: false,
          tx_hash: tx.hash,
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
   * Get ETH balance
   */
  async getEthBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.address);
    return ethers.formatEther(balance);
  }

  /**
   * Get USDC balance
   */
  async getUsdcBalance(): Promise<string> {
    const balance = await this.usdcContract.balanceOf(this.address);
    return (Number(balance) / 1e6).toFixed(2);
  }
}
