/**
 * WeChat Pay v3 Facilitator (Native, scenario A).
 *
 * Implements the `Facilitator` interface for WeChat Pay's v3 **Native**
 * (scan-to-pay) flow. Adds a CNY fiat rail alongside the USDC/EVM/SVM and
 * Alipay rails. Server-side only.
 *
 * Scenario A — "agent issues a code, payer is not pre-bound":
 * - `createPaymentRequirements` places a Native order and returns its
 *   `code_url`. The code is **payer-agnostic** (no openid, unlike JSAPI):
 *   any WeChat user can scan it. It is **one-code-one-payment** — the first
 *   payer settles the order; collect again by issuing a new code.
 * - `verify` polls the order (`trade_state === 'SUCCESS'`).
 * - `settle` re-confirms SUCCESS and returns the `transaction_id` (Native
 *   captures funds at SUCCESS; there is no separate capture step).
 *
 * Key protocol differences from Alipay AI Pay (see docs/WECHAT-RAIL-DESIGN.md §3):
 * - REST/JSON gateway, not a form-urlencoded `gateway.do`.
 * - SHA256-RSA over `METHOD\nURL\nTS\nNONCE\nBODY\n`, packed into the
 *   `Authorization` header (handled by ./wechat/api.ts + ./wechat/sign.ts).
 * - Amount unit is **fen** (integer cents), not yuan — `cnyToFen` converts.
 *
 * Async callback decryption (AES-256-GCM) and the notify webhook are NOT in
 * this milestone; scenario A confirms via polling. They land in Phase 2.
 *
 * @see ./wechat/sign.ts — signing primitives
 * @see ./wechat/api.ts — v3 JSON caller
 * @see ../../docs/WECHAT-RAIL-DESIGN.md — design & scenario
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
import { WechatV3Config, wechatV3Call, WechatApiError, WECHAT_API_BASE } from './wechat/api.js';

/** Network identifier exposed via `Facilitator.supportedNetworks`. */
export const WECHAT_NETWORK = 'wechat';

/** x402 `scheme` string identifying the WeChat Native rail in `accepts[]`. */
export const WECHAT_SCHEME = 'wechatpay-native';

/** Validation regex for `price_cny` (decimal string, unit yuan, <= 2 decimals). */
export const WECHAT_AMOUNT_REGEX = /^\d+(\.\d{1,2})?$/;

/** Default order lifetime if the caller doesn't pass one (Native convention). */
export const WECHAT_TIME_EXPIRE_MS = 5 * 60 * 1000;

export { WECHAT_API_BASE };

/**
 * Facilitator-level config sourced from `provider.wechat` in
 * `moltspay.services.json`. The server resolves `private_key_path` /
 * `platform_public_key_path` to PEM strings before constructing this.
 */
export interface WechatFacilitatorConfig {
  /** Merchant id (mchid). */
  mchid: string;
  /** App id (official account / mini-program / app). */
  appid: string;
  /** Merchant API certificate serial number. */
  serial_no: string;
  /** Merchant RSA private key (PEM). */
  private_key_pem: string;
  /** WeChat platform certificate public key (PEM). Enables response verify. */
  platform_public_key_pem?: string;
  /** APIv3 key (32 bytes). Only needed for callback decryption (Phase 2). */
  apiv3_key?: string;
  /** Async result notify URL. **Required by Native order create** even when polling. */
  notify_url: string;
  /** Base URL; defaults to {@link WECHAT_API_BASE}. */
  api_base?: string;
}

/** Inputs to place a Native order (402 challenge) for a service. */
export interface CreatePaymentRequirementsOpts {
  /** CNY price as a decimal string in **yuan** (e.g. `"10.00"`). */
  priceCny: string;
  /** Order description shown to the payer in the WeChat app. */
  description: string;
  /** Client-supplied `out_trade_no`; generated when omitted. */
  outTradeNo?: string;
  /** Order lifetime; defaults to {@link WECHAT_TIME_EXPIRE_MS}. */
  expiresInMs?: number;
  /**
   * Passthrough metadata WeChat echoes back on order-query and callback
   * (v3 `attach`, max 128 bytes once JSON-serialized). Used to bind an
   * otherwise payer-agnostic Native order to a `buyer_id` for balance
   * top-ups. Read it back with {@link parseWechatAttach}.
   */
  attach?: Record<string, string>;
}

/** Result of placing a Native order. */
export interface WechatPaymentRequirements {
  /** x402 `accepts[]` entry (carries `extra.code_url` + `extra.out_trade_no`). */
  x402Accepts: X402PaymentRequirements;
  /** `weixin://wxpay/bizpayurl?pr=...` — render verbatim as a QR. */
  codeUrl: string;
  /** The order's merchant trade number, used to poll `verify`/`settle`. */
  outTradeNo: string;
}

/**
 * WeChat Pay v3 Native facilitator.
 *
 * Construction is cheap; key parsing / gateway probe is deferred to
 * `healthCheck()`.
 */
export class WechatFacilitator extends BaseFacilitator {
  readonly name = 'wechat';
  readonly displayName = 'WeChat Pay';
  readonly supportedNetworks = [WECHAT_NETWORK];

  private readonly config: WechatFacilitatorConfig;

  constructor(config: WechatFacilitatorConfig) {
    super();
    this.config = { api_base: WECHAT_API_BASE, ...config };
  }

  /**
   * Place a Native order and build the 402 challenge. The returned
   * `code_url` is payer-agnostic — any WeChat user may scan it.
   */
  async createPaymentRequirements(
    opts: CreatePaymentRequirementsOpts,
  ): Promise<WechatPaymentRequirements> {
    if (!WECHAT_AMOUNT_REGEX.test(opts.priceCny)) {
      throw new Error(
        `WechatFacilitator.createPaymentRequirements: priceCny "${opts.priceCny}" ` +
          `does not match /^\\d+(\\.\\d{1,2})?$/ (unit is yuan; e.g. "10.00")`,
      );
    }
    const total = cnyToFen(opts.priceCny);
    if (total < 1) {
      throw new Error(
        `WechatFacilitator.createPaymentRequirements: amount ${total} fen is below the 1 fen minimum`,
      );
    }

    const outTradeNo = opts.outTradeNo ?? generateOutTradeNo();
    const expiresInMs = opts.expiresInMs ?? WECHAT_TIME_EXPIRE_MS;

    const body: Record<string, unknown> = {
      appid: this.config.appid,
      mchid: this.config.mchid,
      description: opts.description,
      out_trade_no: outTradeNo,
      notify_url: this.config.notify_url,
      time_expire: formatTimeExpire(new Date(Date.now() + expiresInMs)),
      amount: { total, currency: 'CNY' },
    };

    if (opts.attach) {
      const attachStr = JSON.stringify(opts.attach);
      if (Buffer.byteLength(attachStr, 'utf8') > 128) {
        throw new Error(
          `WechatFacilitator.createPaymentRequirements: attach exceeds WeChat's 128-byte limit (${Buffer.byteLength(attachStr, 'utf8')} bytes)`,
        );
      }
      body.attach = attachStr;
    }

    const { body: resp } = await wechatV3Call(
      'POST',
      '/v3/pay/transactions/native',
      body,
      this.getApiConfig(),
    );

    const codeUrl = resp.code_url;
    if (typeof codeUrl !== 'string' || codeUrl.length === 0) {
      throw new Error(
        `WeChat Native order returned no code_url: ${JSON.stringify(resp).slice(0, 300)}`,
      );
    }

    const x402Accepts: X402PaymentRequirements = {
      scheme: WECHAT_SCHEME,
      network: WECHAT_NETWORK,
      asset: 'CNY',
      amount: opts.priceCny,
      payTo: this.config.mchid,
      maxTimeoutSeconds: Math.floor(expiresInMs / 1000),
      extra: {
        code_url: codeUrl,
        out_trade_no: outTradeNo,
      },
    };

    return { x402Accepts, codeUrl, outTradeNo };
  }

  /**
   * Poll an order: `trade_state === 'SUCCESS'` ⇒ paid. All failure modes
   * (missing out_trade_no, gateway error, not-yet-paid) return
   * `{ valid: false, error }`; no exception escapes.
   */
  async verify(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<VerifyResult> {
    try {
      const outTradeNo = extractOutTradeNo(paymentPayload, requirements);
      const resp = await this.queryOrder(outTradeNo);
      const tradeState = resp.trade_state as string | undefined;

      if (tradeState !== 'SUCCESS') {
        return {
          valid: false,
          error: `wechat trade_state ${tradeState ?? 'UNKNOWN'}`,
          details: { trade_state: tradeState, out_trade_no: outTradeNo },
        };
      }

      return {
        valid: true,
        details: {
          trade_state: tradeState,
          transaction_id: resp.transaction_id,
          out_trade_no: resp.out_trade_no ?? outTradeNo,
          amount: resp.amount,
          attach: resp.attach,
        },
      };
    } catch (e: unknown) {
      return { valid: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Confirm settlement. Native captures funds at SUCCESS, so this is an
   * idempotent re-confirm that returns the `transaction_id`. Like Alipay's
   * fulfillment confirm, failures are surfaced but non-fatal to an
   * already-delivered resource (caller logs, does not roll back).
   */
  async settle(
    paymentPayload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<SettleResult> {
    try {
      const outTradeNo = extractOutTradeNo(paymentPayload, requirements);
      const resp = await this.queryOrder(outTradeNo);
      const tradeState = resp.trade_state as string | undefined;
      const transactionId = resp.transaction_id as string | undefined;

      if (tradeState !== 'SUCCESS') {
        return {
          success: false,
          transaction: transactionId,
          error: `wechat trade_state ${tradeState ?? 'UNKNOWN'} (expected SUCCESS)`,
          status: tradeState,
        };
      }

      return { success: true, transaction: transactionId, status: 'fulfilled' };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Validate keys parse, apiv3 key length, and gateway reachability. Does
   * NOT make a business API call.
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
    if (this.config.platform_public_key_pem) {
      try {
        crypto.createPublicKey(this.config.platform_public_key_pem);
      } catch (e: unknown) {
        return {
          healthy: false,
          error: `platform_public_key_pem parse failed: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    if (this.config.apiv3_key !== undefined && Buffer.byteLength(this.config.apiv3_key, 'utf-8') !== 32) {
      return { healthy: false, error: 'apiv3_key must be exactly 32 bytes' };
    }

    const base = this.config.api_base ?? WECHAT_API_BASE;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(base, { method: 'HEAD', signal: controller.signal }).catch(() => null);
    clearTimeout(timeout);

    const latencyMs = Date.now() - start;
    if (!response) {
      return { healthy: false, error: `gateway unreachable: ${base}`, latencyMs };
    }
    return { healthy: true, latencyMs };
  }

  /** Query a Native order by out_trade_no. The query string is part of the signed path. */
  private async queryOrder(outTradeNo: string): Promise<Record<string, unknown>> {
    const path =
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}` +
      `?mchid=${encodeURIComponent(this.config.mchid)}`;
    const { body } = await wechatV3Call('GET', path, null, this.getApiConfig());
    return body;
  }

  /** Project the facilitator config down to what api.ts needs. */
  private getApiConfig(): WechatV3Config {
    return {
      mchid: this.config.mchid,
      serial_no: this.config.serial_no,
      private_key_pem: this.config.private_key_pem,
      platform_public_key_pem: this.config.platform_public_key_pem,
      api_base: this.config.api_base,
    };
  }
}

// ─── Internal helpers (exported for unit testing only) ────────────────────────

/**
 * Convert a CNY yuan decimal string to integer fen.
 * Uses rounding to avoid binary float drift (`0.10 * 100 = 10.000000000000002`).
 *
 * @internal
 */
export function cnyToFen(cny: string): number {
  return Math.round(parseFloat(cny) * 100);
}

/**
 * Generate a 32-char `out_trade_no`: `WX` prefix + 30 hex chars.
 * Within WeChat's allowed charset (`[a-zA-Z0-9_-|*@]`) and 6–32 length.
 *
 * @internal
 */
export function generateOutTradeNo(): string {
  return 'WX' + crypto.randomBytes(15).toString('hex');
}

/**
 * Safely parse the `attach` string echoed back on order-query / callback into
 * the object passed to {@link CreatePaymentRequirementsOpts.attach}. Returns
 * null for a missing, non-string, or malformed value (a per-transaction order
 * that carried no attach, or tampered input) so callers never throw on it.
 */
export function parseWechatAttach(attach: unknown): Record<string, string> | null {
  if (typeof attach !== 'string' || attach.length === 0) return null;
  try {
    const parsed = JSON.parse(attach);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Format a Date as WeChat's RFC 3339 `time_expire` with timezone offset
 * (e.g. `2026-06-27T12:30:00+08:00`). Uses the host timezone offset.
 *
 * @internal
 */
export function formatTimeExpire(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * Extract `out_trade_no` from the payment payload or, failing that, the
 * requirements `extra`. Accepts the payload as a bare string or an object
 * with `out_trade_no` / `outTradeNo`.
 *
 * @internal
 * @throws If no out_trade_no can be found
 */
export function extractOutTradeNo(
  paymentPayload: X402PaymentPayload,
  requirements?: X402PaymentRequirements,
): string {
  const p = paymentPayload?.payload;
  if (typeof p === 'string' && p.length > 0) return p;
  if (p !== null && typeof p === 'object') {
    const obj = p as Record<string, unknown>;
    const cand = obj.out_trade_no ?? obj.outTradeNo;
    if (typeof cand === 'string' && cand.length > 0) return cand;
  }
  const fromReq = requirements?.extra?.out_trade_no;
  if (typeof fromReq === 'string' && fromReq.length > 0) return fromReq;

  throw new Error(
    'wechat payment payload must carry out_trade_no (string, ' +
      '{out_trade_no}/{outTradeNo}, or requirements.extra.out_trade_no)',
  );
}

export { WechatApiError };
