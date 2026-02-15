/**
 * PermitWallet - Pay using Boss's Permit authorization
 * 
 * Scenario:
 * - Agent doesn't have USDC, but Boss gave a Permit authorization
 * - Agent uses Permit signature + own wallet to execute transferFrom
 * - Agent only needs small amount of ETH for gas, USDC is deducted from Boss's wallet
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
  /** Boss's wallet address (USDC holder) */
  owner: string;
  /** Agent's wallet address (authorized spender) */
  spender: string;
  /** Authorized amount (USDC, raw 6 decimal value) */
  value: string;
  /** Expiration timestamp */
  deadline: number;
  /** Signature v */
  v: number;
  /** Signature r */
  r: string;
  /** Signature s */
  s: string;
}

export interface PermitWalletConfig {
  chain?: ChainName;
  /** Agent's private key (for executing transactions) */
  privateKey?: string;
  /** Load private key from file */
  walletPath?: string;
  /** Decryption password */
  walletPassword?: string;
  rpcUrl?: string;
}

export interface TransferWithPermitParams {
  /** Recipient address */
  to: string;
  /** Amount (USDC) */
  amount: number;
  /** Boss-signed Permit data */
  permit: PermitData;
}

export interface TransferWithPermitResult extends TransferResult {
  /** Permit transaction hash */
  permitTxHash?: string;
  /** Transfer transaction hash */
  transferTxHash?: string;
}

// Extended ABI to support permit and transferFrom
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
    
    // Get private key
    let privateKey = config.privateKey || process.env.PAYMENT_AGENT_PRIVATE_KEY;
    
    // Or load from file
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
   * Check if Permit is valid (current allowance)
   */
  async checkPermitAllowance(owner: string): Promise<string> {
    const allowance = await this.usdcContract.allowance(owner, this.address);
    return (Number(allowance) / 1e6).toFixed(2);
  }

  /**
   * Pay using Permit authorization
   * 
   * Flow:
   * 1. Call permit() to record Boss's authorization in the contract
   * 2. Call transferFrom() to transfer from Boss's wallet to recipient
   * 
   * @example
   * ```typescript
   * const wallet = new PermitWallet({ chain: 'base' });
   * 
   * // Boss-signed permit data
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
      // Validate addresses
      const toAddress = ethers.getAddress(to);
      const ownerAddress = ethers.getAddress(permit.owner);
      
      // Verify spender is this wallet
      if (ethers.getAddress(permit.spender).toLowerCase() !== this.address.toLowerCase()) {
        return {
          success: false,
          error: `Permit spender (${permit.spender}) doesn't match wallet address (${this.address})`,
        };
      }

      // Check deadline
      const now = Math.floor(Date.now() / 1000);
      if (permit.deadline < now) {
        return {
          success: false,
          error: `Permit expired at ${new Date(permit.deadline * 1000).toISOString()}`,
        };
      }

      // Convert amount
      const amountWei = BigInt(Math.floor(amount * 1e6));
      const permitValue = BigInt(permit.value);
      
      // Check if authorized amount is sufficient
      if (amountWei > permitValue) {
        return {
          success: false,
          error: `Permit value (${Number(permitValue) / 1e6} USDC) < transfer amount (${amount} USDC)`,
        };
      }

      // Check existing allowance
      const currentAllowance = await this.usdcContract.allowance(ownerAddress, this.address);
      
      let permitTxHash: string | undefined;
      
      // If allowance insufficient, execute permit first
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

      // Execute transferFrom
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
      
      // Parse common errors
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
   * Get ETH balance (for gas)
   */
  async getGasBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.address);
    return ethers.formatEther(balance);
  }

  /**
   * Check if there's enough gas
   */
  async hasEnoughGas(minEth: number = 0.001): Promise<boolean> {
    const balance = await this.getGasBalance();
    return parseFloat(balance) >= minEth;
  }
}

/**
 * Format Permit request message (to send to Boss)
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

  return `🔐 **USDC Spending Allowance Request**

${reason ? `**Purpose:** ${reason}\n` : ''}
**Authorization Details:**
- Authorized address (Agent): \`${agentAddress}\`
- Amount: ${amount} USDC
- Valid for: ${deadlineHours} hours
- Chain: ${chainConfig.name}

**Please sign the following EIP-2612 Permit with your wallet:**

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

After signing, send { v, r, s, deadline } to the Agent.

⚠️ Note: This authorization only allows the Agent to spend up to ${amount} USDC from your wallet. Your private key is never exposed.`;
}
