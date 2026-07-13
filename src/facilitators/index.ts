/**
 * Facilitator Module
 * 
 * Provides pluggable payment facilitator support for MoltsPay.
 * 
 * @example
 * ```typescript
 * import { FacilitatorRegistry, CDPFacilitator } from 'moltspay/facilitators';
 * 
 * // Use default CDP facilitator
 * const registry = new FacilitatorRegistry();
 * const result = await registry.verify(paymentPayload, requirements);
 * 
 * // Or with custom config
 * const registry = new FacilitatorRegistry({
 *   primary: 'cdp',
 *   fallback: ['chaoschain'],  // Coming in v0.9.0
 *   strategy: 'failover',
 *   config: {
 *     cdp: { useMainnet: true }
 *   }
 * });
 * ```
 */

// Interface & types
export {
  Facilitator,
  BaseFacilitator,
  FacilitatorConfig,
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
  SettleResult,
  HealthCheckResult,
  FacilitatorFee,
} from './interface.js';

// CDP Facilitator
export {
  CDPFacilitator,
  CDPFacilitatorConfig,
} from './cdp.js';

// Tempo Facilitator
export {
  TempoFacilitator,
} from './tempo.js';

// BNB Facilitator
export {
  BNBFacilitator,
  BNBPaymentIntent,
  createIntentTypedData,
} from './bnb.js';

// Solana Facilitator
export {
  SolanaFacilitator,
  createSolanaPaymentTransaction,
  type SolanaPaymentPayload,
} from './solana.js';

// Alipay AI Pay Facilitator (2.0.0)
export {
  AlipayFacilitator,
  AlipayFacilitatorConfig,
  AlipayPaymentRequirements,
  AlipayPaymentProof,
  CreatePaymentRequirementsOpts,
  ALIPAY_NETWORK,
  ALIPAY_SCHEME,
  ALIPAY_GATEWAY_PROD,
  ALIPAY_GATEWAY_SANDBOX,
} from './alipay.js';

// WeChat Pay v3 Native Facilitator (2.1.0)
export {
  WechatFacilitator,
  WechatFacilitatorConfig,
  WechatPaymentRequirements,
  WECHAT_NETWORK,
  WECHAT_SCHEME,
  WECHAT_API_BASE,
  WECHAT_AMOUNT_REGEX,
  WECHAT_TIME_EXPIRE_MS,
  parseWechatAttach,
} from './wechat.js';

// Custodial Balance Facilitator (password-free rail, 2.2.0)
export {
  BalanceFacilitator,
  BalanceFacilitatorConfig,
  BalancePaymentPayload,
  extractBalancePayload,
  BALANCE_NETWORK,
  BALANCE_SCHEME,
  toSat,
  fromSat,
  BalanceAuthMode,
  BalanceAuthFields,
  verifyDeductAuth,
  buildDeductMessage,
  BALANCE_AUTH_DOMAIN,
  BALANCE_AUTH_MAX_SKEW_MS,
} from './balance.js';
export {
  BalanceLedger,
  BuyerRow,
  LedgerTxRow,
  DeductResult,
  RefundResult,
} from './balance/ledger.js';

// Registry
export {
  FacilitatorRegistry,
  FacilitatorSelection,
  SelectionStrategy,
  getDefaultRegistry,
  createRegistry,
} from './registry.js';
