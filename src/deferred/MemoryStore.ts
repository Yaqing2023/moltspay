/**
 * In-Memory Store for Deferred Payments
 * 
 * Suitable for testing and single-process deployments.
 * For production, implement DeferredPaymentStore with persistent storage.
 */

import { randomUUID } from 'crypto';
import type {
  DeferredPaymentStore,
  CreditAccount,
  CreditTransaction,
  DeferredPayment,
  CreateCreditAccountParams,
  CreateDeferredPaymentParams,
  PaymentFilter,
  PaymentTerms,
} from './types.js';

const DEFAULT_TERMS: PaymentTerms = {
  netDays: 30,
  graceDays: 7,
  settlementFrequency: 'on-demand',
};

export class MemoryDeferredStore implements DeferredPaymentStore {
  private accounts: Map<string, CreditAccount> = new Map();
  private payments: Map<string, DeferredPayment> = new Map();
  
  // Index for faster lookups
  private buyerSellerIndex: Map<string, string> = new Map(); // "buyerId:sellerId" -> accountId
  
  private makeKey(buyerId: string, sellerId: string): string {
    return `${buyerId}:${sellerId}`;
  }
  
  // ============ Credit Accounts ============
  
  async createAccount(params: CreateCreditAccountParams): Promise<CreditAccount> {
    const accountId = `ca_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    
    const account: CreditAccount = {
      accountId,
      buyerId: params.buyerId,
      sellerId: params.sellerId,
      creditLimit: params.creditLimit,
      balance: 0,
      status: 'active',
      chain: params.chain || 'base',
      terms: { ...DEFAULT_TERMS, ...params.terms },
      createdAt: now,
      updatedAt: now,
      transactions: [],
      metadata: params.metadata,
    };
    
    this.accounts.set(accountId, account);
    this.buyerSellerIndex.set(this.makeKey(params.buyerId, params.sellerId), accountId);
    
    return account;
  }
  
  async getAccount(accountId: string): Promise<CreditAccount | null> {
    return this.accounts.get(accountId) || null;
  }
  
  async getAccountByBuyer(buyerId: string, sellerId: string): Promise<CreditAccount | null> {
    const accountId = this.buyerSellerIndex.get(this.makeKey(buyerId, sellerId));
    if (!accountId) return null;
    return this.accounts.get(accountId) || null;
  }
  
  async updateAccount(accountId: string, updates: Partial<CreditAccount>): Promise<CreditAccount> {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    
    const updated: CreditAccount = {
      ...account,
      ...updates,
      accountId, // Prevent overwriting ID
      updatedAt: new Date().toISOString(),
    };
    
    this.accounts.set(accountId, updated);
    return updated;
  }
  
  async listAccounts(sellerId: string): Promise<CreditAccount[]> {
    const result: CreditAccount[] = [];
    for (const account of this.accounts.values()) {
      if (account.sellerId === sellerId) {
        result.push(account);
      }
    }
    return result;
  }
  
  // ============ Deferred Payments ============
  
  async createPayment(params: CreateDeferredPaymentParams): Promise<DeferredPayment> {
    const paymentId = `dp_${randomUUID().slice(0, 8)}`;
    const now = new Date();
    
    const dueDate = new Date(now);
    dueDate.setDate(dueDate.getDate() + (params.dueInDays || 30));
    
    const payment: DeferredPayment = {
      paymentId,
      accountId: params.accountId,
      orderId: params.orderId,
      service: params.service,
      amount: params.amount,
      paidAmount: 0,
      status: 'pending',
      dueDate: dueDate.toISOString(),
      chain: params.chain || 'base',
      buyerId: params.buyerId,
      sellerAddress: params.sellerAddress,
      plan: params.plan ? { ...params.plan, completedInstallments: 0 } : undefined,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      settlements: [],
      metadata: params.metadata,
    };
    
    this.payments.set(paymentId, payment);
    
    // If linked to a credit account, add a charge transaction
    if (params.accountId) {
      await this.addTransaction(params.accountId, {
        type: 'charge',
        amount: params.amount,
        balanceAfter: 0, // Will be calculated
        reference: params.orderId,
        notes: params.service,
      });
    }
    
    return payment;
  }
  
  async getPayment(paymentId: string): Promise<DeferredPayment | null> {
    return this.payments.get(paymentId) || null;
  }
  
  async updatePayment(paymentId: string, updates: Partial<DeferredPayment>): Promise<DeferredPayment> {
    const payment = this.payments.get(paymentId);
    if (!payment) {
      throw new Error(`Payment not found: ${paymentId}`);
    }
    
    const updated: DeferredPayment = {
      ...payment,
      ...updates,
      paymentId, // Prevent overwriting ID
      updatedAt: new Date().toISOString(),
    };
    
    this.payments.set(paymentId, updated);
    return updated;
  }
  
  async listPayments(filter: PaymentFilter): Promise<DeferredPayment[]> {
    const now = new Date();
    const result: DeferredPayment[] = [];
    
    for (const payment of this.payments.values()) {
      // Apply filters
      if (filter.accountId && payment.accountId !== filter.accountId) continue;
      if (filter.buyerId && payment.buyerId !== filter.buyerId) continue;
      
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(payment.status)) continue;
      }
      
      if (filter.overdueOnly) {
        const dueDate = new Date(payment.dueDate);
        if (dueDate >= now || payment.status === 'paid' || payment.status === 'settled') {
          continue;
        }
      }
      
      result.push(payment);
    }
    
    return result;
  }
  
  // ============ Transactions ============
  
  async addTransaction(
    accountId: string,
    tx: Omit<CreditTransaction, 'txId' | 'timestamp'>
  ): Promise<CreditTransaction> {
    const account = this.accounts.get(accountId);
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }
    
    // Calculate new balance
    let newBalance = account.balance;
    if (tx.type === 'charge' || tx.type === 'late_fee') {
      newBalance += tx.amount;
    } else if (tx.type === 'payment' || tx.type === 'credit' || tx.type === 'refund') {
      newBalance -= Math.abs(tx.amount);
    } else if (tx.type === 'adjustment') {
      newBalance += tx.amount; // Can be positive or negative
    }
    
    const transaction: CreditTransaction = {
      txId: `ctx_${randomUUID().slice(0, 8)}`,
      ...tx,
      balanceAfter: newBalance,
      timestamp: new Date().toISOString(),
    };
    
    // Update account
    account.balance = newBalance;
    account.transactions.push(transaction);
    account.updatedAt = new Date().toISOString();
    
    return transaction;
  }
  
  // ============ Utilities ============
  
  /**
   * Get all data (for debugging/export)
   */
  export(): { accounts: CreditAccount[]; payments: DeferredPayment[] } {
    return {
      accounts: Array.from(this.accounts.values()),
      payments: Array.from(this.payments.values()),
    };
  }
  
  /**
   * Import data (for restore)
   */
  import(data: { accounts: CreditAccount[]; payments: DeferredPayment[] }): void {
    this.accounts.clear();
    this.payments.clear();
    this.buyerSellerIndex.clear();
    
    for (const account of data.accounts) {
      this.accounts.set(account.accountId, account);
      this.buyerSellerIndex.set(this.makeKey(account.buyerId, account.sellerId), account.accountId);
    }
    
    for (const payment of data.payments) {
      this.payments.set(payment.paymentId, payment);
    }
  }
  
  /**
   * Clear all data
   */
  clear(): void {
    this.accounts.clear();
    this.payments.clear();
    this.buyerSellerIndex.clear();
  }
}
