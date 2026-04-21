/**
 * Tempo Testnet Facilitator
 * 
 * Verifies payments on Tempo Moderato testnet by checking transaction receipts.
 * Unlike CDP facilitator, this directly verifies on-chain without a third-party service.
 */

import { ethers } from 'ethers';
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

// ===== Payload shapes (discriminated) =====

/** Legacy MPP / tx-hash payload: client already submitted the TIP-20 transfer. */
interface TempoTxHashPayload {
  txHash: string;
  chainId: number;
}

/** EIP-2612 permit payload: server submits permit + transferFrom from the settler wallet. */
interface TempoPermitPayload {
  permit: {
    owner: string;
    spender: string;
    value: string;
    nonce: string;
    deadline: string;
    v: number;
    r: string;
    s: string;
  };
}

// Minimal ABI for permit + transferFrom calls on the TIP-20 precompile.
const TIP20_PERMIT_ABI = [
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
];

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
  private settlerWallet: ethers.Wallet | null = null;

  constructor() {
    super();
    this.rpcUrl = CHAINS.tempo_moderato.rpc;

    // Optional: load settler key from env. If present, the facilitator can settle
    // EIP-2612 permit payments by submitting permit() + transferFrom() on behalf
    // of the user. If absent, only the legacy tx-hash verification path works.
    const settlerKey = process.env.TEMPO_SETTLER_KEY;
    if (settlerKey) {
      try {
        const provider = new ethers.JsonRpcProvider(this.rpcUrl);
        this.settlerWallet = new ethers.Wallet(settlerKey, provider);
      } catch (err) {
        console.warn('[TempoFacilitator] Invalid TEMPO_SETTLER_KEY, permit settlement disabled:', err);
        this.settlerWallet = null;
      }
    }
  }

  /**
   * Settler EOA address advertised to clients via `X-Payment-Required.extra.tempoSpender`.
   * Web Client uses this as the `spender` field in the signed EIP-2612 Permit.
   * Returns null if no TEMPO_SETTLER_KEY is configured — permit settlement unavailable.
   */
  getSpenderAddress(): string | null {
    return this.settlerWallet?.address ?? null;
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
    // Dispatch on payload shape:
    //   { permit: {...} }      → new EIP-2612 permit path (Web Client, Phase 3c)
    //   { txHash, chainId }    → legacy MPP / Node CLI tx-hash verification
    const inner = paymentPayload.payload as Partial<TempoPermitPayload & TempoTxHashPayload>;
    if (inner && 'permit' in inner && inner.permit) {
      return this.verifyPermit(inner as TempoPermitPayload, requirements);
    }
    return this.verifyTxHash(paymentPayload, requirements);
  }

  /**
   * Structural validation of an EIP-2612 permit payload. Does NOT submit
   * anything on-chain — actual submission happens in settlePermit().
   */
  private async verifyPermit(
    payload: TempoPermitPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult> {
    if (!this.settlerWallet) {
      return { valid: false, error: 'Permit settlement not configured (TEMPO_SETTLER_KEY missing)' };
    }
    const p = payload.permit;
    if (!p || !p.owner || !p.spender || !p.value || !p.deadline) {
      return { valid: false, error: 'Invalid permit payload: missing fields' };
    }
    // Spender must match our settler — otherwise permit() would set allowance on a
    // different address and transferFrom() from our settler would fail.
    if (p.spender.toLowerCase() !== this.settlerWallet.address.toLowerCase()) {
      return {
        valid: false,
        error: `Permit spender ${p.spender} does not match configured settler ${this.settlerWallet.address}`,
      };
    }
    // Deadline not expired (evaluate at verify-time; settle runs shortly after).
    const deadline = BigInt(p.deadline);
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (deadline <= now) {
      return { valid: false, error: 'Permit deadline has expired' };
    }
    // Amount must match what the requirement asked for.
    if (BigInt(p.value) < BigInt(requirements.amount || '0')) {
      return {
        valid: false,
        error: `Permit value ${p.value} is less than required ${requirements.amount}`,
      };
    }
    return { valid: true, details: { scheme: 'permit', owner: p.owner } };
  }

  private async verifyTxHash(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult> {
    try {
      // Extract Tempo-specific payload
      const tempoPayload = paymentPayload.payload as TempoTxHashPayload;

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
    // Dispatch on payload shape, same rule as verify().
    const inner = paymentPayload.payload as Partial<TempoPermitPayload & TempoTxHashPayload>;
    if (inner && 'permit' in inner && inner.permit) {
      return this.settlePermit(inner as TempoPermitPayload, requirements);
    }

    // Legacy tx-hash path: client already submitted the transfer; we just re-verify.
    const verifyResult = await this.verifyTxHash(paymentPayload, requirements);
    if (!verifyResult.valid) {
      return { success: false, error: verifyResult.error };
    }
    const tempoPayload = paymentPayload.payload as TempoTxHashPayload;
    return {
      success: true,
      transaction: tempoPayload.txHash,
      status: 'settled',
    };
  }

  /**
   * EIP-2612 permit settlement path. Submits two transactions on Tempo:
   *   1. pathUSD.permit(owner, spender=settler, value, deadline, v, r, s)
   *   2. pathUSD.transferFrom(owner, payTo, value)
   *
   * The settler EOA pays Tempo gas (via the TIP-20 `feeToken` mechanism — no
   * native tTEMPO required; any held TIP-20 token balance covers fees).
   */
  private async settlePermit(
    payload: TempoPermitPayload,
    requirements: X402PaymentRequirements
  ): Promise<SettleResult> {
    if (!this.settlerWallet) {
      return { success: false, error: 'Permit settlement not configured (TEMPO_SETTLER_KEY missing)' };
    }
    if (!requirements.asset || !requirements.payTo) {
      return { success: false, error: 'Missing asset or payTo in requirements' };
    }

    const verifyResult = await this.verifyPermit(payload, requirements);
    if (!verifyResult.valid) {
      return { success: false, error: verifyResult.error };
    }

    const token = new ethers.Contract(requirements.asset, TIP20_PERMIT_ABI, this.settlerWallet);
    const p = payload.permit;

    try {
      const permitTx = await token.permit(
        p.owner,
        p.spender,
        p.value,
        p.deadline,
        p.v,
        p.r,
        p.s
      );
      await permitTx.wait();

      const transferTx = await token.transferFrom(p.owner, requirements.payTo, p.value);
      await transferTx.wait();

      return {
        success: true,
        transaction: transferTx.hash,
        status: 'settled',
      };
    } catch (err) {
      return {
        success: false,
        error: `Tempo permit settlement failed: ${(err as Error).message}`,
      };
    }
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
