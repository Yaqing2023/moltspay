/**
 * Payment Agent Type Definitions
 */

// ============ Token Config ============

export type TokenSymbol = 'USDC' | 'USDT';

export interface TokenConfig {
  address: string;
  decimals: number;
  symbol: TokenSymbol;
  eip712Name?: string; // EIP-712 domain name (e.g., 'USD Coin' for mainnet USDC, 'USDC' for testnet)
}

// ============ Chain Config ============

export interface ChainConfig {
  name: string;
  chainId: number;
  rpc: string;
  tokens: Record<TokenSymbol, TokenConfig>;
  /** @deprecated Use tokens.USDC.address instead */
  usdc: string;
  explorer: string;
  explorerTx: string;
  avgBlockTime: number;
  /** If true, requires one-time approval for pay-for-success flow (e.g., BNB) */
  requiresApproval?: boolean;
}

export type EvmChainName = 'base' | 'polygon' | 'base_sepolia' | 'tempo_moderato' | 'bnb' | 'bnb_testnet';
export type SolanaChainName = 'solana' | 'solana_devnet';
export type ChainName = EvmChainName | SolanaChainName;

// Chain family detection
export type ChainFamily = 'evm' | 'svm';

/**
 * Get the chain family (EVM or SVM) for a given chain
 */
export function getChainFamily(chain: ChainName): ChainFamily {
  if (chain === 'solana' || chain === 'solana_devnet') {
    return 'svm';
  }
  return 'evm';
}

/**
 * Check if a chain is a Solana chain (type guard)
 */
export function isSolanaChain(chain: ChainName): chain is SolanaChainName {
  return chain === 'solana' || chain === 'solana_devnet';
}

/**
 * Check if a chain is an EVM chain (type guard)
 */
export function isEvmChain(chain: ChainName): chain is EvmChainName {
  return !isSolanaChain(chain);
}

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
  usdt: string;
  chain: string;
}

export interface TransferResult {
  success: boolean;
  tx_hash?: string;
  from?: string;
  to?: string;
  amount?: number;
  token?: TokenSymbol;
  gas_used?: number;
  block_number?: number;
  explorer_url?: string;
  error?: string;
}

export interface TransferParams {
  to: string;
  amount: number;
  token?: TokenSymbol;
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
  chain?: EvmChainName;
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
  token?: TokenSymbol;
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
