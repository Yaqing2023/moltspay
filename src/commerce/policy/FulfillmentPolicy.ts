/**
 * Commerce FulfillmentPolicy — the seller-side "should I serve this?" decision
 * (commerce-core). The earn-side mirror of {@link PolicyEngine}.
 *
 * Given a fulfillment intent (which buyer, which service, how much they paid),
 * it returns one of three decisions: fulfill automatically, hold for human
 * approval, or deny outright. Symmetric to the spend side (product §13): the
 * rule that decides whether to serve a paid request must live OUTSIDE the model
 * and be enforced server-side, so a seller's agent cannot talk its way into
 * serving a denied buyer or an underpriced request.
 *
 * The engine is a pure function of its config + the intent — no I/O, no model
 * influence — so the server can invoke it before delivering anything.
 *
 * Division of labour:
 * - buyer allow/deny and the min-price floor are the seller's own policy and
 *   live here.
 * - the actual payment (that the buyer really paid `amountSat`) is verified
 *   AUTHORITATIVELY by the facilitator/ledger — this engine only decides policy,
 *   it does not verify money.
 *
 * All money is integer minor units (`*Sat`, 1/100 of the currency) to match the
 * ledger and the spend-side PolicyEngine, avoiding float drift.
 */

/** Buyer allow/deny lists. Matching is exact, case-insensitive. */
export interface BuyerPolicy {
  /** When set, only these buyer ids/payers may be served. */
  allow?: string[];
  /** These buyer ids/payers are never served (takes precedence over allow). */
  deny?: string[];
}

/** Auto-fulfill vs human-approval thresholds, integer minor units. */
export interface FulfillmentThresholds {
  /**
   * Requests strictly below this price auto-fulfill; at or above it they require
   * human approval. Omit to auto-fulfill every allowed request regardless of price.
   */
  autoFulfillBelowSat?: number;
  /**
   * Requests at or above this always require human approval. When omitted it
   * equals `autoFulfillBelowSat`, giving a single clean boundary.
   */
  requireApprovalAboveSat?: number;
}

export interface FulfillmentPolicyConfig {
  buyers?: BuyerPolicy;
  /** Reject paid requests offering strictly below this price (integer minor units). */
  minPriceSat?: number;
  approval?: FulfillmentThresholds;
}

/** A single request the agent is being asked to fulfill. */
export interface FulfillmentIntent {
  /** Buyer id or payer address the money came from. */
  buyerId?: string;
  /** Requested service id (for correlation / logging). */
  serviceId?: string;
  /** Amount the buyer paid, integer minor units. */
  amountSat: number;
}

export type FulfillmentAction = 'fulfill' | 'require_approval' | 'deny';

export interface FulfillmentDecision {
  action: FulfillmentAction;
  /** Machine-readable reason, e.g. 'buyer_denied', 'below_min_price'. */
  code?: string;
  /** Human-readable explanation. */
  reason?: string;
}

export class FulfillmentPolicy {
  private readonly allow: Set<string> | null;
  private readonly deny: Set<string>;
  private readonly minPriceSat?: number;
  private readonly autoFulfillBelowSat?: number;
  private readonly requireApprovalAboveSat?: number;

  constructor(config: FulfillmentPolicyConfig = {}) {
    const buyers = config.buyers ?? {};
    this.allow = buyers.allow ? new Set(buyers.allow.map(b => b.toLowerCase())) : null;
    this.deny = new Set((buyers.deny ?? []).map(b => b.toLowerCase()));

    if (config.minPriceSat !== undefined) {
      if (!Number.isInteger(config.minPriceSat) || config.minPriceSat < 0) {
        throw new Error('minPriceSat must be a non-negative integer (minor units)');
      }
      this.minPriceSat = config.minPriceSat;
    }

    const approval = config.approval ?? {};
    if (approval.autoFulfillBelowSat !== undefined) {
      if (!Number.isFinite(approval.autoFulfillBelowSat) || approval.autoFulfillBelowSat < 0) {
        throw new Error('approval.autoFulfillBelowSat must be a non-negative number');
      }
      this.autoFulfillBelowSat = approval.autoFulfillBelowSat;
      this.requireApprovalAboveSat = approval.requireApprovalAboveSat ?? approval.autoFulfillBelowSat;
      if (this.requireApprovalAboveSat < this.autoFulfillBelowSat) {
        throw new Error('approval.requireApprovalAboveSat must be >= autoFulfillBelowSat');
      }
    }
  }

  /**
   * Decide how to handle one fulfillment intent. Order: deny checks first (buyer
   * deny, buyer not allow-listed, below the min-price floor), then the
   * auto-fulfill / approval threshold. Default is fulfill.
   */
  decide(intent: FulfillmentIntent): FulfillmentDecision {
    if (!Number.isInteger(intent.amountSat) || intent.amountSat <= 0) {
      return { action: 'deny', code: 'invalid_amount', reason: 'Amount must be a positive integer (minor units)' };
    }
    const buyer = intent.buyerId?.toLowerCase();

    if (buyer && this.deny.has(buyer)) {
      return { action: 'deny', code: 'buyer_denied', reason: `Buyer "${intent.buyerId}" is on the deny list` };
    }
    if (this.allow) {
      if (!buyer || !this.allow.has(buyer)) {
        return {
          action: 'deny',
          code: 'buyer_not_allowed',
          reason: `Buyer "${intent.buyerId ?? '(none)'}" is not on the allow list`,
        };
      }
    }
    if (this.minPriceSat !== undefined && intent.amountSat < this.minPriceSat) {
      return {
        action: 'deny',
        code: 'below_min_price',
        reason: `Amount is below the minimum price for this service`,
      };
    }
    if (
      this.autoFulfillBelowSat !== undefined &&
      this.requireApprovalAboveSat !== undefined &&
      intent.amountSat >= this.requireApprovalAboveSat
    ) {
      return {
        action: 'require_approval',
        code: 'above_auto_fulfill_threshold',
        reason: `Fulfillment requires human approval`,
      };
    }
    return { action: 'fulfill', code: 'auto_fulfill' };
  }
}
