/**
 * Payment Agent 类型定义
 */

// ============ 链配置 ============

export interface ChainConfig {
  name: string;
  chainId: number;
  rpc: string;
  usdc: string;
  explorer: string;
  explorerTx: string;
  avgBlockTime: number;
}

export type ChainName = 'base' | 'base_sepolia' | 'polygon' | 'ethereum' | 'sepolia';

// ============ Invoice 协议 ============

export interface Invoice {
  type: 'payment_request';
  version: string;
  order_id: string;
  service: string;
  description?: string;
  amount: string;
  token: 'USDC' | 'USDT' | 'ETH';
  chain: string;
  chain_id: number;
  recipient: string;
  memo?: string;
  expires_at: string;
  deep_link?: string;
  explorer_url?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateInvoiceParams {
  orderId: string;
  amount: number;
  service: string;
  description?: string;
  expiresMinutes?: number;
  metadata?: Record<string, unknown>;
}

// ============ 支付验证 ============

export interface VerifyResult {
  verified: boolean;
  tx_hash?: string;
  amount?: string;
  token?: string;
  from?: string;
  to?: string;
  block_number?: number;
  confirmations?: number;
  explorer_url?: string;
  error?: string;
  pending?: boolean;
}

export interface VerifyOptions {
  expectedAmount?: number;
  tolerance?: number; // 允许的金额误差百分比，默认 0.01 (1%)
}

// ============ 钱包 ============

export interface WalletBalance {
  address: string;
  eth: string;
  usdc: string;
  chain: string;
}

export interface TransferResult {
  success: boolean;
  tx_hash?: string;
  from?: string;
  to?: string;
  amount?: number;
  gas_used?: number;
  block_number?: number;
  explorer_url?: string;
  error?: string;
}

export interface TransferParams {
  to: string;
  amount: number;
  reason?: string;
  requester?: string;
}

// ============ 安全控制 ============

export interface SecurityLimits {
  singleMax: number;      // 单笔最大金额
  dailyMax: number;       // 日最大金额
  requireWhitelist: boolean;
}

export interface SecureWalletConfig {
  chain?: ChainName;
  privateKey?: string;
  walletAddress?: string;
  limits?: Partial<SecurityLimits>;
  whitelist?: string[];
  auditPath?: string;
}

export interface PendingTransfer {
  id: string;
  to: string;
  amount: number;
  reason?: string;
  requester?: string;
  created_at: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed';
}

// ============ 审计日志 ============

export interface AuditEntry {
  timestamp: number;
  datetime: string;
  action: AuditAction;
  request_id: string;
  from?: string;
  to?: string;
  amount?: number;
  tx_hash?: string;
  reason?: string;
  requester?: string;
  prev_hash: string;
  hash: string;
  metadata?: Record<string, unknown>;
}

export type AuditAction = 
  | 'transfer_request'
  | 'transfer_approved'
  | 'transfer_rejected'
  | 'transfer_executed'
  | 'transfer_failed'
  | 'whitelist_add'
  | 'whitelist_remove'
  | 'limit_change';

// ============ EIP-2612 Permit ============

export interface PermitRequest {
  type: 'permit_request';
  version: string;
  order_id: string;
  typed_data: EIP712TypedData;
}

export interface EIP712TypedData {
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  };
  message: {
    owner: string;
    spender: string;
    value: string;
    nonce: number;
    deadline: number;
  };
}

export interface PermitSignature {
  v: number;
  r: string;
  s: string;
  deadline: number;
}

export interface PermitExecuteResult {
  success: boolean;
  tx_hash?: string;
  error?: string;
}

// ============ Agent 配置 ============

export interface PaymentAgentConfig {
  chain?: ChainName;
  walletAddress?: string;
  privateKey?: string;   // 可选，仅用于发送交易
  rpcUrl?: string;       // 自定义 RPC
}
