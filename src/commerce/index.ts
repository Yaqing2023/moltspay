/**
 * MoltsPay Commerce Layer (commerce-core) — platform-agnostic agent-commerce
 * primitives: spend policy, human approval, and (via the audit trail) spend
 * explainability. Consumed by the OpenClaw adapter and, later, other framework
 * adapters. See docs/MoltsPay-Commerce-Layer.
 */

export {
  PolicyEngine,
  type CommercePolicyConfig,
  type ProviderPolicy,
  type PolicyBudgets,
  type ApprovalThresholds,
  type PaymentIntent,
  type PolicyAction,
  type PolicyDecision,
} from './policy/PolicyEngine.js';

export {
  FulfillmentPolicy,
  type FulfillmentPolicyConfig,
  type BuyerPolicy,
  type FulfillmentThresholds,
  type FulfillmentIntent,
  type FulfillmentAction,
  type FulfillmentDecision,
} from './policy/FulfillmentPolicy.js';

export {
  ApprovalStore,
  type ApprovalRequest,
  type ApprovalRequestInput,
  type ApprovalStatus,
  type ApprovalListener,
  type ResolveResult,
} from './policy/ApprovalStore.js';

export {
  TaskBudgetMeter,
  type ReserveOpts,
  type ReserveResult,
  type ChargeRow,
} from './budget/TaskBudgetMeter.js';

export {
  CommerceMiddleware,
  PAYMENT_HEADER,
  PaymentDeniedError,
  ApprovalRequiredError,
  ApprovalRejectedError,
  type PaymentQuote,
  type PaymentProof,
  type PaymentExecutor,
  type CommerceContext,
  type CommerceMiddlewareConfig,
} from './middleware/CommerceMiddleware.js';
