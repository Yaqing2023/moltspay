/**
 * SecureWallet - Secure Custody Wallet
 * 
 * Built on top of basic Wallet with：
 * - Single transaction limit
 * - Daily limit
 * - Whitelist mechanism
 * - Audit logging
 * - Over-limit approval queue
 */

import { Wallet, type WalletConfig } from './Wallet.js';
import { AuditLog } from '../audit/AuditLog.js';
import type {
  SecurityLimits,
  SecureWalletConfig,
  TransferResult,
  TransferParams,
  PendingTransfer,
} from '../types/index.js';

const DEFAULT_LIMITS: SecurityLimits = {
  singleMax: 100,      // Single max $100
  dailyMax: 1000,      // Daily max $1000
  requireWhitelist: true,
};

export class SecureWallet {
  private wallet: Wallet;
  private limits: SecurityLimits;
  private whitelist: Set<string>;
  private auditLog: AuditLog;
  private dailyTotal: number = 0;
  private dailyDate: string = '';
  private pendingTransfers: Map<string, PendingTransfer> = new Map();

  constructor(config: SecureWalletConfig = {}) {
    this.wallet = new Wallet({
      chain: config.chain,
      privateKey: config.privateKey,
    });

    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    this.whitelist = new Set((config.whitelist || []).map(a => a.toLowerCase()));
    this.auditLog = new AuditLog(config.auditPath);
  }

  /**
   * Get wallet address
   */
  get address(): string {
    return this.wallet.address;
  }

  /**
   * Get balance
   */
  async getBalance() {
    return this.wallet.getBalance();
  }

  /**
   * Secure transfer (with limit and whitelist checks)
   * 
   * Supports two calling methods:
   * - transfer({ to, amount, reason?, requester? })
   * - transfer(to, amount)
   */
  async transfer(paramsOrTo: TransferParams | string, amountArg?: number | string): Promise<TransferResult> {
    // Supports two calling methods
    let params: TransferParams;
    if (typeof paramsOrTo === 'string') {
      params = { 
        to: paramsOrTo, 
        amount: typeof amountArg === 'string' ? parseFloat(amountArg) : (amountArg || 0)
      };
    } else {
      params = paramsOrTo;
    }
    
    const { to, amount, reason, requester } = params;
    const toAddress = to.toLowerCase();
    const requestId = `tr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    // Record request
    await this.auditLog.log({
      action: 'transfer_request',
      request_id: requestId,
      from: this.wallet.address,
      to,
      amount,
      reason,
      requester,
    });

    // 1. Whitelist check
    if (this.limits.requireWhitelist && !this.whitelist.has(toAddress)) {
      await this.auditLog.log({
        action: 'transfer_failed',
        request_id: requestId,
        metadata: { error: 'Address not in whitelist' },
      });
      return { success: false, error: `Address not in whitelist: ${to}` };
    }

    // 2. Single limit check
    if (amount > this.limits.singleMax) {
      // Add to approval queue
      const pending: PendingTransfer = {
        id: requestId,
        to,
        amount,
        reason,
        requester,
        created_at: new Date().toISOString(),
        status: 'pending',
      };
      this.pendingTransfers.set(requestId, pending);
      
      await this.auditLog.log({
        action: 'transfer_request',
        request_id: requestId,
        metadata: { pending: true, reason: 'Exceeds single limit' },
      });
      
      return {
        success: false,
        error: `Amount ${amount} exceeds single limit ${this.limits.singleMax}. Pending approval: ${requestId}`,
      };
    }

    // 3. Daily limit check
    this.updateDailyTotal();
    if (this.dailyTotal + amount > this.limits.dailyMax) {
      const pending: PendingTransfer = {
        id: requestId,
        to,
        amount,
        reason,
        requester,
        created_at: new Date().toISOString(),
        status: 'pending',
      };
      this.pendingTransfers.set(requestId, pending);
      
      await this.auditLog.log({
        action: 'transfer_request',
        request_id: requestId,
        metadata: { pending: true, reason: 'Exceeds daily limit' },
      });
      
      return {
        success: false,
        error: `Daily limit would be exceeded (${this.dailyTotal} + ${amount} > ${this.limits.dailyMax}). Pending approval: ${requestId}`,
      };
    }

    // 4. Execute transfer
    const result = await this.wallet.transfer(to, amount);

    // 5. Record result
    if (result.success) {
      this.dailyTotal += amount;
      await this.auditLog.log({
        action: 'transfer_executed',
        request_id: requestId,
        from: this.wallet.address,
        to,
        amount,
        tx_hash: result.tx_hash,
        reason,
        requester,
      });
    } else {
      await this.auditLog.log({
        action: 'transfer_failed',
        request_id: requestId,
        metadata: { error: result.error },
      });
    }

    return result;
  }

  /**
   * Approve pending transfer
   */
  async approve(requestId: string, approver: string): Promise<TransferResult> {
    const pending = this.pendingTransfers.get(requestId);
    if (!pending) {
      return { success: false, error: `Pending transfer not found: ${requestId}` };
    }

    if (pending.status !== 'pending') {
      return { success: false, error: `Transfer already ${pending.status}` };
    }

    await this.auditLog.log({
      action: 'transfer_approved',
      request_id: requestId,
      metadata: { approver },
    });

    pending.status = 'approved';

    // Execute transfer（Skip limit checks）
    const result = await this.wallet.transfer(pending.to, pending.amount);

    if (result.success) {
      pending.status = 'executed';
      this.dailyTotal += pending.amount;
      
      await this.auditLog.log({
        action: 'transfer_executed',
        request_id: requestId,
        from: this.wallet.address,
        to: pending.to,
        amount: pending.amount,
        tx_hash: result.tx_hash,
        reason: pending.reason,
        requester: pending.requester,
        metadata: { approved_by: approver },
      });
    } else {
      await this.auditLog.log({
        action: 'transfer_failed',
        request_id: requestId,
        metadata: { error: result.error },
      });
    }

    return result;
  }

  /**
   * Reject pending transfer
   */
  async reject(requestId: string, rejecter: string, reason?: string): Promise<void> {
    const pending = this.pendingTransfers.get(requestId);
    if (!pending) {
      throw new Error(`Pending transfer not found: ${requestId}`);
    }

    pending.status = 'rejected';

    await this.auditLog.log({
      action: 'transfer_rejected',
      request_id: requestId,
      metadata: { rejected_by: rejecter, reason },
    });
  }

  /**
   * Add to whitelist
   */
  async addToWhitelist(address: string, addedBy: string): Promise<void> {
    const addr = address.toLowerCase();
    this.whitelist.add(addr);

    await this.auditLog.log({
      action: 'whitelist_add',
      request_id: `wl_${Date.now()}`,
      to: address,
      metadata: { added_by: addedBy },
    });
  }

  /**
   * Remove from whitelist
   */
  async removeFromWhitelist(address: string, removedBy: string): Promise<void> {
    const addr = address.toLowerCase();
    this.whitelist.delete(addr);

    await this.auditLog.log({
      action: 'whitelist_remove',
      request_id: `wl_${Date.now()}`,
      to: address,
      metadata: { removed_by: removedBy },
    });
  }

  /**
   * Check if address is whitelisted
   */
  isWhitelisted(address: string): boolean {
    return this.whitelist.has(address.toLowerCase());
  }

  /**
   * Get pending transfers list
   */
  getPendingTransfers(): PendingTransfer[] {
    return Array.from(this.pendingTransfers.values())
      .filter(p => p.status === 'pending');
  }

  /**
   * Get current limit config
   */
  getLimits(): SecurityLimits {
    return { ...this.limits };
  }

  /**
   * Get daily used amount
   */
  getDailyUsed(): number {
    this.updateDailyTotal();
    return this.dailyTotal;
  }

  /**
   * Update daily limit counter
   */
  private updateDailyTotal(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyDate !== today) {
      this.dailyDate = today;
      this.dailyTotal = 0;
    }
  }
}
