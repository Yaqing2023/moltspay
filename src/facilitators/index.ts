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

// Registry
export {
  FacilitatorRegistry,
  FacilitatorSelection,
  SelectionStrategy,
  getDefaultRegistry,
  createRegistry,
} from './registry.js';
