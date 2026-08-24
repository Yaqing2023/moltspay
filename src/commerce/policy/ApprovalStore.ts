/**
 * ApprovalStore — the human-in-the-loop queue for over-threshold payments
 * (commerce-core).
 *
 * When the {@link PolicyEngine} returns `require_approval`, the middleware parks
 * the intent here and waits. A channel adapter (Feishu / Discord / web) is
 * wired via the `onRequested` hook so the approval prompt reaches a human; the
 * human's decision comes back through {@link resolve}. Resolution is
 * idempotent — a pending request settles at most once — so a double-click or a
 * retried webhook cannot approve twice.
 *
 * Storage is in-memory by design: a pending approval is short-lived and
 * process-local (the awaiting middleware call holds the request open). Durable
 * cross-process approval is a later concern; the interface here is the seam for
 * it.
 */

export interface ApprovalRequestInput {
  /** What is being paid for. */
  providerId?: string;
  serviceId?: string;
  amountSat: number;
  currency?: string;
  taskId?: string;
  /** Who/what is asking (agent id / buyer id). */
  requester?: string;
  /** Free-form context surfaced to the approver. */
  metadata?: Record<string, unknown>;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest extends ApprovalRequestInput {
  id: string;
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
  approver?: string;
  resolutionReason?: string;
}

export interface ResolveResult {
  ok: boolean;
  request?: ApprovalRequest;
  error?: 'not_found' | 'already_resolved';
}

/** Notified when a new approval is requested; wire a channel adapter here. */
export type ApprovalListener = (request: ApprovalRequest) => void | Promise<void>;

let counter = 0;
/** Monotonic, process-local id — avoids Math.random / time-only collisions. */
function nextId(): string {
  counter += 1;
  return `apr_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export class ApprovalStore {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly listeners: ApprovalListener[] = [];

  /** Register a channel adapter to be notified of new approval requests. */
  onRequested(listener: ApprovalListener): void {
    this.listeners.push(listener);
  }

  /** Park an intent for human approval and notify listeners. Returns the request. */
  async request(input: ApprovalRequestInput): Promise<ApprovalRequest> {
    if (!Number.isInteger(input.amountSat) || input.amountSat <= 0) {
      throw new Error('ApprovalStore.request: amountSat must be a positive integer');
    }
    const req: ApprovalRequest = {
      ...input,
      id: nextId(),
      status: 'pending',
      createdAt: Date.now(),
    };
    this.requests.set(req.id, req);
    for (const l of this.listeners) {
      try {
        await l(req);
      } catch (err: any) {
        // A broken channel adapter must not lose the request; it stays pending.
        console.error(`[MoltsPay] Approval listener failed for ${req.id}: ${err.message}`);
      }
    }
    return req;
  }

  /** Approve a pending request. Idempotent: a resolved request is never re-settled. */
  approve(id: string, approver?: string, reason?: string): ResolveResult {
    return this.resolve(id, 'approved', approver, reason);
  }

  /** Reject a pending request. Idempotent. */
  reject(id: string, approver?: string, reason?: string): ResolveResult {
    return this.resolve(id, 'rejected', approver, reason);
  }

  private resolve(id: string, status: 'approved' | 'rejected', approver?: string, reason?: string): ResolveResult {
    const req = this.requests.get(id);
    if (!req) return { ok: false, error: 'not_found' };
    if (req.status !== 'pending') return { ok: false, error: 'already_resolved', request: req };
    req.status = status;
    req.approver = approver;
    req.resolutionReason = reason;
    req.resolvedAt = Date.now();
    return { ok: true, request: req };
  }

  get(id: string): ApprovalRequest | undefined {
    return this.requests.get(id);
  }

  /** All requests, optionally filtered by status. */
  list(status?: ApprovalStatus): ApprovalRequest[] {
    const all = [...this.requests.values()];
    return status ? all.filter(r => r.status === status) : all;
  }
}
