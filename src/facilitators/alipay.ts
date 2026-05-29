/**
 * Alipay AI 收 Facilitator (1.7.0)
 *
 * Implements the `Facilitator` interface for Alipay's 智能收 (AI Pay) 402
 * protocol. Adds a fiat rail (CNY) alongside the existing USDC/EVM/SVM
 * rails. Server-side only; clients shell out to the `alipay-bot` CLI
 * (see `AlipayClient` under `src/client/alipay/` in 1.7.0-rc.2).
 *
 * Key protocol differences from x402:
 * - Wire challenge is Base64URL-encoded `Payment-Needed` header with
 *   nested `{protocol, method}` JSON (not flat `accepts[]`).
 * - Amount unit is **元** (CNY decimal string, not atomic units).
 * - Signature is RSA2 (SHA256WithRSA), not EIP-712 / EIP-3009.
 * - Verify/settle hit Alipay Open API HTTP endpoints, not chain RPC.
 *
 * The server emits **both** `X-Payment-Required` and `Payment-Needed`
 * headers so that legacy `alipay-bot` skills (`@alipay/agent-payment@1.0.9`)
 * keep working without changes.
 *
 * @see ../../docs/ALIPAY-RAIL.md — end-user integration guide
 * @see ../../docs/ALIPAY-INTEGRATION-DESIGN.md — architecture & decisions
 * @see ../../docs/ALIPAY-INTEGRATION-PLAN.md — implementation milestones
 *
 * Stub for 1.7.0-rc.1; bodies tracked in ALIPAY-INTEGRATION-PLAN.md §1.
 */

import {
  BaseFacilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
  SettleResult,
  HealthCheckResult,
} from './interface.js';

/** Network identifier exposed via `Facilitator.supportedNetworks`. */
export const ALIPAY_NETWORK = 'alipay';

/** x402 `scheme` string identifying the Alipay rail in `accepts[]`. */
export const ALIPAY_SCHEME = 'alipay-aipay';

/** Default production gateway URL. */
export const ALIPAY_GATEWAY_PROD = 'https://openapi.alipay.com/gateway.do';

/** Sandbox gateway URL (for testing without real CNY). */
export const ALIPAY_GATEWAY_SANDBOX = 'https://openapi.alipaydev.com/gateway.do';

/**
 * Facilitator-level configuration sourced from `provider.alipay` in
 * `moltspay.services.json`. The server resolves `private_key_path` and
 * `alipay_public_key_path` to PEM strings before constructing the facilitator.
 */
export interface AlipayFacilitatorConfig {
  /** Merchant Alipay ID (16 digits, e.g. `"2088641494699428"`). */
  seller_id: string;
  /** Application ID from Alipay Open Platform. */
  app_id: string;
  /** Merchant legal name; appears in `method.seller_name` of the 402 challenge. */
  seller_name: string;
  /** Fallback `service_id` when a service doesn't override it. */
  service_id_default: string;
  /** RSA2 merchant private key (PEM). Loaded from `private_key_path` by the server. */
  private_key_pem: string;
  /** Alipay platform public key (PEM). Loaded from `alipay_public_key_path` by the server. */
  alipay_public_key_pem: string;
  /** Open API gateway URL. Defaults to {@link ALIPAY_GATEWAY_PROD}. */
  gateway_url?: string;
  /** Signature algorithm. Only `RSA2` is supported. */
  sign_type?: 'RSA2';
}

/**
 * Inputs required to construct a 402 `Payment-Needed` challenge for a service.
 */
export interface CreatePaymentRequirementsOpts {
  /** Per-service Alipay `service_id` (overrides `provider.alipay.service_id_default`). */
  serviceId: string;
  /** CNY price as decimal string in **元** (e.g. `"1.00"` = 1 CNY). */
  priceCny: string;
  /** Goods name shown to the user in the Alipay app. */
  goodsName: string;
  /** Resource identifier (typically the request URL or its hash). */
  resourceId: string;
  /** Client-supplied `out_trade_no`; if omitted the facilitator generates one. */
  outTradeNo?: string;
}

/**
 * Both headers the server emits in a 402 response:
 * - `x402Accepts` → `X-Payment-Required` (x402 standard, for new MoltsPay clients)
 * - `paymentNeededHeader` → `Payment-Needed` (Alipay standard, for legacy `alipay-bot`)
 *
 * The two headers are mirrors of each other; the single source of truth lives
 * in the server config.
 */
export interface AlipayPaymentRequirements {
  x402Accepts: X402PaymentRequirements;
  paymentNeededHeader: string;
}

/**
 * Decoded `Payment-Proof` header from the buyer's request.
 *
 * The proof is Base64URL of `{protocol: {...}, method: {...}}` where:
 * - `protocol.trade_no` is the 32-digit Alipay trade number
 * - `protocol.payment_proof` is the RSA2-signed payment proof
 * - `method.client_session` echoes the buyer's session for replay protection
 */
export interface AlipayPaymentProof {
  protocol: {
    payment_proof: string;
    trade_no: string;
    [k: string]: unknown;
  };
  method: {
    client_session: string;
    [k: string]: unknown;
  };
}

/**
 * Alipay AI 收 facilitator.
 *
 * Construction is cheap; expensive setup (key parsing, gateway probe) is
 * deferred to `healthCheck()`.
 */
export class AlipayFacilitator extends BaseFacilitator {
  readonly name = 'alipay';
  readonly displayName = 'Alipay AI 收';
  readonly supportedNetworks = [ALIPAY_NETWORK];

  private readonly config: AlipayFacilitatorConfig;

  constructor(config: AlipayFacilitatorConfig) {
    super();
    this.config = {
      gateway_url: ALIPAY_GATEWAY_PROD,
      sign_type: 'RSA2',
      ...config,
    };
  }

  /**
   * Build the 402 challenge for a service: signs the 8-field payload with
   * RSA2, packages the nested `{protocol, method}` JSON as Base64URL for
   * `Payment-Needed`, and emits the parallel x402 `accepts[]` entry.
   */
  async createPaymentRequirements(
    opts: CreatePaymentRequirementsOpts,
  ): Promise<AlipayPaymentRequirements> {
    throw new Error('AlipayFacilitator.createPaymentRequirements: not implemented (1.7.0-rc.1 stub)');
  }

  /**
   * Verify a `Payment-Proof`: RSA2-verifies the signature locally, then
   * calls `alipay.aipay.agent.payment.verify` against the Alipay Open API.
   */
  async verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<VerifyResult> {
    throw new Error('AlipayFacilitator.verify: not implemented (1.7.0-rc.1 stub)');
  }

  /**
   * Settle by calling `alipay.aipay.agent.fulfillment.confirm` after the
   * service resource has been returned to the buyer. Fire-and-forget by
   * design: failure here does **not** roll back the resource delivery.
   */
  async settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<SettleResult> {
    throw new Error('AlipayFacilitator.settle: not implemented (1.7.0-rc.1 stub)');
  }

  /**
   * Ping the Open API gateway and validate the merchant private key parses.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    throw new Error('AlipayFacilitator.healthCheck: not implemented (1.7.0-rc.1 stub)');
  }
}
