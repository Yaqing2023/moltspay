/**
 * JSON File-based Store for Deferred Payments
 * 
 * Persists deferred payment data to a JSON file.
 * Suitable for single-process production deployments.
 * 
 * For multi-process or distributed systems, implement DeferredPaymentStore
 * with a proper database (PostgreSQL, Redis, etc.).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { MemoryDeferredStore } from './MemoryStore.js';
import type {
  DeferredPaymentStore,
  CreditAccount,
  CreditTransaction,
  DeferredPayment,
  CreateCreditAccountParams,
  CreateDeferredPaymentParams,
  PaymentFilter,
} from './types.js';

export interface JsonDeferredStoreConfig {
  /** Path to the JSON file */
  filePath: string;
  
  /** Auto-save after each write operation (default: true) */
  autoSave?: boolean;
  
  /** Pretty print JSON (default: true) */
  prettyPrint?: boolean;
}

export class JsonDeferredStore implements DeferredPaymentStore {
  private memory: MemoryDeferredStore;
  private config: Required<JsonDeferredStoreConfig>;
  private dirty: boolean = false;
  
  constructor(config: JsonDeferredStoreConfig) {
    this.config = {
      filePath: config.filePath,
      autoSave: config.autoSave ?? true,
      prettyPrint: config.prettyPrint ?? true,
    };
    
    this.memory = new MemoryDeferredStore();
    this.load();
  }
  
  // ============ Persistence ============
  
  /**
   * Load data from file
   */
  load(): void {
    if (!existsSync(this.config.filePath)) {
      return; // Start with empty store
    }
    
    try {
      const data = JSON.parse(readFileSync(this.config.filePath, 'utf-8'));
      this.memory.import(data);
    } catch (error) {
      console.error(`Failed to load deferred store from ${this.config.filePath}:`, error);
    }
  }
  
  /**
   * Save data to file
   */
  save(): void {
    try {
      const dir = dirname(this.config.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      
      const data = this.memory.export();
      const json = this.config.prettyPrint
        ? JSON.stringify(data, null, 2)
        : JSON.stringify(data);
      
      writeFileSync(this.config.filePath, json, 'utf-8');
      this.dirty = false;
    } catch (error) {
      console.error(`Failed to save deferred store to ${this.config.filePath}:`, error);
      throw error;
    }
  }
  
  /**
   * Mark as dirty and optionally auto-save
   */
  private markDirty(): void {
    this.dirty = true;
    if (this.config.autoSave) {
      this.save();
    }
  }
  
  /**
   * Check if there are unsaved changes
   */
  isDirty(): boolean {
    return this.dirty;
  }
  
  // ============ Credit Accounts (delegate to memory store) ============
  
  async createAccount(params: CreateCreditAccountParams): Promise<CreditAccount> {
    const result = await this.memory.createAccount(params);
    this.markDirty();
    return result;
  }
  
  async getAccount(accountId: string): Promise<CreditAccount | null> {
    return this.memory.getAccount(accountId);
  }
  
  async getAccountByBuyer(buyerId: string, sellerId: string): Promise<CreditAccount | null> {
    return this.memory.getAccountByBuyer(buyerId, sellerId);
  }
  
  async updateAccount(accountId: string, updates: Partial<CreditAccount>): Promise<CreditAccount> {
    const result = await this.memory.updateAccount(accountId, updates);
    this.markDirty();
    return result;
  }
  
  async listAccounts(sellerId: string): Promise<CreditAccount[]> {
    return this.memory.listAccounts(sellerId);
  }
  
  // ============ Deferred Payments ============
  
  async createPayment(params: CreateDeferredPaymentParams): Promise<DeferredPayment> {
    const result = await this.memory.createPayment(params);
    this.markDirty();
    return result;
  }
  
  async getPayment(paymentId: string): Promise<DeferredPayment | null> {
    return this.memory.getPayment(paymentId);
  }
  
  async updatePayment(paymentId: string, updates: Partial<DeferredPayment>): Promise<DeferredPayment> {
    const result = await this.memory.updatePayment(paymentId, updates);
    this.markDirty();
    return result;
  }
  
  async listPayments(filter: PaymentFilter): Promise<DeferredPayment[]> {
    return this.memory.listPayments(filter);
  }
  
  // ============ Transactions ============
  
  async addTransaction(
    accountId: string,
    tx: Omit<CreditTransaction, 'txId' | 'timestamp'>
  ): Promise<CreditTransaction> {
    const result = await this.memory.addTransaction(accountId, tx);
    this.markDirty();
    return result;
  }
  
  // ============ Utilities ============
  
  /**
   * Export all data
   */
  export(): { accounts: CreditAccount[]; payments: DeferredPayment[] } {
    return this.memory.export();
  }
  
  /**
   * Clear all data (including file)
   */
  clear(): void {
    this.memory.clear();
    this.markDirty();
  }
}
