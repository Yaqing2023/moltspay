/**
 * Wallet - 基础托管钱包
 * 
 * 功能：
 * - 查询余额
 * - 发送 USDC 转账
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
   * 获取钱包余额
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
   * 发送 USDC 转账
   */
  async transfer(to: string, amount: number): Promise<TransferResult> {
    try {
      // 验证地址
      to = ethers.getAddress(to);
      
      // 转换金额（USDC 6位小数）
      const amountWei = BigInt(Math.floor(amount * 1e6));

      // 检查余额
      const balance = await this.usdcContract.balanceOf(this.address);
      if (BigInt(balance) < amountWei) {
        return {
          success: false,
          error: `Insufficient USDC balance: ${Number(balance) / 1e6} < ${amount}`,
        };
      }

      // 发送交易
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
   * 获取 ETH 余额
   */
  async getEthBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.address);
    return ethers.formatEther(balance);
  }

  /**
   * 获取 USDC 余额
   */
  async getUsdcBalance(): Promise<string> {
    const balance = await this.usdcContract.balanceOf(this.address);
    return (Number(balance) / 1e6).toFixed(2);
  }
}
