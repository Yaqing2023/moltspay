/**
 * Deferred Payment Manager
 * 
 * Manages credit accounts and deferred payments for Agent-to-Agent transactions.
 * Supports credit-based, milestone, and installment payment models.
 */

import { randomUUID } from 'crypto';
import type { ChainName } from '../types/index.js';
import { verifyPayment } from '../verify/index.js';
import type {
  DeferredPaymentStore,
  CreditAccount,
  CreditTransaction,
  DeferredPayment,
  CreateCreditAccountParams,
  CreateDeferredPaymentParams,
  RecordSettlementParams,
  PaymentFilter,
  Settlement,
  DeferredPaymentStatus,
} from './types.js';
import { MemoryDeferredStore } from './MemoryStore.js';

export interface DeferredPaymentManagerConfig {
  /** Seller's wallet address for receiving payments */
  sellerAddress: string;
  
  /** Seller's identifier */
  sellerId: string;
  
  /** Default chain for payments */
  chain?: ChainName;
  
  /** Custom store implementation (defaults to MemoryDeferredStore) */
  store?: DeferredPaymentStore;
  
  /** Auto-verify settlements on-chain */
  autoVerify?: boolean;
}

export interface ChargeResult {
  success: boolean;
  payment?: DeferredPayment;
  transaction?: CreditTransaction;
  error?: string;
  /** True if credit limit would be exceeded */
  creditExceeded?: boolean;
}

export interface SettlementResult {
  success: boolean;
  settlement?: Settlement;
  payment?: DeferredPayment;
  transaction?: CreditTransaction;
  error?: string;
}

export interface AccountSummary {
  account: CreditAccount;
  pendingPayments: DeferredPayment[];
  overduePayments: DeferredPayment[];
  availableCredit: number;
  totalOwed: number;
}

export class DeferredPaymentManager {
  private config: Required<Omit<DeferredPaymentManagerConfig, 'store'>> & { store: DeferredPaymentStore };
  
  constructor(config: DeferredPaymentManagerConfig) {
    this.config = {
      sellerAddress: config.sellerAddress,
      sellerId: config.sellerId,
      chain: config.chain || 'base',
      store: config.store || new MemoryDeferredStore(),
      autoVerify: config.autoVerify ?? true,
    };
  }
  
  // ============ Credit Account Management ============
  
  /**
   * Create a new credit account for a buyer
   */
  async createCreditAccount(params: {
    buyerId: string;
    creditLimit: number;
    netDays?: number;
    metadata?: Record<string, unknown>;
  }): Promise<CreditAccount> {
    // Check if account already exists
    const existing = await this.config.store.getAccountByBuyer(
      params.buyerId,
      this.config.sellerId
    );
    
    if (existing) {
      throw new Error(`Credit account already exists for buyer: ${params.buyerId}`);
    }
    
    return this.config.store.createAccount({
      buyerId: params.buyerId,
      sellerId: this.config.sellerId,
      creditLimit: params.creditLimit,
      chain: this.config.chain,
      terms: params.netDays ? { netDays: params.netDays, graceDays: 7, settlementFrequency: 'on-demand' } : undefined,
      metadata: params.metadata,
    });
  }
  
  /**
   * Get or create a credit account for a buyer
   */
  async getOrCreateAccount(params: {
    buyerId: string;
    creditLimit?: number;
  }): Promise<CreditAccount> {
    const existing = await this.config.store.getAccountByBuyer(
      params.buyerId,
      this.config.sellerId
    );
    
    if (existing) return existing;
    
    return this.createCreditAccount({
      buyerId: params.buyerId,
      creditLimit: params.creditLimit || 100, // Default $100 credit limit
    });
  }
  
  /**
   * Get credit account by ID
   */
  async getAccount(accountId: string): Promise<CreditAccount | null> {
    return this.config.store.getAccount(accountId);
  }
  
  /**
   * Get credit account by buyer ID
   */
  async getAccountByBuyer(buyerId: string): Promise<CreditAccount | null> {
    return this.config.store.getAccountByBuyer(buyerId, this.config.sellerId);
  }
  
  /**
   * Update credit limit
   */
  async updateCreditLimit(accountId: string, newLimit: number): Promise<CreditAccount> {
    return this.config.store.updateAccount(accountId, { creditLimit: newLimit });
  }
  
  /**
   * Suspend an account
   */
  async suspendAccount(accountId: string, reason?: string): Promise<CreditAccount> {
    const account = await this.config.store.updateAccount(accountId, { status: 'suspended' });
    
    // Log the suspension
    await this.config.store.addTransaction(accountId, {
      type: 'adjustment',
      amount: 0,
      balanceAfter: account.balance,
      reference: 'account_suspended',
      notes: reason || 'Account suspended',
    });
    
    return account;
  }
  
  /**
   * Reactivate a suspended account
   */
  async reactivateAccount(accountId: string): Promise<CreditAccount> {
    return this.config.store.updateAccount(accountId, { status: 'active' });
  }
  
  /**
   * Get account summary with pending/overdue payments
   */
  async getAccountSummary(accountId: string): Promise<AccountSummary | null> {
    const account = await this.config.store.getAccount(accountId);
    if (!account) return null;
    
    const allPayments = await this.config.store.listPayments({ accountId });
    const now = new Date();
    
    const pendingPayments = allPayments.filter(p => 
      p.status === 'pending' || p.status === 'partial'
    );
    
    const overduePayments = allPayments.filter(p => {
      if (p.status === 'paid' || p.status === 'settled' || p.status === 'cancelled') {
        return false;
      }
      return new Date(p.dueDate) < now;
    });
    
    return {
      account,
      pendingPayments,
      overduePayments,
      availableCredit: Math.max(0, account.creditLimit - account.balance),
      totalOwed: account.balance,
    };
  }
  
  /**
   * List all credit accounts for this seller
   */
  async listAccounts(): Promise<CreditAccount[]> {
    return this.config.store.listAccounts(this.config.sellerId);
  }
  
  // ============ Deferred Payment Operations ============
  
  /**
   * Charge a service to a credit account (deferred payment)
   */
  async charge(params: {
    buyerId: string;
    orderId: string;
    service: string;
    amount: number;
    dueInDays?: number;
    metadata?: Record<string, unknown>;
  }): Promise<ChargeResult> {
    // Get or create account
    let account = await this.getAccountByBuyer(params.buyerId);
    
    if (!account) {
      // Auto-create account with default limit
      try {
        account = await this.createCreditAccount({
          buyerId: params.buyerId,
          creditLimit: 100, // Default $100 limit
        });
      } catch (error) {
        return {
          success: false,
          error: `Failed to create credit account: ${error}`,
        };
      }
    }
    
    // Check account status
    if (account.status !== 'active') {
      return {
        success: false,
        error: `Credit account is ${account.status}`,
      };
    }
    
    // Check credit limit
    const newBalance = account.balance + params.amount;
    if (newBalance > account.creditLimit) {
      return {
        success: false,
        error: `Credit limit exceeded. Available: $${(account.creditLimit - account.balance).toFixed(2)}, Required: $${params.amount.toFixed(2)}`,
        creditExceeded: true,
      };
    }
    
    // Create deferred payment
    const payment = await this.config.store.createPayment({
      accountId: account.accountId,
      orderId: params.orderId,
      service: params.service,
      amount: params.amount,
      buyerId: params.buyerId,
      sellerAddress: this.config.sellerAddress,
      chain: this.config.chain,
      dueInDays: params.dueInDays || account.terms.netDays,
      metadata: params.metadata,
    });
    
    // The transaction was already added by createPayment
    // Get the latest account state
    const updatedAccount = await this.config.store.getAccount(account.accountId);
    const lastTx = updatedAccount?.transactions[updatedAccount.transactions.length - 1];
    
    return {
      success: true,
      payment,
      transaction: lastTx,
    };
  }
  
  /**
   * Create a deferred payment without a credit account (standalone)
   */
  async createDeferredPayment(params: CreateDeferredPaymentParams): Promise<DeferredPayment> {
    return this.config.store.createPayment({
      ...params,
      sellerAddress: params.sellerAddress || this.config.sellerAddress,
      chain: params.chain || this.config.chain,
    });
  }
  
  /**
   * Get deferred payment by ID
   */
  async getPayment(paymentId: string): Promise<DeferredPayment | null> {
    return this.config.store.getPayment(paymentId);
  }
  
  /**
   * List deferred payments with filters
   */
  async listPayments(filter?: PaymentFilter): Promise<DeferredPayment[]> {
    return this.config.store.listPayments(filter || {});
  }
  
  /**
   * Get overdue payments
   */
  async getOverduePayments(): Promise<DeferredPayment[]> {
    return this.config.store.listPayments({ overdueOnly: true });
  }
  
  // ============ Settlement ============
  
  /**
   * Record a settlement (payment received)
   */
  async recordSettlement(params: RecordSettlementParams): Promise<SettlementResult> {
    const payment = await this.config.store.getPayment(params.paymentId);
    if (!payment) {
      return { success: false, error: `Payment not found: ${params.paymentId}` };
    }
    
    // Verify on-chain if enabled
    let verified = false;
    if (this.config.autoVerify) {
      try {
        const verification = await verifyPayment({
          txHash: params.txHash,
          chain: params.chain || payment.chain,
          expectedTo: payment.sellerAddress,
          expectedAmount: params.amount,
        });
        verified = verification.verified;
        
        if (!verified) {
          return {
            success: false,
            error: `Payment verification failed: ${verification.error || 'Unknown error'}`,
          };
        }
      } catch (error) {
        return {
          success: false,
          error: `Verification error: ${error}`,
        };
      }
    } else {
      verified = true; // Trust the caller
    }
    
    // Create settlement record
    const settlement: Settlement = {
      settlementId: `stl_${randomUUID().slice(0, 8)}`,
      amount: params.amount,
      txHash: params.txHash,
      chain: params.chain || payment.chain,
      timestamp: new Date().toISOString(),
      verified,
    };
    
    // Update payment
    const newPaidAmount = payment.paidAmount + params.amount;
    const newStatus: DeferredPaymentStatus = 
      newPaidAmount >= payment.amount ? 'settled' :
      newPaidAmount > 0 ? 'partial' : 'pending';
    
    const updatedPayment = await this.config.store.updatePayment(params.paymentId, {
      paidAmount: newPaidAmount,
      status: newStatus,
      settlements: [...payment.settlements, settlement],
    });
    
    // If linked to a credit account, record the payment transaction
    let transaction: CreditTransaction | undefined;
    if (payment.accountId) {
      transaction = await this.config.store.addTransaction(payment.accountId, {
        type: 'payment',
        amount: params.amount,
        balanceAfter: 0, // Will be calculated by store
        reference: payment.orderId,
        onChainTxHash: params.txHash,
        notes: `Settlement for ${payment.service}`,
      });
    }
    
    return {
      success: true,
      settlement,
      payment: updatedPayment,
      transaction,
    };
  }
  
  /**
   * Settle all pending charges for an account
   */
  async settleAccount(accountId: string, txHash: string): Promise<SettlementResult> {
    const account = await this.config.store.getAccount(accountId);
    if (!account) {
      return { success: false, error: `Account not found: ${accountId}` };
    }
    
    if (account.balance <= 0) {
      return { success: false, error: 'No balance to settle' };
    }
    
    // Verify on-chain
    if (this.config.autoVerify) {
      const verification = await verifyPayment({
        txHash,
        chain: account.chain,
        expectedTo: this.config.sellerAddress,
        expectedAmount: account.balance,
      });
      
      if (!verification.verified) {
        return {
          success: false,
          error: `Payment verification failed: ${verification.error || 'Unknown error'}`,
        };
      }
    }
    
    // Record settlement transaction
    const transaction = await this.config.store.addTransaction(accountId, {
      type: 'payment',
      amount: account.balance,
      balanceAfter: 0,
      reference: `account_settlement_${accountId}`,
      onChainTxHash: txHash,
      notes: 'Full account settlement',
    });
    
    // Mark all pending payments as settled
    const pendingPayments = await this.config.store.listPayments({
      accountId,
      status: ['pending', 'partial'],
    });
    
    const settlement: Settlement = {
      settlementId: `stl_${randomUUID().slice(0, 8)}`,
      amount: account.balance,
      txHash,
      chain: account.chain,
      timestamp: new Date().toISOString(),
      verified: true,
    };
    
    for (const payment of pendingPayments) {
      await this.config.store.updatePayment(payment.paymentId, {
        paidAmount: payment.amount,
        status: 'settled',
        settlements: [...payment.settlements, settlement],
      });
    }
    
    return {
      success: true,
      settlement,
      transaction,
    };
  }
  
  // ============ Credit Operations ============
  
  /**
   * Issue a credit (reduce balance owed)
   */
  async issueCredit(params: {
    accountId: string;
    amount: number;
    reason: string;
  }): Promise<CreditTransaction> {
    return this.config.store.addTransaction(params.accountId, {
      type: 'credit',
      amount: params.amount,
      balanceAfter: 0,
      reference: 'credit_issued',
      notes: params.reason,
    });
  }
  
  /**
   * Issue a refund
   */
  async issueRefund(params: {
    paymentId: string;
    amount: number;
    reason: string;
  }): Promise<SettlementResult> {
    const payment = await this.config.store.getPayment(params.paymentId);
    if (!payment) {
      return { success: false, error: `Payment not found: ${params.paymentId}` };
    }
    
    // Update payment
    const newPaidAmount = Math.max(0, payment.paidAmount - params.amount);
    await this.config.store.updatePayment(params.paymentId, {
      paidAmount: newPaidAmount,
      status: newPaidAmount >= payment.amount ? 'settled' : 
              newPaidAmount > 0 ? 'partial' : 'pending',
    });
    
    // If linked to account, add refund transaction
    let transaction: CreditTransaction | undefined;
    if (payment.accountId) {
      transaction = await this.config.store.addTransaction(payment.accountId, {
        type: 'refund',
        amount: params.amount,
        balanceAfter: 0,
        reference: payment.orderId,
        notes: params.reason,
      });
    }
    
    return { success: true, transaction };
  }
  
  // ============ Maintenance ============
  
  /**
   * Mark overdue payments
   */
  async markOverduePayments(): Promise<DeferredPayment[]> {
    const now = new Date();
    const pending = await this.config.store.listPayments({
      status: ['pending', 'partial'],
    });
    
    const overdue: DeferredPayment[] = [];
    
    for (const payment of pending) {
      if (new Date(payment.dueDate) < now) {
        const updated = await this.config.store.updatePayment(payment.paymentId, {
          status: 'overdue',
        });
        overdue.push(updated);
        
        // Optionally suspend the account
        if (payment.accountId) {
          const account = await this.config.store.getAccount(payment.accountId);
          if (account && account.status === 'active') {
            const graceEnd = new Date(payment.dueDate);
            graceEnd.setDate(graceEnd.getDate() + account.terms.graceDays);
            
            if (now > graceEnd) {
              await this.suspendAccount(payment.accountId, 'Overdue payment past grace period');
            }
          }
        }
      }
    }
    
    return overdue;
  }
  
  /**
   * Apply late fees to overdue accounts
   */
  async applyLateFees(): Promise<CreditTransaction[]> {
    const accounts = await this.listAccounts();
    const fees: CreditTransaction[] = [];
    
    for (const account of accounts) {
      if (account.terms.lateFeePercent && account.balance > 0) {
        const overduePayments = await this.config.store.listPayments({
          accountId: account.accountId,
          status: 'overdue',
        });
        
        if (overduePayments.length > 0) {
          const feeAmount = account.balance * (account.terms.lateFeePercent / 100);
          const tx = await this.config.store.addTransaction(account.accountId, {
            type: 'late_fee',
            amount: feeAmount,
            balanceAfter: 0,
            reference: 'late_fee',
            notes: `${account.terms.lateFeePercent}% late fee on $${account.balance.toFixed(2)}`,
          });
          fees.push(tx);
        }
      }
    }
    
    return fees;
  }
}
