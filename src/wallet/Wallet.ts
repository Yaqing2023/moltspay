/**
 * Wallet - Basic Custody Wallet
 * 
 * Features:
 * - Query balance (USDC, USDT, ETH)
 * - Send token transfers (USDC or USDT)
 */

import { ethers } from 'ethers';
import { getChain, ERC20_ABI } from '../chains/index.js';
import type {
  EvmChainName,
  ChainConfig,
  WalletBalance,
  TransferResult,
  TokenSymbol,
} from '../types/index.js';

export interface WalletConfig {
  chain?: EvmChainName;
  privateKey?: string;
  rpcUrl?: string;
}

export class Wallet {
  readonly chain: EvmChainName;
  readonly chainConfig: ChainConfig;
  readonly address: string;
  
  private wallet: ethers.Wallet;
  private provider: ethers.JsonRpcProvider;
  private tokenContracts: Record<TokenSymbol, ethers.Contract>;

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
    
    // Initialize token contracts
    this.tokenContracts = {
      USDC: new ethers.Contract(
        this.chainConfig.tokens.USDC.address,
        ERC20_ABI,
        this.wallet
      ),
      USDT: new ethers.Contract(
        this.chainConfig.tokens.USDT.address,
        ERC20_ABI,
        this.wallet
      ),
    };
  }

  /**
   * Get wallet balance for all tokens
   */
  async getBalance(): Promise<WalletBalance> {
    const [ethBalance, usdcBalance, usdtBalance] = await Promise.all([
      this.provider.getBalance(this.address),
      this.tokenContracts.USDC.balanceOf(this.address),
      this.tokenContracts.USDT.balanceOf(this.address),
    ]);

    return {
      address: this.address,
      eth: ethers.formatEther(ethBalance),
      usdc: (Number(usdcBalance) / 1e6).toFixed(2),
      usdt: (Number(usdtBalance) / 1e6).toFixed(2),
      chain: this.chain,
    };
  }

  /**
   * Send token transfer (USDC or USDT)
   * @param to - recipient address
   * @param amount - amount to send
   * @param token - token to send (default: USDC)
   */
  async transfer(to: string, amount: number, token: TokenSymbol = 'USDC'): Promise<TransferResult> {
    try {
      // Validate address
      to = ethers.getAddress(to);
      
      // Get token contract and config
      const tokenContract = this.tokenContracts[token];
      const tokenConfig = this.chainConfig.tokens[token];
      
      if (!tokenContract || !tokenConfig) {
        return {
          success: false,
          error: `Token ${token} not supported on ${this.chain}`,
        };
      }
      
      // Convert amount (both USDC and USDT have 6 decimals)
      const decimals = tokenConfig.decimals;
      const amountWei = BigInt(Math.floor(amount * (10 ** decimals)));

      // Check balance
      const balance = await tokenContract.balanceOf(this.address);
      if (BigInt(balance) < amountWei) {
        return {
          success: false,
          error: `Insufficient ${token} balance: ${Number(balance) / (10 ** decimals)} < ${amount}`,
        };
      }

      // Send transaction
      const tx = await tokenContract.transfer(to, amountWei);
      const receipt = await tx.wait();

      if (receipt.status === 1) {
        return {
          success: true,
          tx_hash: tx.hash,
          from: this.address,
          to,
          amount,
          token,
          gas_used: Number(receipt.gasUsed),
          block_number: receipt.blockNumber,
          explorer_url: `${this.chainConfig.explorerTx}${tx.hash}`,
        };
      } else {
        return {
          success: false,
          tx_hash: tx.hash,
          token,
          error: 'Transaction reverted',
        };
      }
    } catch (error) {
      return {
        success: false,
        token,
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
   * Get token balance
   * @param token - token symbol (default: USDC)
   */
  async getTokenBalance(token: TokenSymbol = 'USDC'): Promise<string> {
    const tokenContract = this.tokenContracts[token];
    const tokenConfig = this.chainConfig.tokens[token];
    const balance = await tokenContract.balanceOf(this.address);
    return (Number(balance) / (10 ** tokenConfig.decimals)).toFixed(2);
  }

  /**
   * @deprecated Use getTokenBalance('USDC') instead
   */
  async getUsdcBalance(): Promise<string> {
    return this.getTokenBalance('USDC');
  }
}
