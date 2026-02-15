/**
 * Payment Agent - Blockchain payment infrastructure for AI Agents
 * 
 * @packageDocumentation
 */

// 核心类
export { PaymentAgent } from './agent/PaymentAgent.js';
export { Wallet, SecureWallet } from './wallet/index.js';
export { PermitPayment } from './permit/index.js';
export { AuditLog } from './audit/AuditLog.js';

// 订单管理
export { 
  OrderManager, 
  MemoryOrderStore,
  type Order,
  type OrderStatus,
  type OrderStore,
  type CreateOrderParams,
} from './orders/index.js';

// 支付验证
export {
  verifyPayment,
  getTransactionStatus,
  waitForTransaction,
  type VerifyPaymentParams,
  type VerifyPaymentResult,
} from './verify/index.js';

// 支付引导
export {
  generatePaymentGuide,
  generatePaymentReminder,
  generateWalletGuide,
  extractTransactionHash,
  hasTransactionHash,
  type PaymentGuideParams,
} from './guide/index.js';

// 链配置
export { CHAINS, getChain, listChains, getChainById, ERC20_ABI } from './chains/index.js';

// 类型
export * from './types/index.js';
