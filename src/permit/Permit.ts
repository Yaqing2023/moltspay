/**
 * PermitPayment - EIP-2612 无 Gas 预授权
 * 
 * 让用户通过签名授权，服务方代付 Gas 执行 transferFrom
 */

import { ethers } from 'ethers';
import { getChain, ERC20_ABI } from '../chains/index.js';
import type {
  ChainName,
  ChainConfig,
  PermitRequest,
  PermitSignature,
  PermitExecuteResult,
  EIP712TypedData,
} from '../types/index.js';

export interface PermitConfig {
  chain?: ChainName;
  privateKey?: string;
  spenderAddress?: string;
  rpcUrl?: string;
}

export class PermitPayment {
  readonly chain: ChainName;
  readonly chainConfig: ChainConfig;
  readonly spenderAddress: string;
  
  private provider: ethers.JsonRpcProvider;
  private wallet?: ethers.Wallet;
  private usdcContract: ethers.Contract;

  constructor(config: PermitConfig = {}) {
    this.chain = config.chain || 'base_sepolia';
    this.chainConfig = getChain(this.chain);
    this.spenderAddress = config.spenderAddress || process.env.PAYMENT_AGENT_WALLET || '';

    const rpcUrl = config.rpcUrl || this.chainConfig.rpc;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);

    const privateKey = config.privateKey || process.env.PAYMENT_AGENT_PRIVATE_KEY;
    if (privateKey) {
      this.wallet = new ethers.Wallet(privateKey, this.provider);
      this.spenderAddress = this.wallet.address;
    }

    this.usdcContract = new ethers.Contract(
      this.chainConfig.usdc,
      ERC20_ABI,
      this.wallet || this.provider
    );
  }

  /**
   * 获取用户当前 nonce
   */
  async getNonce(owner: string): Promise<number> {
    return Number(await this.usdcContract.nonces(owner));
  }

  /**
   * 生成 EIP-712 签名请求（发给前端/用户钱包）
   */
  async createPermitRequest(
    owner: string,
    amount: number,
    orderId: string,
    deadlineMinutes: number = 30
  ): Promise<PermitRequest> {
    const nonce = await this.getNonce(owner);
    const deadline = Math.floor(Date.now() / 1000) + deadlineMinutes * 60;
    const value = BigInt(Math.floor(amount * 1e6)).toString();

    // USDC 的 EIP-712 domain（不同链可能不同）
    const domain = {
      name: 'USD Coin',
      version: '2',
      chainId: this.chainConfig.chainId,
      verifyingContract: this.chainConfig.usdc,
    };

    const types = {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const message = {
      owner,
      spender: this.spenderAddress,
      value,
      nonce,
      deadline,
    };

    const typedData: EIP712TypedData = {
      types,
      primaryType: 'Permit',
      domain,
      message,
    };

    return {
      type: 'permit_request',
      version: '1.0',
      order_id: orderId,
      typed_data: typedData,
    };
  }

  /**
   * 执行 permit + transferFrom
   * 
   * @param owner 用户地址
   * @param amount 金额
   * @param signature 用户签名 {v, r, s, deadline}
   */
  async executePermitAndTransfer(
    owner: string,
    amount: number,
    signature: PermitSignature
  ): Promise<PermitExecuteResult> {
    if (!this.wallet) {
      return { success: false, error: 'Wallet not configured. Private key required.' };
    }

    try {
      const value = BigInt(Math.floor(amount * 1e6));

      // 1. 调用 permit
      const permitTx = await this.usdcContract.permit(
        owner,
        this.spenderAddress,
        value,
        signature.deadline,
        signature.v,
        signature.r,
        signature.s
      );
      await permitTx.wait();

      // 2. 调用 transferFrom
      const transferTx = await this.usdcContract.transferFrom(owner, this.spenderAddress, value);
      const receipt = await transferTx.wait();

      return {
        success: receipt.status === 1,
        tx_hash: transferTx.hash,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 仅执行 permit（不 transfer）
   */
  async executePermit(
    owner: string,
    amount: number,
    signature: PermitSignature
  ): Promise<PermitExecuteResult> {
    if (!this.wallet) {
      return { success: false, error: 'Wallet not configured. Private key required.' };
    }

    try {
      const value = BigInt(Math.floor(amount * 1e6));

      const tx = await this.usdcContract.permit(
        owner,
        this.spenderAddress,
        value,
        signature.deadline,
        signature.v,
        signature.r,
        signature.s
      );
      const receipt = await tx.wait();

      return {
        success: receipt.status === 1,
        tx_hash: tx.hash,
      };
    } catch (error) {
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * 格式化 Permit 请求为用户消息
   */
  formatPermitMessage(request: PermitRequest): string {
    const { typed_data } = request;
    const { message } = typed_data;

    return `🔐 **签名授权请求**

授权 \`${(Number(message.value) / 1e6).toFixed(2)} USDC\` 给服务方

**签名信息：**
- Owner: \`${message.owner}\`
- Spender: \`${message.spender}\`
- Amount: ${(Number(message.value) / 1e6).toFixed(2)} USDC
- Deadline: ${new Date(message.deadline * 1000).toISOString()}

请在钱包中签名此请求（不消耗 Gas）。

\`\`\`json
${JSON.stringify(typed_data, null, 2)}
\`\`\``;
  }
}
