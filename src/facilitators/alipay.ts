/**
 * Alipay AI 收 Facilitator (2.0.0)
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

import crypto from 'node:crypto';
import {
  BaseFacilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
  SettleResult,
  HealthCheckResult,
} from './interface.js';
import { rsa2Sign } from './alipay/rsa2.js';
import { base64url, decodeBase64UrlWithPadFix } from './alipay/encoding.js';
import { alipayOpenApiCall, AlipayOpenApiConfig } from './alipay/openapi.js';

/** Network identifier exposed via `Facilitator.supportedNetworks`. */
export const ALIPAY_NETWORK = 'alipay';

/** x402 `scheme` string identifying the Alipay rail in `accepts[]`. */
export const ALIPAY_SCHEME = 'alipay-aipay';

/** Default production gateway URL. */
export const ALIPAY_GATEWAY_PROD = 'https://openapi.alipay.com/gateway.do';

/** Sandbox gateway URL (for testing without real CNY). */
export const ALIPAY_GATEWAY_SANDBOX = 'https://openapi.alipaydev.com/gateway.do';

/** Validation regex for `price_cny` / `amount` (decimal string, unit 元, ≤ 2 decimal places). */
export const ALIPAY_AMOUNT_REGEX = /^\d+(\.\d{1,2})?$/;

/** Lifetime of a 402 challenge before `pay_before` expires (Alipay convention). */
export const ALIPAY_PAY_BEFORE_MS = 30 * 60 * 1000;

/**
 * The 8 fields that get RSA2-signed in dictionary order for a 402 challenge.
 * Exposed for visibility; internal to {@link AlipayFacilitator}.
 */
export const ALIPAY_SIGNING_FIELDS = [
  'amount',
  'currency',
  'goods_name',
  'out_trade_no',
  'pay_before',
  'resource_id',
  'seller_id',
  'service_id',
] as const;

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
    if (!ALIPAY_AMOUNT_REGEX.test(opts.priceCny)) {
      throw new Error(
        `AlipayFacilitator.createPaymentRequirements: priceCny "${opts.priceCny}" ` +
          `does not match /^\\d+(\\.\\d{1,2})?$/ (unit is 元, not 分; e.g. "1.00" not "100")`,
      );
    }

    const now = new Date();
    const outTradeNo = opts.outTradeNo ?? generateOutTradeNo();
    const payBefore = formatPayBefore(now);

    // 8 fields signed (dictionary order enforced by `ALIPAY_SIGNING_FIELDS`)
    const signedFields = {
      amount: opts.priceCny,
      currency: 'CNY',
      goods_name: opts.goodsName,
      out_trade_no: outTradeNo,
      pay_before: payBefore,
      resource_id: opts.resourceId,
      seller_id: this.config.seller_id,
      service_id: opts.serviceId,
    } as const;

    const signingString = ALIPAY_SIGNING_FIELDS
      .map((k) => `${k}=${signedFields[k]}`)
      .join('&');
    const seller_signature = rsa2Sign(signingString, this.config.private_key_pem);

    const challenge = {
      protocol: {
        out_trade_no: outTradeNo,
        amount: signedFields.amount,
        currency: signedFields.currency,
        resource_id: signedFields.resource_id,
        pay_before: payBefore,
        seller_signature,
        seller_sign_type: this.config.sign_type ?? 'RSA2',
        seller_unique_id: this.config.seller_id,
      },
      method: {
        seller_name: this.config.seller_name,
        seller_id: this.config.seller_id,
        seller_app_id: this.config.app_id,
        goods_name: signedFields.goods_name,
        seller_unique_id_key: 'seller_id',
        service_id: signedFields.service_id,
      },
    };

    const paymentNeededHeader = base64url(JSON.stringify(challenge));

    const x402Accepts: X402PaymentRequirements = {
      scheme: ALIPAY_SCHEME,
      network: ALIPAY_NETWORK,
      asset: 'CNY',
      amount: opts.priceCny,
      payTo: this.config.seller_id,
      maxTimeoutSeconds: ALIPAY_PAY_BEFORE_MS / 1000,
      extra: {
        payment_needed_header: paymentNeededHeader,
        out_trade_no: outTradeNo,
        pay_before: payBefore,
        service_id: signedFields.service_id,
      },
    };

    return { x402Accepts, paymentNeededHeader };
  }

  /**
   * Verify a `Payment-Proof` by calling
   * `alipay.aipay.agent.payment.verify` against the Alipay Open API.
   *
   * The proof is conveyed via `paymentPayload.payload`, which may be:
   * - a raw Base64URL string (the `Payment-Proof` header value), or
   * - an object `{ paymentProof: string }` / `{ proofHeader: string }`.
   *
   * All failure modes (malformed payload, network errors, Alipay
   * `code != 10000`) return `{ valid: false, error }`. No exception
   * escapes, regardless of client-supplied input.
   */
  async verify(
    paymentPayload: X402PaymentPayload,
    _requirements: X402PaymentRequirements,
  ): Promise<VerifyResult> {
    try {
      const proofHeader = extractProofHeader(paymentPayload.payload);
      const decoded = decodeProof(proofHeader);

      const response = await alipayOpenApiCall(
        'alipay.aipay.agent.payment.verify',
        {
          payment_proof: decoded.protocol.payment_proof,
          trade_no: decoded.protocol.trade_no,
          client_session: decoded.method.client_session,
        },
        this.getOpenApiConfig(),
      );

      if (response.code !== '10000') {
        return {
          valid: false,
          error: `alipay verify ${response.code}: ${response.sub_msg ?? response.msg ?? 'unknown'}`,
          details: {
            code: response.code,
            sub_code: response.sub_code,
            sub_msg: response.sub_msg,
          },
        };
      }

      return {
        valid: true,
        details: {
          trade_no: (response.trade_no as string) ?? decoded.protocol.trade_no,
          amount: response.amount,
          out_trade_no: response.out_trade_no,
          resource_id: response.resource_id,
          active: response.active,
        },
      };
    } catch (e: unknown) {
      return {
        valid: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Settle by calling `alipay.aipay.agent.fulfillment.confirm` after the
   * service resource has been returned to the buyer.
   *
   * Per the design (see ALIPAY-INTEGRATION-DESIGN.md §5.1, risk row
   * "履约确认失败"), this is **fire-and-forget**: the caller (registry /
   * server) is expected to log fulfillment failures but NOT roll back
   * the already-delivered resource.
   *
   * Re-decodes `paymentPayload.payload` to extract `trade_no` (verify
   * does the same; the redundant Base64URL decode is negligible).
   */
  async settle(
    paymentPayload: X402PaymentPayload,
    _requirements: X402PaymentRequirements,
  ): Promise<SettleResult> {
    try {
      const proofHeader = extractProofHeader(paymentPayload.payload);
      const decoded = decodeProof(proofHeader);
      const tradeNo = decoded.protocol.trade_no;

      const response = await alipayOpenApiCall(
        'alipay.aipay.agent.fulfillment.confirm',
        { trade_no: tradeNo },
        this.getOpenApiConfig(),
      );

      if (response.code !== '10000') {
        return {
          success: false,
          transaction: tradeNo,
          error: `alipay fulfillment ${response.code}: ${response.sub_msg ?? response.msg ?? 'unknown'}`,
          status: 'fulfillment_failed',
        };
      }

      return {
        success: true,
        transaction: tradeNo,
        status: 'fulfilled',
      };
    } catch (e: unknown) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Validate that the configured RSA keys parse and that the Open API
   * gateway is reachable. Does NOT make a real business API call (would
   * burn quota and could appear as a legitimate verify attempt in logs).
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();

    try {
      crypto.createPrivateKey(this.config.private_key_pem);
    } catch (e: unknown) {
      return {
        healthy: false,
        error: `merchant private_key_pem parse failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    try {
      crypto.createPublicKey(this.config.alipay_public_key_pem);
    } catch (e: unknown) {
      return {
        healthy: false,
        error: `alipay_public_key_pem parse failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const gatewayUrl = this.config.gateway_url ?? ALIPAY_GATEWAY_PROD;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(gatewayUrl, {
      method: 'HEAD',
      signal: controller.signal,
    }).catch(() => null);
    clearTimeout(timeout);

    const latencyMs = Date.now() - start;

    if (!response) {
      return { healthy: false, error: `gateway unreachable: ${gatewayUrl}`, latencyMs };
    }
    return { healthy: true, latencyMs };
  }

  /** Bundle the facilitator config into the shape openapi.ts wants. */
  private getOpenApiConfig(): AlipayOpenApiConfig {
    return {
      gateway_url: this.config.gateway_url ?? ALIPAY_GATEWAY_PROD,
      app_id: this.config.app_id,
      private_key_pem: this.config.private_key_pem,
      alipay_public_key_pem: this.config.alipay_public_key_pem,
      sign_type: this.config.sign_type,
    };
  }
}

// ─── Internal helpers (exported for unit testing only) ────────────────────────

/**
 * Generate a 32-char `out_trade_no` with `VID` prefix + 29 random base64url
 * chars. Cryptographically random; uniqueness is statistical.
 *
 * @internal
 */
export function generateOutTradeNo(): string {
  // 22 random bytes → 30 base64url chars; slice 29 + "VID" prefix = 32 chars.
  return 'VID' + crypto.randomBytes(22).toString('base64url').slice(0, 29);
}

/**
 * Format `pay_before` as ISO 8601 UTC, exactly
 * {@link ALIPAY_PAY_BEFORE_MS} after the provided instant.
 * Strips fractional seconds for cleaner querystring signing.
 *
 * @internal
 */
export function formatPayBefore(now: Date): string {
  const expiry = new Date(now.getTime() + ALIPAY_PAY_BEFORE_MS);
  // toISOString returns "YYYY-MM-DDTHH:mm:ss.sssZ"; strip the ms.
  return expiry.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Extract the Base64URL Payment-Proof header from `paymentPayload.payload`.
 * Accepts a bare string or an object with `paymentProof` / `proofHeader` key.
 *
 * @internal
 * @throws If the payload shape doesn't match either contract
 */
export function extractProofHeader(payload: unknown): string {
  if (typeof payload === 'string') {
    if (payload.length === 0) {
      throw new Error('alipay Payment-Proof is empty');
    }
    return payload;
  }
  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const candidate = obj.paymentProof ?? obj.proofHeader;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  throw new Error(
    'alipay payment payload must be a Base64URL string or ' +
      '{paymentProof: string} / {proofHeader: string}',
  );
}

/**
 * Decode a Base64URL Payment-Proof header into its `{protocol, method}`
 * JSON shape, validating the three fields used by verify
 * (`protocol.payment_proof`, `protocol.trade_no`, `method.client_session`).
 *
 * @internal
 * @throws If decoding fails or required fields are missing
 */
export function decodeProof(proofHeader: string): AlipayPaymentProof {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64UrlWithPadFix(proofHeader));
  } catch (e: unknown) {
    throw new Error(
      `failed to decode Payment-Proof: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('decoded Payment-Proof is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const protocol = obj.protocol as Record<string, unknown> | undefined;
  const method = obj.method as Record<string, unknown> | undefined;
  if (!protocol || typeof protocol.payment_proof !== 'string') {
    throw new Error('decoded Payment-Proof missing protocol.payment_proof');
  }
  if (typeof protocol.trade_no !== 'string') {
    throw new Error('decoded Payment-Proof missing protocol.trade_no');
  }
  if (!method || typeof method.client_session !== 'string') {
    throw new Error('decoded Payment-Proof missing method.client_session');
  }
  return parsed as AlipayPaymentProof;
}
