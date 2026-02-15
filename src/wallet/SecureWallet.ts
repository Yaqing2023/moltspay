/**
 * SecureWallet - 安全托管钱包
 * 
 * 在基础 Wallet 之上增加：
 * - 单笔限额控制
 * - 日限额控制
 * - 白名单机制
 * - 审计日志
 * - 超限审批队列
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
  singleMax: 100,      // 单笔最大 $100
  dailyMax: 1000,      // 日最大 $1000
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
   * 获取钱包地址
   */
  get address(): string {
    return this.wallet.address;
  }

  /**
   * 获取余额
   */
  async getBalance() {
    return this.wallet.getBalance();
  }

  /**
   * 安全转账（带限额和白名单检查）
   * 
   * 支持两种调用方式:
   * - transfer({ to, amount, reason?, requester? })
   * - transfer(to, amount)
   */
  async transfer(paramsOrTo: TransferParams | string, amountArg?: number | string): Promise<TransferResult> {
    // 支持两种调用方式
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

    // 记录请求
    await this.auditLog.log({
      action: 'transfer_request',
      request_id: requestId,
      from: this.wallet.address,
      to,
      amount,
      reason,
      requester,
    });

    // 1. 白名单检查
    if (this.limits.requireWhitelist && !this.whitelist.has(toAddress)) {
      await this.auditLog.log({
        action: 'transfer_failed',
        request_id: requestId,
        metadata: { error: 'Address not in whitelist' },
      });
      return { success: false, error: `Address not in whitelist: ${to}` };
    }

    // 2. 单笔限额检查
    if (amount > this.limits.singleMax) {
      // 加入审批队列
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

    // 3. 日限额检查
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

    // 4. 执行转账
    const result = await this.wallet.transfer(to, amount);

    // 5. 记录结果
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
   * 审批待处理转账
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

    // 执行转账（跳过限额检查）
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
   * 拒绝待处理转账
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
   * 添加白名单地址
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
   * 移除白名单地址
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
   * 检查地址是否在白名单
   */
  isWhitelisted(address: string): boolean {
    return this.whitelist.has(address.toLowerCase());
  }

  /**
   * 获取待处理转账列表
   */
  getPendingTransfers(): PendingTransfer[] {
    return Array.from(this.pendingTransfers.values())
      .filter(p => p.status === 'pending');
  }

  /**
   * 获取当前限额配置
   */
  getLimits(): SecurityLimits {
    return { ...this.limits };
  }

  /**
   * 获取今日已用额度
   */
  getDailyUsed(): number {
    this.updateDailyTotal();
    return this.dailyTotal;
  }

  /**
   * 更新日限额计数器
   */
  private updateDailyTotal(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (this.dailyDate !== today) {
      this.dailyDate = today;
      this.dailyTotal = 0;
    }
  }
}
