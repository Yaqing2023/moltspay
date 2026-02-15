/**
 * AllowanceWallet - Agent spends from Owner's wallet using Permit allowance
 * 
 * This is the recommended pattern for AI Agents:
 * 1. Owner signs EIP-2612 Permit in MetaMask (off-chain, no gas)
 * 2. Owner sends Permit data to Agent
 * 3. Agent stores Permit and spends within the allowance
 * 4. Agent only needs minimal ETH for gas, USDC stays in Owner's wallet
 * 
 * Benefits:
 * - Agent never holds significant funds
 * - Owner maintains custody of USDC
 * - Owner can revoke by spending/transferring USDC
 * - Clear audit trail of Agent spending
 */

import { ethers } from 'ethers';
import { getChain, ERC20_ABI } from '../chains/index.js';
import type { ChainName, ChainConfig } from '../types/index.js';

export interface OwnerPermit {
  /** Owner's wallet address (USDC holder, e.g., MetaMask) */
  owner: string;
  /** Authorized amount (raw, 6 decimals for USDC) */
  value: string;
  /** Expiration timestamp (Unix seconds) */
  deadline: number;
  /** Nonce used when signing */
  nonce: number;
  /** Signature components */
  v: number;
  r: string;
  s: string;
}

export interface AllowanceWalletConfig {
  chain?: ChainName;
  /** Agent's private key (only for gas, not for USDC) */
  privateKey: string;
  rpcUrl?: string;
}

export interface SpendParams {
  /** Recipient address (e.g., service provider) */
  to: string;
  /** Amount in USDC */
  amount: number;
  /** Owner's Permit (if not yet submitted on-chain) */
  permit?: OwnerPermit;
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

export interface AllowanceStatus {
  owner: string;
  agent: string;
  allowance: string;
  ownerBalance: string;
  agentGasBalance: string;
  canSpend: boolean;
  chain: string;
}

const PERMIT_ABI = [
  ...ERC20_ABI,
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
];

export class AllowanceWallet {
  readonly chain: ChainName;
  readonly chainConfig: ChainConfig;
  readonly address: string;  // Agent's address
  
  private wallet: ethers.Wallet;
  private provider: ethers.JsonRpcProvider;
  private usdcContract: ethers.Contract;
  
  /** Stored permits from owners */
  private permits: Map<string, OwnerPermit> = new Map();

  constructor(config: AllowanceWalletConfig) {
    this.chain = config.chain || 'base_sepolia';
    this.chainConfig = getChain(this.chain);
    
    const rpcUrl = config.rpcUrl || this.chainConfig.rpc;
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.address = this.wallet.address;
    
    this.usdcContract = new ethers.Contract(
      this.chainConfig.usdc,
      PERMIT_ABI,
      this.wallet
    );
  }

  /**
   * Store a Permit received from Owner
   * Call this when Owner sends you a signed Permit
   */
  storePermit(permit: OwnerPermit): void {
    const ownerLower = permit.owner.toLowerCase();
    this.permits.set(ownerLower, permit);
  }

  /**
   * Get stored Permit for an owner
   */
  getPermit(owner: string): OwnerPermit | undefined {
    return this.permits.get(owner.toLowerCase());
  }

  /**
   * Check allowance status with an owner
   */
  async checkAllowance(owner: string): Promise<AllowanceStatus> {
    const ownerAddress = ethers.getAddress(owner);
    
    const [allowance, ownerBalance, agentGasBalance] = await Promise.all([
      this.usdcContract.allowance(ownerAddress, this.address),
      this.usdcContract.balanceOf(ownerAddress),
      this.provider.getBalance(this.address),
    ]);

    const allowanceNum = Number(allowance) / 1e6;
    const hasGas = Number(ethers.formatEther(agentGasBalance)) >= 0.0001;

    return {
      owner: ownerAddress,
      agent: this.address,
      allowance: allowanceNum.toFixed(2),
      ownerBalance: (Number(ownerBalance) / 1e6).toFixed(2),
      agentGasBalance: ethers.formatEther(agentGasBalance),
      canSpend: allowanceNum > 0 && hasGas,
      chain: this.chainConfig.name,
    };
  }

  /**
   * Spend from Owner's wallet using Permit allowance
   * 
   * @example
   * ```typescript
   * const agent = new AllowanceWallet({ 
   *   chain: 'base',
   *   privateKey: process.env.AGENT_KEY  // Only needs gas
   * });
   * 
   * // Owner gave us a Permit
   * agent.storePermit(ownerPermit);
   * 
   * // Spend to pay for a service
   * const result = await agent.spend({
   *   to: '0xServiceProvider...',
   *   amount: 2.99,
   * });
   * ```
   */
  async spend(params: SpendParams): Promise<SpendResult> {
    const { to, amount, permit } = params;

    try {
      const toAddress = ethers.getAddress(to);
      const amountWei = BigInt(Math.floor(amount * 1e6));

      // Find owner's permit
      let ownerPermit = permit;
      let ownerAddress: string;

      if (ownerPermit) {
        ownerAddress = ethers.getAddress(ownerPermit.owner);
        // Store for future use
        this.storePermit(ownerPermit);
      } else {
        // Try to find a stored permit with sufficient allowance
        for (const [owner, p] of this.permits) {
          const allowance = await this.usdcContract.allowance(owner, this.address);
          if (BigInt(allowance) >= amountWei) {
            ownerAddress = ethers.getAddress(owner);
            ownerPermit = p;
            break;
          }
        }
        
        if (!ownerPermit) {
          return {
            success: false,
            error: 'No valid permit found. Ask Owner to sign a Permit first.',
            from: '',
            to: toAddress,
            amount,
          };
        }
      }

      // Check current on-chain allowance
      const currentAllowance = await this.usdcContract.allowance(ownerAddress!, this.address);

      // If allowance insufficient, submit permit first
      if (BigInt(currentAllowance) < amountWei) {
        // Check if permit is still valid
        const now = Math.floor(Date.now() / 1000);
        if (ownerPermit.deadline < now) {
          return {
            success: false,
            error: `Permit expired at ${new Date(ownerPermit.deadline * 1000).toISOString()}. Ask Owner for a new Permit.`,
            from: ownerAddress!,
            to: toAddress,
            amount,
          };
        }

        // Check nonce
        const currentNonce = await this.usdcContract.nonces(ownerAddress!);
        if (Number(currentNonce) !== ownerPermit.nonce) {
          return {
            success: false,
            error: `Permit nonce mismatch (expected ${ownerPermit.nonce}, got ${currentNonce}). Owner may have used this permit or signed a new one.`,
            from: ownerAddress!,
            to: toAddress,
            amount,
          };
        }

        // Submit permit on-chain
        console.log('[AllowanceWallet] Submitting permit on-chain...');
        const permitTx = await this.usdcContract.permit(
          ownerAddress!,
          this.address,
          ownerPermit.value,
          ownerPermit.deadline,
          ownerPermit.v,
          ownerPermit.r,
          ownerPermit.s
        );
        await permitTx.wait();
        console.log('[AllowanceWallet] Permit submitted:', permitTx.hash);
      }

      // Execute transferFrom (spend from Owner's wallet)
      console.log('[AllowanceWallet] Executing transferFrom...');
      const tx = await this.usdcContract.transferFrom(
        ownerAddress!,
        toAddress,
        amountWei
      );
      const receipt = await tx.wait();

      // Check remaining allowance
      const newAllowance = await this.usdcContract.allowance(ownerAddress!, this.address);

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
      const message = (error as Error).message;
      
      if (message.includes('ERC20InsufficientAllowance')) {
        return {
          success: false,
          error: 'Insufficient allowance. Ask Owner to sign a new Permit with higher amount.',
          from: '',
          to,
          amount,
        };
      }
      if (message.includes('ERC20InsufficientBalance')) {
        return {
          success: false,
          error: "Owner's wallet has insufficient USDC balance.",
          from: '',
          to,
          amount,
        };
      }
      
      return {
        success: false,
        error: message,
        from: '',
        to,
        amount,
      };
    }
  }

  /**
   * Get Agent's gas balance (ETH)
   */
  async getGasBalance(): Promise<string> {
    const balance = await this.provider.getBalance(this.address);
    return ethers.formatEther(balance);
  }
}

/**
 * Generate instructions for Owner to sign a Permit in MetaMask
 * 
 * Owner can use this with eth_signTypedData_v4 in any web3 wallet
 */
export function generatePermitInstructions(params: {
  ownerAddress: string;
  agentAddress: string;
  amount: number;
  deadlineHours?: number;
  chain?: ChainName;
}): {
  instructions: string;
  typedData: object;
  eip712Domain: object;
} {
  const { ownerAddress, agentAddress, amount, deadlineHours = 24, chain = 'base' } = params;
  const chainConfig = getChain(chain);
  const deadline = Math.floor(Date.now() / 1000) + deadlineHours * 3600;
  const value = BigInt(Math.floor(amount * 1e6)).toString();

  const eip712Domain = {
    name: 'USD Coin',
    version: '2',
    chainId: chainConfig.chainId,
    verifyingContract: chainConfig.usdc,
  };

  const typedData = {
    types: {
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
    },
    primaryType: 'Permit',
    domain: eip712Domain,
    message: {
      owner: ownerAddress,
      spender: agentAddress,
      value: value,
      nonce: '<GET_FROM_USDC_CONTRACT>',  // Owner needs to query this
      deadline: deadline,
    },
  };

  const instructions = `
🔐 **Grant USDC Spending Allowance to Your Agent**

Your Agent (${agentAddress}) is requesting permission to spend up to ${amount} USDC from your wallet.

**What this does:**
- Allows your Agent to pay for services on your behalf
- Your USDC stays in YOUR wallet until spent
- Agent can only spend up to the authorized amount
- Expires in ${deadlineHours} hours
- You can revoke anytime by moving your USDC

**How to sign (MetaMask / any web3 wallet):**

1. Go to https://etherscan.io/address/${chainConfig.usdc}#readContract
2. Query \`nonces(${ownerAddress})\` to get your current nonce
3. Use eth_signTypedData_v4 with the data below (replace nonce)
4. Send the signature {v, r, s, deadline, nonce} to your Agent

**Chain:** ${chainConfig.name}
**USDC Contract:** ${chainConfig.usdc}

**EIP-712 Typed Data:**
\`\`\`json
${JSON.stringify(typedData, null, 2)}
\`\`\`

⚠️ Never share your private key. This signature only authorizes spending, not wallet access.
`;

  return { instructions, typedData, eip712Domain };
}
