/**
 * CommerceMiddleware — the un-bypassable 402 enforcement point (commerce-core).
 *
 * Wraps `fetch`. When a request comes back `402 Payment Required`, the
 * middleware — NOT the model — decides what happens: it reads the challenge,
 * asks the {@link PolicyEngine} (provider allow/deny + auto-pay / approval
 * threshold), and only then either pays automatically, parks the charge for
 * human approval, or refuses. Every outcome is written to the {@link AuditLog}
 * with its task / provider / payment correlation. Because the gate sits in the
 * transport, an agent cannot skip it by "deciding" to pay directly (product
 * doc §13 rule 2: policy must live outside the model).
 *
 * The actual signing/settlement is delegated to an injected
 * {@link PaymentExecutor} so this layer stays rail-agnostic and unit-testable
 * with no network or key material.
 */

import { PolicyEngine } from '../policy/PolicyEngine.js';
import { ApprovalStore, ApprovalRequest } from '../policy/ApprovalStore.js';
import { AuditLog } from '../../audit/AuditLog.js';
import { parsePaymentRequiredHeader } from '../../client/core/x402.js';
import { PAYMENT_REQUIRED_HEADER, X402PaymentRequirements } from '../../client/core/types.js';

/** HTTP header carrying the payment proof on the retried request. */
export const PAYMENT_HEADER = 'X-Payment';

/** What the executor reports it will charge for a given challenge. */
export interface PaymentQuote {
  amountSat: number;
  providerId?: string;
  /** The requirement entry the executor intends to satisfy. */
  chosen: X402PaymentRequirements;
}

/** The proof to replay on the retried request. */
export interface PaymentProof {
  /** Base64 `X-Payment` header value. */
  xPayment: string;
  paymentId?: string;
  receiptId?: string;
}

/**
 * Rail-specific payment execution, injected so the middleware never touches
 * key material or a concrete client.
 */
export interface PaymentExecutor {
  /** Pick a requirement to satisfy and report the charge (for the policy check). */
  quote(accepts: X402PaymentRequirements[]): PaymentQuote;
  /** Produce the payment proof to retry with. */
  pay(chosen: X402PaymentRequirements, ctx: { taskId?: string }): Promise<PaymentProof>;
}

/** Per-request commerce context for policy + audit correlation. */
export interface CommerceContext {
  taskId?: string;
  sessionId?: string;
  toolCallId?: string;
  requester?: string;
}

export interface CommerceMiddlewareConfig {
  policy: PolicyEngine;
  executor: PaymentExecutor;
  approvals?: ApprovalStore;
  audit?: AuditLog;
  /** Injected fetch (defaults to global). */
  fetchImpl?: typeof fetch;
  /**
   * Resolve a parked approval. When provided, the middleware awaits it and
   * continues (approved) or refuses (rejected). When absent, an over-threshold
   * charge throws {@link ApprovalRequiredError} for a turn-based caller to
   * handle out of band.
   */
  approvalResolver?: (request: ApprovalRequest) => Promise<boolean>;
}

export class PaymentDeniedError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'PaymentDeniedError';
  }
}
export class ApprovalRequiredError extends Error {
  constructor(public request: ApprovalRequest) {
    super(`Payment requires human approval (request ${request.id})`);
    this.name = 'ApprovalRequiredError';
  }
}
export class ApprovalRejectedError extends Error {
  constructor(public request: ApprovalRequest) {
    super(`Payment approval was rejected (request ${request.id})`);
    this.name = 'ApprovalRejectedError';
  }
}

export class CommerceMiddleware {
  private readonly policy: PolicyEngine;
  private readonly executor: PaymentExecutor;
  private readonly approvals?: ApprovalStore;
  private readonly audit?: AuditLog;
  private readonly fetchImpl: typeof fetch;
  private readonly approvalResolver?: (request: ApprovalRequest) => Promise<boolean>;

  constructor(config: CommerceMiddlewareConfig) {
    this.policy = config.policy;
    this.executor = config.executor;
    this.approvals = config.approvals;
    this.audit = config.audit;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.approvalResolver = config.approvalResolver;
  }

  /**
   * fetch-compatible entry point. Passes non-402 responses straight through;
   * on a 402 it runs the policy gate, pays (or gets approval), and retries once
   * with the payment proof.
   */
  async fetch(input: string | URL | Request, init?: RequestInit, ctx: CommerceContext = {}): Promise<Response> {
    const first = await this.fetchImpl(input as any, init);
    if (first.status !== 402) return first;

    const header = first.headers.get(PAYMENT_REQUIRED_HEADER);
    if (!header) {
      throw new PaymentDeniedError('missing_challenge', '402 response carried no x-payment-required header');
    }
    const accepts = parsePaymentRequiredHeader(header);
    const quote = this.executor.quote(accepts);

    const decision = this.policy.decide({
      amountSat: quote.amountSat,
      providerId: quote.providerId,
      taskId: ctx.taskId,
    });

    if (decision.action === 'deny') {
      await this.record('payment_denied', 'denied', quote, ctx, undefined, decision.reason);
      throw new PaymentDeniedError(decision.code ?? 'denied', decision.reason ?? 'Payment denied by policy');
    }

    if (decision.action === 'require_approval') {
      await this.handleApproval(quote, ctx);
    }

    // Auto-pay, or approval granted → settle and retry once.
    const proof = await this.executor.pay(quote.chosen, { taskId: ctx.taskId });
    const retried = await this.fetchImpl(input as any, {
      ...init,
      headers: { ...(init?.headers as Record<string, string> | undefined), [PAYMENT_HEADER]: proof.xPayment },
    });
    await this.record('payment_settled', retried.ok ? 'fulfilled' : 'failed', quote, ctx, proof);
    return retried;
  }

  /** Park the charge for approval and block on the resolver, or throw for a turn-based caller. */
  private async handleApproval(quote: PaymentQuote, ctx: CommerceContext): Promise<void> {
    if (!this.approvals) {
      throw new PaymentDeniedError(
        'approval_unavailable',
        'Payment requires approval but no ApprovalStore is configured',
      );
    }
    const request = await this.approvals.request({
      providerId: quote.providerId,
      serviceId: this.serviceIdOf(quote.chosen),
      amountSat: quote.amountSat,
      taskId: ctx.taskId,
      requester: ctx.requester,
    });
    if (!this.approvalResolver) {
      // Turn-based: let the caller collect approval and retry later.
      throw new ApprovalRequiredError(request);
    }
    const approved = await this.approvalResolver(request);
    if (approved) {
      this.approvals.approve(request.id, ctx.requester);
    } else {
      this.approvals.reject(request.id, ctx.requester);
      await this.record('payment_denied', 'rejected', quote, ctx, undefined, 'approval rejected');
      throw new ApprovalRejectedError(request);
    }
  }

  private serviceIdOf(req: X402PaymentRequirements): string | undefined {
    const sid = req.extra?.service_id;
    return typeof sid === 'string' ? sid : undefined;
  }

  private async record(
    action: string,
    verification_status: string,
    quote: PaymentQuote,
    ctx: CommerceContext,
    proof?: PaymentProof,
    reason?: string,
  ): Promise<void> {
    if (!this.audit) return;
    try {
      await this.audit.log({
        action,
        verification_status,
        amount: quote.amountSat / 100,
        provider_id: quote.providerId,
        service_id: this.serviceIdOf(quote.chosen),
        task_id: ctx.taskId,
        session_id: ctx.sessionId,
        tool_call_id: ctx.toolCallId,
        agent_id: ctx.requester,
        payment_id: proof?.paymentId,
        receipt_id: proof?.receiptId,
        reason,
      });
    } catch (err: any) {
      console.error(`[MoltsPay] Commerce middleware audit failed (non-fatal): ${err.message}`);
    }
  }
}
