/**
 * PermitWallet - 使用 Boss 授权的 Permit 进行支付
 * 
 * 场景：
 * - Agent 没有自己的 USDC，但 Boss 给了 Permit 授权
 * - Agent 使用 Permit 签名 + 自己的钱包执行 transferFrom
 * - Agent 只需要少量 ETH 付 gas，USDC 从 Boss 钱包扣除
 */

import { ethers } from 'ethers';
import { getChain, ERC20_ABI } from '../chains/index.js';
import { loadWallet } from './createWallet.js';
import type {
  ChainName,
  ChainConfig,
  TransferResult,
  PermitSignature,
} from '../types/index.js';

export interface PermitData {
  /** Boss 的钱包地址（USDC 持有者） */
  owner: string;
  /** Agent 的钱包地址（被授权者） */
  spender: string;
  /** 授权金额（USDC，6位小数的原始值） */
  value: string;
  /** 过期时间戳 */
  deadline: number;
  /** 签名 v */
  v: number;
  /** 签名 r */
  r: string;
  /** 签名 s */
  s: string;
}

export interface PermitWalletConfig {
  chain?: ChainName;
  /** Agent 的私钥（用于执行交易） */
  privateKey?: string;
  /** 从文件加载私钥 */
  walletPath?: string;
  /** 解密密码 */
  walletPassword?: string;
  rpcUrl?: string;
}

export interface TransferWithPermitParams {
  /** 收款地址 */
  to: string;
  /** 金额（USDC） */
  amount: number;
  /** Boss 签署的 Permit 数据 */
  permit: PermitData;
}

export interface TransferWithPermitResult extends TransferResult {
  /** Permit 交易 hash */
  permitTxHash?: string;
  /** Transfer 交易 hash */
  transferTxHash?: string;
}

// 扩展 ABI 以支持 permit 和 transferFrom
const PERMIT_ABI = [
  ...ERC20_ABI,
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export class PermitWallet {
  readonly chain: ChainName;
  readonly chainConfig: ChainConfig;
  readonly address: string;
  
  private wallet: ethers.Wallet;
  private provider: ethers.JsonRpcProvider;
  private usdcContract: ethers.Contract;

  constructor(config: PermitWalletConfig = {}) {
    this.chain = config.chain || 'base_sepolia';
    this.chainConfig = getChain(this.chain);
    
    // 获取私钥
    let privateKey = config.privateKey || process.env.PAYMENT_AGENT_PRIVATE_KEY;
    
    // 或从文件加载
    if (!privateKey && config.walletPath) {
      const loaded = loadWallet({ 
        storagePath: config.walletPath, 
        password: config.walletPassword 
      });
      if (!loaded.success || !loaded.privateKey) {
        throw new Error(loaded.error || 'Failed to load wallet');
      }
      privateKey = loaded.privateKey;
    }
    
    if (!privateKey) {
      throw new Error('privateKey is required. Set via config, env var, or walletPath.');
    }

    const rpcUrl = config.rpcUrl || this.chainConfig.rpc;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.address = this.wallet.address;
    
    this.usdcContract = new ethers.Contract(
      this.chainConfig.usdc,
      PERMIT_ABI,
      this.wallet
    );
  }

  /**
   * 检查 Permit 是否有效
   */
  async checkPermitAllowance(owner: string): Promise<string> {
    const allowance = await this.usdcContract.allowance(owner, this.address);
    return (Number(allowance) / 1e6).toFixed(2);
  }

  /**
   * 使用 Permit 授权进行支付
   * 
   * 流程：
   * 1. 调用 permit() 让合约记录 Boss 的授权
   * 2. 调用 transferFrom() 从 Boss 钱包转账到收款方
   * 
   * @example
   * ```typescript
   * const wallet = new PermitWallet({ chain: 'base' });
   * 
   * // Boss 签署的 permit 数据
   * const permit = {
   *   owner: '0xBOSS...',
   *   spender: wallet.address,
   *   value: '10000000', // 10 USDC
   *   deadline: 1234567890,
   *   v: 27,
   *   r: '0x...',
   *   s: '0x...'
   * };
   * 
   * const result = await wallet.transferWithPermit({
   *   to: '0xSELLER...',
   *   amount: 3.99,
   *   permit
   * });
   * ```
   */
  async transferWithPermit(params: TransferWithPermitParams): Promise<TransferWithPermitResult> {
    const { to, amount, permit } = params;

    try {
      // 验证地址
      const toAddress = ethers.getAddress(to);
      const ownerAddress = ethers.getAddress(permit.owner);
      
      // 验证 spender 是本钱包
      if (ethers.getAddress(permit.spender).toLowerCase() !== this.address.toLowerCase()) {
        return {
          success: false,
          error: `Permit spender (${permit.spender}) doesn't match wallet address (${this.address})`,
        };
      }

      // 检查 deadline
      const now = Math.floor(Date.now() / 1000);
      if (permit.deadline < now) {
        return {
          success: false,
          error: `Permit expired at ${new Date(permit.deadline * 1000).toISOString()}`,
        };
      }

      // 转换金额
      const amountWei = BigInt(Math.floor(amount * 1e6));
      const permitValue = BigInt(permit.value);
      
      // 检查授权金额是否足够
      if (amountWei > permitValue) {
        return {
          success: false,
          error: `Permit value (${Number(permitValue) / 1e6} USDC) < transfer amount (${amount} USDC)`,
        };
      }

      // 检查现有 allowance
      const currentAllowance = await this.usdcContract.allowance(ownerAddress, this.address);
      
      let permitTxHash: string | undefined;
      
      // 如果 allowance 不足，先执行 permit
      if (BigInt(currentAllowance) < amountWei) {
        console.log('Executing permit...');
        const permitTx = await this.usdcContract.permit(
          ownerAddress,
          this.address,
          permitValue,
          permit.deadline,
          permit.v,
          permit.r,
          permit.s
        );
        const permitReceipt = await permitTx.wait();
        
        if (permitReceipt.status !== 1) {
          return {
            success: false,
            error: 'Permit transaction failed',
            permitTxHash: permitTx.hash,
          };
        }
        permitTxHash = permitTx.hash;
        console.log('Permit executed:', permitTxHash);
      }

      // 执行 transferFrom
      console.log('Executing transferFrom...');
      const transferTx = await this.usdcContract.transferFrom(
        ownerAddress,
        toAddress,
        amountWei
      );
      const transferReceipt = await transferTx.wait();

      if (transferReceipt.status === 1) {
        return {
          success: true,
          tx_hash: transferTx.hash,
          permitTxHash,
          transferTxHash: transferTx.hash,
          from: ownerAddress,
          to: toAddress,
          amount,
          gas_used: Number(transferReceipt.gasUsed),
          block_number: transferReceipt.blockNumber,
          explorer_url: `${this.chainConfig.explorerTx}${transferTx.hash}`,
        };
      } else {
        return {
          success: false,
          error: 'TransferFrom transaction failed',
          tx_hash: transferTx.hash,
          permitTxHash,
        };
      }
    } catch (error) {
      const message = (error as Error).message;
      
      // 解析常见错误
      if (message.includes('ERC20InsufficientAllowance')) {
        return {
          success: false,
          error: 'Insufficient allowance. Permit may have been used or expired.',
        };
      }
      if (message.includes('ERC20InsufficientBalance')) {
        return {
          success: false,
          error: 'Boss wallet has insufficient USDC balance.',
        };
      }
      if (message.includes('InvalidSignature') || message.includes('invalid signature')) {
        return {
          success: false,
          error: 'Invalid permit signature. Ask Boss to re-sign.',
        };
      }
      
      return {
        success: false,
        error: message,
      };
    }
  }

  /**
   * 获取 ETH 余额（用于支付 gas）
   */
  async getGasBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.address);
    return ethers.formatEther(balance);
  }

  /**
   * 检查是否有足够的 gas
   */
  async hasEnoughGas(minEth: number = 0.001): Promise<boolean> {
    const balance = await this.getGasBalance();
    return parseFloat(balance) >= minEth;
  }
}

/**
 * 格式化 Permit 请求消息（发给 Boss）
 */
export function formatPermitRequest(params: {
  agentAddress: string;
  amount: number;
  deadlineHours?: number;
  chain?: ChainName;
  reason?: string;
}): string {
  const { agentAddress, amount, deadlineHours = 24, chain = 'base', reason } = params;
  const chainConfig = getChain(chain);
  const deadline = Math.floor(Date.now() / 1000) + deadlineHours * 3600;
  const value = BigInt(Math.floor(amount * 1e6)).toString();

  return `🔐 **USDC 支付额度授权请求**

${reason ? `**用途:** ${reason}\n` : ''}
**授权详情:**
- 被授权地址 (Agent): \`${agentAddress}\`
- 授权金额: ${amount} USDC
- 有效期: ${deadlineHours} 小时
- 链: ${chainConfig.name}

**请使用钱包签署以下 EIP-2612 Permit:**

\`\`\`json
{
  "types": {
    "Permit": [
      { "name": "owner", "type": "address" },
      { "name": "spender", "type": "address" },
      { "name": "value", "type": "uint256" },
      { "name": "nonce", "type": "uint256" },
      { "name": "deadline", "type": "uint256" }
    ]
  },
  "primaryType": "Permit",
  "domain": {
    "name": "USD Coin",
    "version": "2",
    "chainId": ${chainConfig.chainId},
    "verifyingContract": "${chainConfig.usdc}"
  },
  "message": {
    "owner": "<YOUR_WALLET_ADDRESS>",
    "spender": "${agentAddress}",
    "value": "${value}",
    "nonce": "<GET_FROM_CONTRACT>",
    "deadline": ${deadline}
  }
}
\`\`\`

签名后，请将 { v, r, s, deadline } 发给 Agent。

⚠️ 注意：此授权仅允许 Agent 从您的钱包支付最多 ${amount} USDC，不会泄露私钥。`;
}
