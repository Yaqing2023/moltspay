/**
 * Payment Agent - Blockchain payment infrastructure for AI Agents
 * 
 * @packageDocumentation
 */

// Core classes
export { PaymentAgent } from './agent/PaymentAgent.js';
export { AgentWallet, getAgentAddress } from './agent/AgentWallet.js';
export { Wallet, SecureWallet } from './wallet/index.js';
export { PermitPayment } from './permit/index.js';
export { AuditLog } from './audit/AuditLog.js';

// Wallet creation and Permit wallet
export {
  createWallet,
  loadWallet,
  getWalletAddress,
  walletExists,
  PermitWallet,
  formatPermitRequest,
  signPermit,
  PermitSigner,
  AllowanceWallet,
  generatePermitInstructions,
  type CreateWalletOptions,
  type CreateWalletResult,
  type WalletData,
  type PermitWalletConfig,
  type PermitData,
  type TransferWithPermitParams,
  type TransferWithPermitResult,
  type SignPermitParams,
  type SignPermitResult,
  type SignPermitConfig,
  type AllowanceWalletConfig,
  type OwnerPermit,
  type SpendParams,
  type SpendResult,
  type AllowanceStatus,
} from './wallet/index.js';

// Order management
export { 
  OrderManager, 
  MemoryOrderStore,
  type Order,
  type OrderStatus,
  type OrderStore,
  type CreateOrderParams,
} from './orders/index.js';

// Payment verification
export {
  verifyPayment,
  getTransactionStatus,
  waitForTransaction,
  type VerifyPaymentParams,
  type VerifyPaymentResult,
} from './verify/index.js';

// Payment guide
export {
  generatePaymentGuide,
  generatePaymentReminder,
  generateWalletGuide,
  extractTransactionHash,
  hasTransactionHash,
  type PaymentGuideParams,
} from './guide/index.js';

// Receipt
export {
  generateReceipt,
  generateReceiptFromInvoice,
  formatReceiptMessage,
  formatReceiptText,
  formatReceiptJson,
  type ReceiptParams,
  type Receipt,
} from './receipt/index.js';

// Conversation templates
export {
  SellerTemplates,
  BuyerTemplates,
  StatusMarkers,
  parseStatusMarker,
} from './templates/index.js';

// Chain configuration
export { CHAINS, getChain, listChains, getChainById, ERC20_ABI } from './chains/index.js';

// Types
export * from './types/index.js';

// x402 Protocol Support
export {
  // Low-level x402 helpers
  X402_VERSION,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_HEADER,
  PAYMENT_RESPONSE_HEADER,
  parsePaymentRequired,
  encodePaymentPayload,
  chainToNetwork,
  networkToChain,
  signEIP3009,
  createExactEvmPayload,
  wrapFetchWith402,
  createPaymentRequiredResponse,
  verifyPaymentHeader,
  // Easy-to-use x402 client
  createX402Client,
  x402Fetch,
  isX402Available,
  type X402PaymentRequirements,
  type X402PaymentPayload,
  type EIP3009Authorization,
  type X402Client,
  type X402ClientConfig,
} from './x402/index.js';

// CDP (Coinbase Developer Platform) Wallet
export {
  initCDPWallet,
  loadCDPWallet,
  getCDPWalletAddress,
  isCDPAvailable,
  CDPWallet,
  type CDPWalletConfig,
  type CDPWalletData,
  type CDPInitResult,
} from './cdp/index.js';
