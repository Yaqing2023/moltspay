/**
 * Custodial Balance Facilitator (password-free / 免密支付 rail).
 *
 * Third payment mode beside per-transaction crypto signing and fiat QR
 * (Alipay/WeChat): buyers top up once into a server-custodied SQLite ledger
 * and subsequent purchases are deducted directly — no signature, no scan.
 *
 * Interface mapping (differs from the QR rails — see BALANCE-RAIL-DESIGN.md):
 * - `createPaymentRequirements` is **pure**: it formats the `accepts[]` entry
 *   without any I/O. Nothing is minted per 402, so the WeChat rail's
 *   order-per-challenge double-charge class of bug cannot occur here.
 * - `verify` is a read-only funds/limits precheck.
 * - `settle` is **the atomic deduction** (single SQLite transaction),
 *   idempotent on the client-supplied `request_id`.
 * - `refund` (rail-specific, not on the Facilitator interface) reverses a
 *   deduct when the skill fails after the charge.
 *
 * Execution order at the server is therefore inverted relative to QR rails:
 *   QR:      verify(paid?) → run skill → settle (confirm, fire-and-forget)
 *   balance: verify(funds?) → settle (deduct) → run skill → [fail → refund]
 *
 * @see ./balance/ledger.ts — SQLite ledger (atomicity, idempotency, limits)
 * @see ../../docs/BALANCE-RAIL-DESIGN.md — design
 */

import {
  BaseFacilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
  SettleResult,
  HealthCheckResult,
} from './interface.js';
import {
  BalanceLedger,
  LedgerConfig,
  DeductResult,
  RefundResult,
  toSat,
  fromSat,
  DEFAULT_SINGLE_LIMIT_SAT,
  DEFAULT_DAILY_LIMIT_SAT,
} from './balance/ledger.js';

/** Network identifier exposed via `Facilitator.supportedNetworks`. */
export const BALANCE_NETWORK = 'balance';

/** x402 `scheme` string identifying the custodial balance rail in `accepts[]`. */
export const BALANCE_SCHEME = 'balance';

export { toSat, fromSat };

/**
 * Facilitator-level config sourced from `provider.balance` in
 * `moltspay.services.json`.
 */
export interface BalanceFacilitatorConfig {
  /** SQLite ledger file path (created on first init). ':memory:' for tests. */
  db_path: string;
  /** Ledger quote currency. Default 'USD'. */
  currency?: string;
  /** Default per-transaction limit for new buyers, decimal string. Default "5.00". */
  single_limit?: string;
  /** Default daily limit for new buyers, decimal string. Default "10.00". */
  daily_limit?: string;
}

/** The buyer-identifying payload carried in X-Payment for this rail. */
export interface BalancePaymentPayload {
  buyer_id: string;
  /** Client-generated idempotency key: replays never double-deduct. */
  request_id?: string;
}

/** Extract {buyer_id, request_id} from an x402 payload, or null. */
export function extractBalancePayload(payment: X402PaymentPayload): BalancePaymentPayload | null {
  const p = payment.payload as Record<string, unknown> | undefined;
  if (p && typeof p.buyer_id === 'string' && p.buyer_id.length > 0) {
    return {
      buyer_id: p.buyer_id,
      request_id: typeof p.request_id === 'string' ? p.request_id : undefined,
    };
  }
  return null;
}

/**
 * Custodial balance facilitator. Construction opens (or creates) the SQLite
 * ledger; on Node < 22.5 it throws with an actionable message.
 */
export class BalanceFacilitator extends BaseFacilitator {
  readonly name = 'balance';
  readonly displayName = 'Custodial Balance';
  readonly supportedNetworks = [BALANCE_NETWORK];

  readonly currency: string;
  private readonly ledger: BalanceLedger;

  constructor(config: BalanceFacilitatorConfig) {
    super();
    this.currency = config.currency ?? 'USD';
    const ledgerConfig: LedgerConfig = {
      dbPath: config.db_path,
      defaultSingleLimitSat: config.single_limit ? toSat(config.single_limit) : DEFAULT_SINGLE_LIMIT_SAT,
      defaultDailyLimitSat: config.daily_limit ? toSat(config.daily_limit) : DEFAULT_DAILY_LIMIT_SAT,
      currency: this.currency,
    };
    this.ledger = new BalanceLedger(ledgerConfig);
  }

  /** Direct ledger access for the server's balance-management endpoints. */
  getLedger(): BalanceLedger {
    return this.ledger;
  }

  /**
   * Build the `accepts[]` entry for a service. Pure — no I/O, nothing minted.
   */
  createPaymentRequirements(opts: { price: string; serviceId?: string }): X402PaymentRequirements {
    toSat(opts.price); // validate format early
    return {
      scheme: BALANCE_SCHEME,
      network: BALANCE_NETWORK,
      asset: this.currency,
      amount: opts.price,
      payTo: 'custodial',
      maxTimeoutSeconds: 30,
      extra: opts.serviceId ? { service_id: opts.serviceId } : undefined,
    };
  }

  /** Read-only funds/limits precheck. Never mutates the ledger. */
  async verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<VerifyResult> {
    const payload = extractBalancePayload(paymentPayload);
    if (!payload) {
      return { valid: false, error: 'Missing buyer_id in balance payment payload' };
    }
    let amountSat: number;
    try {
      amountSat = toSat(requirements.amount);
    } catch (err: any) {
      return { valid: false, error: err.message };
    }
    const check = this.ledger.checkDeduct(payload.buyer_id, amountSat);
    if (!check.success) {
      return {
        valid: false,
        error: this.describeDeductError(check),
        details: { code: check.error, balance: check.balanceSat !== undefined ? fromSat(check.balanceSat) : undefined },
      };
    }
    return { valid: true, details: { balance: fromSat(check.balanceSat!) } };
  }

  /**
   * The atomic deduction. Idempotent on `request_id`; the returned
   * `transaction` is the ledger tx id (usable for `refund`).
   */
  async settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements
  ): Promise<SettleResult> {
    const payload = extractBalancePayload(paymentPayload);
    if (!payload) {
      return { success: false, error: 'Missing buyer_id in balance payment payload' };
    }
    let amountSat: number;
    try {
      amountSat = toSat(requirements.amount);
    } catch (err: any) {
      return { success: false, error: err.message };
    }
    const serviceId =
      typeof requirements.extra?.service_id === 'string' ? requirements.extra.service_id : undefined;
    let result: DeductResult;
    try {
      result = this.ledger.deduct({
        buyerId: payload.buyer_id,
        amountSat,
        requestId: payload.request_id,
        service: serviceId,
      });
    } catch (err: any) {
      return { success: false, error: `Ledger deduct failed: ${err.message}` };
    }
    if (!result.success) {
      return { success: false, error: this.describeDeductError(result), status: result.error };
    }
    return {
      success: true,
      transaction: result.txId,
      status: result.replayed ? 'replayed' : 'deducted',
    };
  }

  /** Reverse a deduct after a downstream failure. Idempotent per deduct. */
  refund(deductTxId: string, reason?: string): RefundResult {
    return this.ledger.refund(deductTxId, reason);
  }

  /**
   * Credit a gateway-verified external settlement to a buyer's balance. The
   * single entry point for every funding path -- WeChat callback, WeChat
   * polling, and the operator `/balance/topup` endpoint -- so they share one
   * idempotency boundary: `externalRef` is unique in the ledger, so a replay
   * credits nothing and returns the original transaction (`replayed: true`).
   * Callers must pass a gateway-verified `amountSat`, never a client-declared
   * amount.
   */
  credit(opts: {
    buyerId: string;
    amountSat: number;
    externalRef: string;
    description?: string;
  }): { txId: string; balance: string; balanceSat: number; replayed: boolean } {
    const result = this.ledger.topup({
      buyerId: opts.buyerId,
      amountSat: opts.amountSat,
      externalRef: opts.externalRef,
      description: opts.description,
    });
    return {
      txId: result.txId,
      balance: fromSat(result.balanceSat),
      balanceSat: result.balanceSat,
      replayed: result.replayed ?? false,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const ok = this.ledger.integrityOk();
      return ok
        ? { healthy: true, latencyMs: Date.now() - start }
        : { healthy: false, error: 'SQLite quick_check failed' };
    } catch (err: any) {
      return { healthy: false, error: err.message };
    }
  }

  private describeDeductError(result: DeductResult): string {
    switch (result.error) {
      case 'buyer_not_found':
        return 'Unknown buyer: top up first to create an account';
      case 'buyer_not_active':
        return 'Buyer account is frozen or banned';
      case 'insufficient_balance':
        return `Insufficient balance${result.balanceSat !== undefined ? ` (have ${fromSat(result.balanceSat)})` : ''}`;
      case 'exceeds_single_limit':
        return `Amount exceeds the per-transaction limit${result.limitSat !== undefined ? ` of ${fromSat(result.limitSat)}` : ''}`;
      case 'exceeds_daily_limit':
        return `Amount exceeds the daily spending limit${result.limitSat !== undefined ? ` of ${fromSat(result.limitSat)}` : ''}`;
      default:
        return 'Deduction failed';
    }
  }
}
