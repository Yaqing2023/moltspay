/**
 * BNB Chain Facilitator
 * 
 * Handles pay-for-success payments on BNB Smart Chain.
 * 
 * Flow:
 * 1. Client pre-approves server wallet (one-time, via `moltspay init`)
 * 2. Client signs EIP-712 intent (no gas, just signature)
 * 3. Server verifies intent signature
 * 4. Server executes service
 * 5. Success → Server calls transferFrom (server pays gas)
 * 6. Failure → No transfer, client keeps money
 * 
 * Key difference from Tempo:
 * - Tempo: Client pays first → service might fail → money lost
 * - BNB: Service runs first → success = payment (pay-for-success)
 */

import {
  BaseFacilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
  SettleResult,
  HealthCheckResult,
} from './interface.js';
import { CHAINS, ChainConfig } from '../chains/index.js';
import { privateKeyToAccount } from 'viem/accounts';

// ERC20 Transfer event signature
const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// EIP-712 Domain
const EIP712_DOMAIN = {
  name: 'MoltsPay',
  version: '1',
};

// EIP-712 Types for Payment Intent
const INTENT_TYPES = {
  PaymentIntent: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'service', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// ERC20 ABI (minimal)
const ERC20_ABI = {
  transfer: 'function transfer(address to, uint256 amount) returns (bool)',
  transferFrom: 'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  allowance: 'function allowance(address owner, address spender) view returns (uint256)',
  balanceOf: 'function balanceOf(address account) view returns (uint256)',
  approve: 'function approve(address spender, uint256 amount) returns (bool)',
};

/**
 * BNB Payment Intent (signed by client)
 */
export interface BNBPaymentIntent {
  from: string;
  to: string;
  amount: string;
  token: string;
  service: string;
  nonce: number;
  deadline: number;
  signature: string;
}

/**
 * BNB Payment Payload (from client in x402 request)
 */
interface BNBPaymentPayload {
  intent: BNBPaymentIntent;
  chainId: number;
}

/**
 * BNB Chain Facilitator
 * 
 * Handles pay-for-success payments on BNB mainnet (chainId 56) and testnet (chainId 97).
 * Server wallet executes transferFrom after successful service delivery.
 */
export class BNBFacilitator extends BaseFacilitator {
  readonly name = 'bnb';
  readonly displayName = 'BNB Smart Chain';
  readonly supportedNetworks = ['eip155:56', 'eip155:97']; // Mainnet + Testnet

  private serverPrivateKey: string;
  private spenderAddress: string | null = null;
  private chainConfigs: { [key: number]: { rpc: string; chain: ChainConfig } };

  constructor(serverPrivateKey?: string) {
    super();
    this.serverPrivateKey = serverPrivateKey || process.env.BNB_SERVER_PRIVATE_KEY || '';
    
    // Pre-compute spender address synchronously using viem
    if (this.serverPrivateKey) {
      const key = this.serverPrivateKey.startsWith('0x') 
        ? this.serverPrivateKey as `0x${string}`
        : `0x${this.serverPrivateKey}` as `0x${string}`;
      const account = privateKeyToAccount(key);
      this.spenderAddress = account.address;
    }
    
    this.chainConfigs = {
      56: { rpc: CHAINS.bnb.rpc, chain: CHAINS.bnb },
      97: { rpc: CHAINS.bnb_testnet.rpc, chain: CHAINS.bnb_testnet },
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      // Check mainnet
      const response = await fetch(this.chainConfigs[56].rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_chainId',
          params: [],
          id: 1,
        }),
      });
      
      const data = await response.json() as { result: string };
      const chainId = parseInt(data.result, 16);
      
      if (chainId !== 56) {
        return { healthy: false, error: `Wrong chainId: ${chainId}` };
      }
      
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (error) {
      return { healthy: false, error: String(error) };
    }
  }

  /**
   * Verify a payment intent signature (before service execution)
   * 
   * This verifies:
   * 1. Signature is valid for the intent
   * 2. Client has approved server wallet
   * 3. Client has sufficient balance
   * 4. Intent hasn't expired
   */
  async verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult> {
    try {
      const bnbPayload = paymentPayload.payload as BNBPaymentPayload;
      
      if (!bnbPayload?.intent) {
        return { valid: false, error: 'Missing intent in payment payload' };
      }

      const { intent, chainId } = bnbPayload;
      const config = this.chainConfigs[chainId];
      
      if (!config) {
        return { valid: false, error: `Unsupported chainId: ${chainId}` };
      }

      // Check deadline
      if (intent.deadline < Date.now()) {
        return { valid: false, error: 'Intent expired' };
      }

      // Verify signature
      const recoveredAddress = await this.recoverIntentSigner(intent, chainId);
      if (recoveredAddress.toLowerCase() !== intent.from.toLowerCase()) {
        return { valid: false, error: 'Invalid signature' };
      }

      // Verify recipient matches
      if (intent.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
        return { valid: false, error: `Wrong recipient: ${intent.to}` };
      }

      // Verify amount matches
      if (BigInt(intent.amount) < BigInt(requirements.amount)) {
        return { valid: false, error: `Insufficient amount: ${intent.amount}` };
      }

      // Verify token matches
      if (intent.token.toLowerCase() !== requirements.asset.toLowerCase()) {
        return { valid: false, error: `Wrong token: ${intent.token}` };
      }

      // Check allowance
      const serverAddress = await this.getServerAddress();
      const allowance = await this.getAllowance(intent.from, serverAddress, intent.token, config.rpc);
      
      if (BigInt(allowance) < BigInt(intent.amount)) {
        return { valid: false, error: 'Insufficient allowance. Run: npx moltspay init --chain bnb' };
      }

      // Check balance
      const balance = await this.getBalance(intent.from, intent.token, config.rpc);
      if (BigInt(balance) < BigInt(intent.amount)) {
        return { valid: false, error: 'Insufficient balance' };
      }

      return { 
        valid: true, 
        details: {
          from: intent.from,
          to: intent.to,
          amount: intent.amount,
          token: intent.token,
          service: intent.service,
          nonce: intent.nonce,
          deadline: intent.deadline,
        }
      };
    } catch (error) {
      return { valid: false, error: `Verification failed: ${error}` };
    }
  }

  /**
   * Settle a payment by executing transferFrom
   * 
   * This is called AFTER the service has been successfully delivered.
   * Server pays gas, transfers tokens from client to provider.
   */
  async settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<SettleResult> {
    if (!this.serverPrivateKey) {
      return { success: false, error: 'Server wallet not configured (BNB_SERVER_PRIVATE_KEY)' };
    }

    try {
      // First verify the intent
      const verifyResult = await this.verify(paymentPayload, requirements);
      if (!verifyResult.valid) {
        return { success: false, error: verifyResult.error };
      }

      const bnbPayload = paymentPayload.payload as BNBPaymentPayload;
      const { intent, chainId } = bnbPayload;
      const config = this.chainConfigs[chainId];

      // Execute transferFrom
      const txHash = await this.executeTransferFrom(
        intent.from,
        intent.to,
        intent.amount,
        intent.token,
        config.rpc
      );

      return { 
        success: true, 
        transaction: txHash,
        status: 'settled'
      };
    } catch (error) {
      return { success: false, error: `Settlement failed: ${error}` };
    }
  }

  /**
   * Check if client has approved the server wallet
   */
  async checkApproval(
    clientAddress: string, 
    token: string, 
    chainId: number
  ): Promise<{ approved: boolean; allowance: string }> {
    const config = this.chainConfigs[chainId];
    if (!config) {
      throw new Error(`Unsupported chainId: ${chainId}`);
    }

    const serverAddress = await this.getServerAddress();
    const allowance = await this.getAllowance(clientAddress, serverAddress, token, config.rpc);
    
    // Consider approved if allowance > 1000 USDC (with 18 decimals)
    const minAllowance = BigInt('1000000000000000000000'); // 1000 tokens
    
    return {
      approved: BigInt(allowance) >= minAllowance,
      allowance,
    };
  }

  /**
   * Verify a completed transaction (for checking past payments)
   */
  async verifyTransaction(
    txHash: string, 
    expected: { to: string; amount: string; token: string },
    chainId: number
  ): Promise<VerifyResult> {
    const config = this.chainConfigs[chainId];
    if (!config) {
      return { valid: false, error: `Unsupported chainId: ${chainId}` };
    }

    try {
      const receipt = await this.getTransactionReceipt(txHash, config.rpc);
      
      if (!receipt) {
        return { valid: false, error: 'Transaction not found' };
      }

      if (receipt.status !== '0x1') {
        return { valid: false, error: 'Transaction failed' };
      }

      // Find Transfer event
      const transferLog = receipt.logs.find((log: any) => 
        log.topics[0] === TRANSFER_EVENT_TOPIC &&
        log.address.toLowerCase() === expected.token.toLowerCase()
      );

      if (!transferLog) {
        return { valid: false, error: 'No Transfer event found' };
      }

      // Verify recipient
      const toAddress = '0x' + transferLog.topics[2].slice(26).toLowerCase();
      if (toAddress !== expected.to.toLowerCase()) {
        return { valid: false, error: `Wrong recipient: ${toAddress}` };
      }

      // Verify amount
      const amount = BigInt(transferLog.data);
      if (amount < BigInt(expected.amount)) {
        return { valid: false, error: `Insufficient amount: ${amount}` };
      }

      return { 
        valid: true, 
        details: {
          txHash,
          from: '0x' + transferLog.topics[1].slice(26),
          to: toAddress,
          amount: amount.toString(),
          token: transferLog.address,
        }
      };
    } catch (error) {
      return { valid: false, error: `Verification failed: ${error}` };
    }
  }

  // ==================== Private Methods ====================

  /**
   * Get the server's spender address (public, for 402 responses)
   * Returns cached value computed at construction time.
   */
  getSpenderAddress(): string | null {
    return this.spenderAddress;
  }

  private async getServerAddress(): Promise<string> {
    // Derive address from private key using ethers
    const { ethers } = await import('ethers');
    const wallet = new ethers.Wallet(this.serverPrivateKey);
    return wallet.address;
  }

  private async recoverIntentSigner(intent: BNBPaymentIntent, chainId: number): Promise<string> {
    // Use ethers for EIP-712 signature recovery
    const { ethers } = await import('ethers');
    
    const domain = {
      ...EIP712_DOMAIN,
      chainId,
    };

    const message = {
      from: intent.from,
      to: intent.to,
      amount: intent.amount,
      token: intent.token,
      service: intent.service,
      nonce: intent.nonce,
      deadline: intent.deadline,
    };

    const recoveredAddress = ethers.verifyTypedData(
      domain,
      INTENT_TYPES,
      message,
      intent.signature
    );

    return recoveredAddress;
  }

  private async getAllowance(owner: string, spender: string, token: string, rpcUrl: string): Promise<string> {
    // allowance(address,address) selector + params
    const selector = '0xdd62ed3e';
    const ownerPadded = owner.toLowerCase().replace('0x', '').padStart(64, '0');
    const spenderPadded = spender.toLowerCase().replace('0x', '').padStart(64, '0');
    const data = selector + ownerPadded + spenderPadded;

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: token, data }, 'latest'],
        id: 1,
      }),
    });

    const result = await response.json() as { result: string };
    return result.result || '0x0';
  }

  private async getBalance(account: string, token: string, rpcUrl: string): Promise<string> {
    // balanceOf(address) selector + param
    const selector = '0x70a08231';
    const accountPadded = account.toLowerCase().replace('0x', '').padStart(64, '0');
    const data = selector + accountPadded;

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: token, data }, 'latest'],
        id: 1,
      }),
    });

    const result = await response.json() as { result: string };
    return result.result || '0x0';
  }

  private async executeTransferFrom(
    from: string,
    to: string,
    amount: string,
    token: string,
    rpcUrl: string
  ): Promise<string> {
    const { ethers } = await import('ethers');
    
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(this.serverPrivateKey, provider);
    
    const tokenContract = new ethers.Contract(token, [
      'function transferFrom(address from, address to, uint256 amount) returns (bool)',
    ], wallet);

    const tx = await tokenContract.transferFrom(from, to, amount);
    const receipt = await tx.wait();
    
    return receipt.hash;
  }

  private async getTransactionReceipt(txHash: string, rpcUrl: string): Promise<any> {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getTransactionReceipt',
        params: [txHash],
        id: 1,
      }),
    });

    const data = await response.json() as { result: any };
    return data.result;
  }
}

/**
 * Create EIP-712 typed data for signing a payment intent
 * 
 * Used by clients to sign their payment intent.
 */
export function createIntentTypedData(
  intent: Omit<BNBPaymentIntent, 'signature'>,
  chainId: number
) {
  return {
    domain: {
      ...EIP712_DOMAIN,
      chainId,
    },
    types: INTENT_TYPES,
    primaryType: 'PaymentIntent' as const,
    message: {
      from: intent.from,
      to: intent.to,
      amount: intent.amount,
      token: intent.token,
      service: intent.service,
      nonce: intent.nonce,
      deadline: intent.deadline,
    },
  };
}
