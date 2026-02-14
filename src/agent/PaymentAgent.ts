/**
 * PaymentAgent - 核心支付代理
 * 
 * 功能：
 * - 生成 Invoice（支付请求）
 * - 验证链上支付
 * - 生成钱包深度链接
 */

import { ethers } from 'ethers';
import { getChain, ERC20_ABI } from '../chains/index.js';
import type {
  PaymentAgentConfig,
  ChainName,
  ChainConfig,
  Invoice,
  CreateInvoiceParams,
  VerifyResult,
  VerifyOptions,
  WalletBalance,
} from '../types/index.js';

export class PaymentAgent {
  readonly chain: ChainName;
  readonly chainConfig: ChainConfig;
  readonly walletAddress: string;
  
  private provider: ethers.JsonRpcProvider;
  private usdcContract: ethers.Contract;
  
  static readonly PROTOCOL_VERSION = '1.0';

  constructor(config: PaymentAgentConfig = {}) {
    this.chain = config.chain || 'base_sepolia';
    this.chainConfig = getChain(this.chain);
    this.walletAddress = config.walletAddress || process.env.PAYMENT_AGENT_WALLET || '';
    
    if (!this.walletAddress) {
      throw new Error('walletAddress is required. Set via config or PAYMENT_AGENT_WALLET env var.');
    }

    const rpcUrl = config.rpcUrl || this.chainConfig.rpc;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.usdcContract = new ethers.Contract(
      this.chainConfig.usdc,
      ERC20_ABI,
      this.provider
    );
  }

  /**
   * 生成支付请求（Invoice）
   */
  createInvoice(params: CreateInvoiceParams): Invoice {
    const expiresMinutes = params.expiresMinutes || 30;
    const expiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000).toISOString();
    
    const invoice: Invoice = {
      type: 'payment_request',
      version: PaymentAgent.PROTOCOL_VERSION,
      order_id: params.orderId,
      service: params.service,
      description: params.description || `${params.service} service`,
      amount: params.amount.toFixed(2),
      token: 'USDC',
      chain: this.chain,
      chain_id: this.chainConfig.chainId,
      recipient: this.walletAddress,
      memo: params.orderId,
      expires_at: expiresAt,
      deep_link: this.generateDeepLink(params.amount, params.orderId),
      explorer_url: `${this.chainConfig.explorer}${this.walletAddress}`,
    };

    if (params.metadata) {
      invoice.metadata = params.metadata;
    }

    return invoice;
  }

  /**
   * 生成钱包深度链接（支持 MetaMask 等）
   */
  generateDeepLink(amount: number, memo: string): string {
    const amountWei = Math.floor(amount * 1e6); // USDC 6位小数
    return `https://metamask.app.link/send/${this.chainConfig.usdc}@${this.chainConfig.chainId}/transfer?address=${this.walletAddress}&uint256=${amountWei}`;
  }

  /**
   * 验证链上支付
   */
  async verifyPayment(txHash: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    try {
      // 确保 txHash 格式正确
      if (!txHash.startsWith('0x')) {
        txHash = '0x' + txHash;
      }

      const receipt = await this.provider.getTransactionReceipt(txHash);
      
      if (!receipt) {
        return { verified: false, error: 'Transaction not found', pending: true };
      }

      if (receipt.status !== 1) {
        return { verified: false, error: 'Transaction failed' };
      }

      // Transfer 事件签名
      const transferTopic = ethers.id('Transfer(address,address,uint256)');
      const usdcAddress = this.chainConfig.usdc.toLowerCase();

      for (const log of receipt.logs) {
        // 检查是否是 USDC 合约的 Transfer 事件
        if (
          log.address.toLowerCase() === usdcAddress &&
          log.topics.length >= 3 &&
          log.topics[0] === transferTopic
        ) {
          // 解析 from, to, amount
          const from = ethers.getAddress('0x' + log.topics[1].slice(-40));
          const to = ethers.getAddress('0x' + log.topics[2].slice(-40));
          const amountWei = BigInt(log.data);
          const amount = Number(amountWei) / 1e6;

          // 检查接收地址
          if (to.toLowerCase() !== this.walletAddress.toLowerCase()) {
            continue;
          }

          // 检查金额（允许误差）
          const tolerance = options.tolerance ?? 0.01;
          if (options.expectedAmount) {
            const diff = Math.abs(amount - options.expectedAmount);
            if (diff > options.expectedAmount * tolerance) {
              return {
                verified: false,
                error: `Amount mismatch: expected ${options.expectedAmount}, got ${amount}`,
              };
            }
          }

          const currentBlock = await this.provider.getBlockNumber();
          
          return {
            verified: true,
            tx_hash: txHash,
            amount: amount.toFixed(2),
            token: 'USDC',
            from,
            to,
            block_number: receipt.blockNumber,
            confirmations: currentBlock - receipt.blockNumber,
            explorer_url: `${this.chainConfig.explorerTx}${txHash}`,
          };
        }
      }

      return { verified: false, error: 'No USDC transfer to recipient found in transaction' };
    } catch (error) {
      return { verified: false, error: (error as Error).message };
    }
  }

  /**
   * 扫描最近转账（按金额匹配）
   */
  async scanRecentTransfers(expectedAmount: number, timeoutMinutes: number = 30): Promise<VerifyResult> {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      const blocksPerMinute = Math.ceil(60 / this.chainConfig.avgBlockTime);
      const fromBlock = currentBlock - (timeoutMinutes * blocksPerMinute);

      // 使用 getLogs 扫描 Transfer 事件
      const transferTopic = ethers.id('Transfer(address,address,uint256)');
      const recipientTopic = ethers.zeroPadValue(this.walletAddress, 32);

      const logs = await this.provider.getLogs({
        address: this.chainConfig.usdc,
        topics: [transferTopic, null, recipientTopic],
        fromBlock,
        toBlock: 'latest',
      });

      for (const log of logs) {
        const amountWei = BigInt(log.data);
        const amount = Number(amountWei) / 1e6;

        // 按金额匹配
        if (Math.abs(amount - expectedAmount) < 0.01) {
          const from = ethers.getAddress('0x' + log.topics[1].slice(-40));
          
          return {
            verified: true,
            tx_hash: log.transactionHash,
            amount: amount.toFixed(2),
            token: 'USDC',
            from,
            to: this.walletAddress,
            block_number: log.blockNumber,
            explorer_url: `${this.chainConfig.explorerTx}${log.transactionHash}`,
          };
        }
      }

      return { verified: false, error: 'No matching payment found' };
    } catch (error) {
      return { verified: false, error: (error as Error).message };
    }
  }

  /**
   * 获取钱包余额
   */
  async getBalance(address?: string): Promise<WalletBalance> {
    const addr = address || this.walletAddress;
    
    const [ethBalance, usdcBalance] = await Promise.all([
      this.provider.getBalance(addr),
      this.usdcContract.balanceOf(addr),
    ]);

    return {
      address: addr,
      eth: ethers.formatEther(ethBalance),
      usdc: (Number(usdcBalance) / 1e6).toFixed(2),
      chain: this.chain,
    };
  }

  /**
   * 格式化 Invoice 为人类可读消息
   */
  formatInvoiceMessage(invoice: Invoice, includeJson: boolean = true): string {
    let msg = `🎬 **Payment Request**

**Service:** ${invoice.service}
**Price:** ${invoice.amount} USDC (${this.chainConfig.name})

**💳 Payment Options:**

1️⃣ **Direct Transfer:**
   Send exactly \`${invoice.amount} USDC\` to:
   \`${invoice.recipient}\`
   (Network: ${this.chainConfig.name})

2️⃣ **One-Click Pay (MetaMask):**
   ${invoice.deep_link}

⏱️ Expires: ${invoice.expires_at}`;

    if (includeJson) {
      msg += `

3️⃣ **For AI Agents:**
\`\`\`json
${JSON.stringify(invoice, null, 2)}
\`\`\``;
    }

    msg += `

After payment, reply with your tx hash:
\`paid: 0x...\``;

    return msg;
  }
}
