/**
 * Commerce PolicyEngine — the payer-side spend decision (commerce-core).
 *
 * Given a payment intent (which provider, how much), it returns one of three
 * decisions: pay automatically, hold for human approval, or deny outright.
 * This is the control the doc calls out (product §13 rule 2): budget/approval
 * rules must live OUTSIDE the model. The engine is a pure function of its
 * config + the intent — no I/O, no model influence — so a middleware can invoke
 * it before any money moves and the agent cannot talk its way past it.
 *
 * Division of labour with the ledger:
 * - per-task / daily / monthly ceilings are enforced AUTHORITATIVELY by the
 *   custodial ledger, server-side, at deduct time (see BalanceLedger). The
 *   engine may pre-check them for a fast, friendly fail but is not the source
 *   of truth for them.
 * - provider allow/deny and the auto-pay / require-approval thresholds are the
 *   payer's own policy and live here.
 *
 * All money is integer minor units (`*Sat`, 1/100 of the currency) to match the
 * ledger and avoid float drift.
 */

/** Provider allow/deny lists. Matching is exact, case-insensitive. */
export interface ProviderPolicy {
  /** When set, only these provider ids/payees may be paid. */
  allow?: string[];
  /** These provider ids/payees are never paid (takes precedence over allow). */
  deny?: string[];
}

/** Optional payer-side budget pre-checks, integer minor units. */
export interface PolicyBudgets {
  /** Hard per-transaction ceiling. A single charge above this is denied. */
  perTransactionSat?: number;
}

/** Auto-pay vs human-approval thresholds, integer minor units. */
export interface ApprovalThresholds {
  /** Charges strictly below this pay automatically. */
  autoPayBelowSat: number;
  /**
   * Charges at or above this always require human approval. When omitted it
   * equals `autoPayBelowSat`, giving a single clean boundary.
   */
  requireHumanAboveSat?: number;
}

export interface CommercePolicyConfig {
  providers?: ProviderPolicy;
  budgets?: PolicyBudgets;
  approval: ApprovalThresholds;
}

/** A single payment the agent wants to make. */
export interface PaymentIntent {
  /** Provider id or payee address the money would go to. */
  providerId?: string;
  /** Charge amount, integer minor units. */
  amountSat: number;
  /** Commerce task scope (for correlation; ledger enforces its budget). */
  taskId?: string;
}

export type PolicyAction = 'auto_pay' | 'require_approval' | 'deny';

export interface PolicyDecision {
  action: PolicyAction;
  /** Machine-readable reason, e.g. 'provider_denied', 'exceeds_per_transaction'. */
  code?: string;
  /** Human-readable explanation. */
  reason?: string;
}

export class PolicyEngine {
  private readonly allow: Set<string> | null;
  private readonly deny: Set<string>;
  private readonly perTransactionSat?: number;
  private readonly autoPayBelowSat: number;
  private readonly requireHumanAboveSat: number;

  constructor(config: CommercePolicyConfig) {
    const providers = config.providers ?? {};
    this.allow = providers.allow ? new Set(providers.allow.map(p => p.toLowerCase())) : null;
    this.deny = new Set((providers.deny ?? []).map(p => p.toLowerCase()));
    this.perTransactionSat = config.budgets?.perTransactionSat;
    if (!Number.isFinite(config.approval.autoPayBelowSat) || config.approval.autoPayBelowSat < 0) {
      throw new Error('approval.autoPayBelowSat must be a non-negative number');
    }
    this.autoPayBelowSat = config.approval.autoPayBelowSat;
    this.requireHumanAboveSat = config.approval.requireHumanAboveSat ?? config.approval.autoPayBelowSat;
    if (this.requireHumanAboveSat < this.autoPayBelowSat) {
      throw new Error('approval.requireHumanAboveSat must be >= autoPayBelowSat');
    }
  }

  /**
   * Decide how to handle one payment intent. Order: deny checks first (provider
   * deny, provider not allow-listed, over the hard per-transaction cap), then
   * the auto-pay / approval threshold.
   */
  decide(intent: PaymentIntent): PolicyDecision {
    if (!Number.isInteger(intent.amountSat) || intent.amountSat <= 0) {
      return { action: 'deny', code: 'invalid_amount', reason: 'Amount must be a positive integer (minor units)' };
    }
    const provider = intent.providerId?.toLowerCase();

    if (provider && this.deny.has(provider)) {
      return { action: 'deny', code: 'provider_denied', reason: `Provider "${intent.providerId}" is on the deny list` };
    }
    if (this.allow) {
      if (!provider || !this.allow.has(provider)) {
        return {
          action: 'deny',
          code: 'provider_not_allowed',
          reason: `Provider "${intent.providerId ?? '(none)'}" is not on the allow list`,
        };
      }
    }
    if (this.perTransactionSat !== undefined && intent.amountSat > this.perTransactionSat) {
      return {
        action: 'deny',
        code: 'exceeds_per_transaction',
        reason: `Amount exceeds the per-transaction limit`,
      };
    }
    if (intent.amountSat < this.autoPayBelowSat && intent.amountSat < this.requireHumanAboveSat) {
      return { action: 'auto_pay', code: 'below_auto_pay_threshold' };
    }
    return {
      action: 'require_approval',
      code: 'above_auto_pay_threshold',
      reason: `Amount requires human approval`,
    };
  }
}
