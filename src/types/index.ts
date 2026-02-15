/**
 * Payment Agent Type Definitions
 */

// ============ Chain Config ============

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

// ============ Invoice Protocol ============

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

// ============ Payment Verification ============

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
  tolerance?: number; // Amount tolerance percentage, default 0.01 (1%)
}

// ============ Wallet ============

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

// ============ Security Controls ============

export interface SecurityLimits {
  singleMax: number;      // Single transaction max
  dailyMax: number;       // Daily max
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

// ============ Audit Log ============

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

// ============ Agent Config ============

export interface PaymentAgentConfig {
  chain?: ChainName;
  walletAddress?: string;
  privateKey?: string;   // Optional, only for sending transactions
  rpcUrl?: string;       // Custom RPC
}
