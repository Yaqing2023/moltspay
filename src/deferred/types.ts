/**
 * Deferred Payment Types
 * 
 * Supports credit-based, milestone, and subscription payment models
 * for trusted Agent-to-Agent transactions.
 */

import type { ChainName } from '../types/index.js';

// ============ Credit Account ============

export interface CreditAccount {
  /** Unique account identifier */
  accountId: string;
  
  /** Buyer/debtor address or identifier */
  buyerId: string;
  
  /** Seller/creditor address */
  sellerId: string;
  
  /** Credit limit in USDC */
  creditLimit: number;
  
  /** Current balance owed (positive = buyer owes seller) */
  balance: number;
  
  /** Account status */
  status: CreditAccountStatus;
  
  /** Settlement chain */
  chain: ChainName;
  
  /** Payment terms */
  terms: PaymentTerms;
  
  /** Account creation time */
  createdAt: string;
  
  /** Last activity time */
  updatedAt: string;
  
  /** Transaction history */
  transactions: CreditTransaction[];
  
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export type CreditAccountStatus = 
  | 'active'       // Normal operation
  | 'suspended'    // Temporarily frozen (e.g., overdue)
  | 'closed'       // Permanently closed
  | 'pending';     // Awaiting approval

export interface PaymentTerms {
  /** Net days for payment (e.g., 30 = Net-30) */
  netDays: number;
  
  /** Grace period after due date before suspension */
  graceDays: number;
  
  /** Settlement frequency: on-demand, daily, weekly, monthly */
  settlementFrequency: SettlementFrequency;
  
  /** Minimum balance to trigger auto-settlement */
  autoSettleThreshold?: number;
  
  /** Late fee percentage (optional) */
  lateFeePercent?: number;
}

export type SettlementFrequency = 
  | 'on-demand'    // Manual settlement only
  | 'daily'
  | 'weekly'
  | 'monthly';

// ============ Credit Transactions ============

export interface CreditTransaction {
  /** Transaction ID */
  txId: string;
  
  /** Transaction type */
  type: CreditTransactionType;
  
  /** Amount (positive for charges, negative for payments/credits) */
  amount: number;
  
  /** Running balance after this transaction */
  balanceAfter: number;
  
  /** Reference (order ID, service name, etc.) */
  reference: string;
  
  /** Optional on-chain tx hash for settlements */
  onChainTxHash?: string;
  
  /** Transaction time */
  timestamp: string;
  
  /** Notes */
  notes?: string;
}

export type CreditTransactionType =
  | 'charge'           // Service charge added to balance
  | 'payment'          // Payment received (reduces balance)
  | 'credit'           // Credit issued (reduces balance)
  | 'adjustment'       // Manual adjustment
  | 'late_fee'         // Late fee added
  | 'refund';          // Refund issued

// ============ Deferred Payment ============

export interface DeferredPayment {
  /** Payment ID */
  paymentId: string;
  
  /** Associated credit account (if using credit) */
  accountId?: string;
  
  /** Order/service ID */
  orderId: string;
  
  /** Service description */
  service: string;
  
  /** Total amount */
  amount: number;
  
  /** Amount paid so far */
  paidAmount: number;
  
  /** Payment status */
  status: DeferredPaymentStatus;
  
  /** Due date (ISO string) */
  dueDate: string;
  
  /** Settlement chain */
  chain: ChainName;
  
  /** Buyer identifier */
  buyerId: string;
  
  /** Seller address */
  sellerAddress: string;
  
  /** Payment plan (for installments) */
  plan?: PaymentPlan;
  
  /** Creation time */
  createdAt: string;
  
  /** Last update time */
  updatedAt: string;
  
  /** Settlement transactions */
  settlements: Settlement[];
  
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export type DeferredPaymentStatus =
  | 'pending'          // Awaiting payment
  | 'partial'          // Partially paid
  | 'paid'             // Fully paid
  | 'overdue'          // Past due date
  | 'settled'          // On-chain settlement complete
  | 'cancelled'        // Cancelled
  | 'disputed';        // Under dispute

// ============ Payment Plan (Installments) ============

export interface PaymentPlan {
  /** Plan type */
  type: 'fixed' | 'milestone' | 'subscription';
  
  /** Total installments */
  totalInstallments: number;
  
  /** Completed installments */
  completedInstallments: number;
  
  /** Installment schedule */
  schedule: Installment[];
}

export interface Installment {
  /** Installment number (1-based) */
  number: number;
  
  /** Amount for this installment */
  amount: number;
  
  /** Due date */
  dueDate: string;
  
  /** Status */
  status: 'pending' | 'paid' | 'overdue';
  
  /** Settlement tx hash (if paid) */
  txHash?: string;
  
  /** Milestone description (for milestone-based) */
  milestone?: string;
}

// ============ Settlement ============

export interface Settlement {
  /** Settlement ID */
  settlementId: string;
  
  /** Amount settled */
  amount: number;
  
  /** On-chain transaction hash */
  txHash: string;
  
  /** Chain */
  chain: ChainName;
  
  /** Settlement time */
  timestamp: string;
  
  /** Verification status */
  verified: boolean;
}

// ============ Create/Update Params ============

export interface CreateCreditAccountParams {
  buyerId: string;
  sellerId: string;
  creditLimit: number;
  chain?: ChainName;
  terms?: Partial<PaymentTerms>;
  metadata?: Record<string, unknown>;
}

export interface CreateDeferredPaymentParams {
  accountId?: string;
  orderId: string;
  service: string;
  amount: number;
  buyerId: string;
  sellerAddress: string;
  chain?: ChainName;
  dueInDays?: number;
  plan?: Omit<PaymentPlan, 'completedInstallments'>;
  metadata?: Record<string, unknown>;
}

export interface RecordSettlementParams {
  paymentId: string;
  amount: number;
  txHash: string;
  chain?: ChainName;
}

// ============ Store Interface ============

export interface DeferredPaymentStore {
  // Credit accounts
  createAccount(params: CreateCreditAccountParams): Promise<CreditAccount>;
  getAccount(accountId: string): Promise<CreditAccount | null>;
  getAccountByBuyer(buyerId: string, sellerId: string): Promise<CreditAccount | null>;
  updateAccount(accountId: string, updates: Partial<CreditAccount>): Promise<CreditAccount>;
  listAccounts(sellerId: string): Promise<CreditAccount[]>;
  
  // Deferred payments
  createPayment(params: CreateDeferredPaymentParams): Promise<DeferredPayment>;
  getPayment(paymentId: string): Promise<DeferredPayment | null>;
  updatePayment(paymentId: string, updates: Partial<DeferredPayment>): Promise<DeferredPayment>;
  listPayments(filter: PaymentFilter): Promise<DeferredPayment[]>;
  
  // Transactions
  addTransaction(accountId: string, tx: Omit<CreditTransaction, 'txId' | 'timestamp'>): Promise<CreditTransaction>;
}

export interface PaymentFilter {
  accountId?: string;
  buyerId?: string;
  sellerId?: string;
  status?: DeferredPaymentStatus | DeferredPaymentStatus[];
  overdueOnly?: boolean;
}
