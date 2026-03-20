/**
 * Tempo Testnet Facilitator
 * 
 * Verifies payments on Tempo Moderato testnet by checking transaction receipts.
 * Unlike CDP facilitator, this directly verifies on-chain without a third-party service.
 */

import {
  BaseFacilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
  SettleResult,
  HealthCheckResult,
} from './interface.js';
import { CHAINS } from '../chains/index.js';

// TIP-20 Transfer event signature
const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

interface TempoPaymentPayload {
  txHash: string;
  chainId: number;
}

/**
 * Tempo Testnet Facilitator
 * 
 * Verifies TIP-20 token transfers on Tempo Moderato (chainId 42431).
 */
export class TempoFacilitator extends BaseFacilitator {
  readonly name = 'tempo';
  readonly displayName = 'Tempo Testnet';
  readonly supportedNetworks = ['eip155:42431']; // Tempo Moderato

  private rpcUrl: string;

  constructor() {
    super();
    this.rpcUrl = CHAINS.tempo_moderato.rpc;
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const response = await fetch(this.rpcUrl, {
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
      
      if (chainId !== 42431) {
        return { healthy: false, error: `Wrong chainId: ${chainId}` };
      }
      
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (error) {
      return { healthy: false, error: String(error) };
    }
  }

  async verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult> {
    try {
      // Extract Tempo-specific payload
      const tempoPayload = paymentPayload.payload as TempoPaymentPayload;
      
      if (!tempoPayload?.txHash) {
        return { valid: false, error: 'Missing txHash in payment payload' };
      }

      // Get transaction receipt
      const receipt = await this.getTransactionReceipt(tempoPayload.txHash);
      
      if (!receipt) {
        return { valid: false, error: 'Transaction not found' };
      }

      if (receipt.status !== '0x1') {
        return { valid: false, error: 'Transaction failed' };
      }

      // Find Transfer event
      const transferLog = receipt.logs.find((log: any) => 
        log.topics[0] === TRANSFER_EVENT_TOPIC
      );

      if (!transferLog) {
        return { valid: false, error: 'No Transfer event found' };
      }

      // Verify recipient (topic[2] is 'to' address, padded to 32 bytes)
      const toAddress = '0x' + transferLog.topics[2].slice(26).toLowerCase();
      const expectedTo = requirements.payTo.toLowerCase();
      
      if (toAddress !== expectedTo) {
        return { 
          valid: false, 
          error: `Wrong recipient: ${toAddress}, expected ${expectedTo}` 
        };
      }

      // Verify amount (data field contains the amount)
      const amount = BigInt(transferLog.data);
      const expectedAmount = BigInt(requirements.amount);
      
      if (amount < expectedAmount) {
        return { 
          valid: false, 
          error: `Insufficient amount: ${amount}, expected ${expectedAmount}` 
        };
      }

      // Verify token address
      const tokenAddress = transferLog.address.toLowerCase();
      const expectedToken = requirements.asset.toLowerCase();
      
      if (tokenAddress !== expectedToken) {
        return { 
          valid: false, 
          error: `Wrong token: ${tokenAddress}, expected ${expectedToken}` 
        };
      }

      return { 
        valid: true, 
        details: {
          txHash: tempoPayload.txHash,
          from: '0x' + transferLog.topics[1].slice(26),
          to: toAddress,
          amount: amount.toString(),
          token: tokenAddress,
        }
      };
    } catch (error) {
      return { valid: false, error: `Verification failed: ${error}` };
    }
  }

  async settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<SettleResult> {
    // For Tempo, the client already executed the transaction
    // We just verify and report success
    const verifyResult = await this.verify(paymentPayload, requirements);
    
    if (!verifyResult.valid) {
      return { success: false, error: verifyResult.error };
    }

    const tempoPayload = paymentPayload.payload as TempoPaymentPayload;
    
    return { 
      success: true, 
      transaction: tempoPayload.txHash,
      status: 'settled'
    };
  }

  private async getTransactionReceipt(txHash: string): Promise<any> {
    const response = await fetch(this.rpcUrl, {
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
