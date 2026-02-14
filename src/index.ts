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

// 链配置
export { CHAINS, getChain, listChains, getChainById, ERC20_ABI } from './chains/index.js';

// 类型
export * from './types/index.js';
