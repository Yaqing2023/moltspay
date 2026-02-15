/**
 * PermitPayment - EIP-2612 Gasless Pre-authorization
 * 
 * User signs authorization, service provider pays gas to execute transferFrom
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
   * Get user current nonce
   */
  async getNonce(owner: string): Promise<number> {
    return Number(await this.usdcContract.nonces(owner));
  }

  /**
   * Generate EIP-712 signing request (for frontend/user wallet)
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

    // USDC EIP-712 domain (may differ by chain)
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
   * Execute permit + transferFrom
   * 
   * @param owner User address
   * @param amount Amount
   * @param signature User signature {v, r, s, deadline}
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

      // 1. Call permit
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

      // 2. Call transferFrom
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
   * Execute permit only (no transfer)
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
   * Format Permit request as user message
   */
  formatPermitMessage(request: PermitRequest): string {
    const { typed_data } = request;
    const { message } = typed_data;

    return `🔐 **Signature Authorization Request**

Authorize \`${(Number(message.value) / 1e6).toFixed(2)} USDC\` to service provider

**Signature Details:**
- Owner: \`${message.owner}\`
- Spender: \`${message.spender}\`
- Amount: ${(Number(message.value) / 1e6).toFixed(2)} USDC
- Deadline: ${new Date(message.deadline * 1000).toISOString()}

Please sign this request in your wallet (no gas required).

\`\`\`json
${JSON.stringify(typed_data, null, 2)}
\`\`\``;
  }
}
