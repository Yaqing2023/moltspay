/**
 * MoltsPay - Payment infrastructure for AI Agents
 * 
 * Server (for agents selling services):
 *   import { MoltsPayServer } from 'moltspay';
 *   const server = new MoltsPayServer('./moltspay.services.json');
 *   server.skill('my-service', async (params) => { ... });
 *   server.listen(3000);
 * 
 * Client (for agents buying services):
 *   import { MoltsPayClient } from 'moltspay';
 *   const client = new MoltsPayClient();
 *   const result = await client.pay('http://provider:3000', 'my-service', { ... });
 * 
 * @packageDocumentation
 */

// Server - for selling services
export { MoltsPayServer } from './server/index.js';
export type {
  ServicesManifest,
  ServiceConfig,
  ProviderConfig,
  SkillFunction,
  RegisteredSkill,
  Charge,
  ChargeStatus,
  PaymentRequest,
  MoltsPayServerOptions,
} from './server/types.js';

// Client - for buying services
export { MoltsPayClient } from './client/index.js';
export type {
  ClientConfig,
  WalletData,
  PaymentRequired,
  ServiceInfo,
  ProviderInfo,
  ServicesResponse,
  VerifyResponse,
  MoltsPayClientOptions,
} from './client/types.js';

// Chain configuration
export { CHAINS, getChain, listChains, getChainById, ERC20_ABI } from './chains/index.js';

// Wallet utilities
export {
  createWallet,
  loadWallet,
  getWalletAddress,
  walletExists,
} from './wallet/index.js';

// Payment verification
export {
  verifyPayment,
  getTransactionStatus,
  waitForTransaction,
  type VerifyPaymentParams,
  type VerifyPaymentResult,
} from './verify/index.js';

// CDP Wallet (optional)
export {
  initCDPWallet,
  loadCDPWallet,
  getCDPWalletAddress,
  isCDPAvailable,
  CDPWallet,
} from './cdp/index.js';

// Facilitators (v0.9.0+)
export {
  Facilitator,
  BaseFacilitator,
  FacilitatorRegistry,
  CDPFacilitator,
  getDefaultRegistry,
  createRegistry,
} from './facilitators/index.js';
export type {
  FacilitatorConfig,
  FacilitatorSelection,
  SelectionStrategy,
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
  SettleResult,
  HealthCheckResult,
  FacilitatorFee,
  CDPFacilitatorConfig,
} from './facilitators/index.js';
