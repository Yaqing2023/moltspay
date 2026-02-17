/**
 * Deferred Payment Module
 * 
 * Provides credit-based and deferred payment capabilities for Agent-to-Agent transactions.
 * 
 * Features:
 * - Credit accounts with configurable limits
 * - Deferred payment tracking
 * - Installment/milestone payment plans
 * - On-chain settlement verification
 * - Conversation templates for natural A2A dialogue
 * 
 * @example
 * ```typescript
 * import { DeferredPaymentManager, DeferredSellerTemplates } from 'moltspay';
 * 
 * // Initialize manager
 * const manager = new DeferredPaymentManager({
 *   sellerAddress: '0xSELLER...',
 *   sellerId: 'zen7',
 *   chain: 'base',
 * });
 * 
 * // Create credit account for a buyer
 * const account = await manager.createCreditAccount({
 *   buyerId: 'buyer-agent-123',
 *   creditLimit: 100,
 * });
 * 
 * // Charge a service
 * const result = await manager.charge({
 *   buyerId: 'buyer-agent-123',
 *   orderId: 'vo_123',
 *   service: 'Video Generation 5s',
 *   amount: 3.99,
 * });
 * 
 * // Later, record settlement
 * await manager.recordSettlement({
 *   paymentId: result.payment.paymentId,
 *   amount: 3.99,
 *   txHash: '0xABC...',
 * });
 * ```
 */

// Types
export type {
  CreditAccount,
  CreditAccountStatus,
  PaymentTerms,
  SettlementFrequency,
  CreditTransaction,
  CreditTransactionType,
  DeferredPayment,
  DeferredPaymentStatus,
  PaymentPlan,
  Installment,
  Settlement,
  CreateCreditAccountParams,
  CreateDeferredPaymentParams,
  RecordSettlementParams,
  DeferredPaymentStore,
  PaymentFilter,
} from './types.js';

// Manager
export {
  DeferredPaymentManager,
  type DeferredPaymentManagerConfig,
  type ChargeResult,
  type SettlementResult,
  type AccountSummary,
} from './DeferredPaymentManager.js';

// Store implementations
export { MemoryDeferredStore } from './MemoryStore.js';
export { JsonDeferredStore, type JsonDeferredStoreConfig } from './JsonStore.js';

// Templates
export {
  DeferredStatusMarkers,
  DeferredSellerTemplates,
  DeferredBuyerTemplates,
  parseDeferredStatusMarker,
  type ParsedDeferredStatus,
} from './templates.js';
