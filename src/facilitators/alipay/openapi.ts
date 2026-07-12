/**
 * Alipay Open API caller for AI Pay verify and fulfillment.
 *
 * Wraps the `application/x-www-form-urlencoded` gateway protocol
 * (`https://openapi.alipay.com/gateway.do` for production,
 * `https://openapi.alipaydev.com/gateway.do` for sandbox). Handles
 * RSA2 request signing, response unwrapping, and gateway-level error
 * surfacing.
 *
 * Request envelope (8 public params + `sign`):
 *   app_id        — application ID
 *   method        — e.g. `alipay.aipay.agent.payment.verify`
 *   format        — `JSON`
 *   charset       — `utf-8`
 *   sign_type     — `RSA2`
 *   timestamp     — `YYYY-MM-DD HH:mm:ss`
 *   version       — `1.0`
 *   biz_content   — JSON-stringified business params
 *   sign          — RSA2 signature over the other 8 params sorted by key
 *
 * Response envelope:
 *   { "<method_with_underscores>_response": { code, msg, ... } }
 *
 * NOTE: Response signature verification against the Alipay platform
 * public key is NOT implemented (relies on HTTPS transport integrity).
 * Adding it requires extracting raw bytes for the wrapped response key
 * from the response text; deferred to a future hardening pass.
 */

import { rsa2Sign } from './rsa2.js';

/**
 * Configuration required to make a single Open API call.
 */
export interface AlipayOpenApiConfig {
  gateway_url: string;
  app_id: string;
  private_key_pem: string;
  alipay_public_key_pem: string;
  sign_type?: 'RSA2';
}

/**
 * Unwrapped response from an Alipay Open API call.
 *
 * `code` is the Alipay business code (`"10000"` = success).
 * `sub_code` / `sub_msg` carry the specific failure reason when `code != "10000"`.
 */
export interface AlipayOpenApiResponse {
  code: string;
  msg?: string;
  sub_code?: string;
  sub_msg?: string;
  [key: string]: unknown;
}

/**
 * Format a JS Date as Alipay's expected `YYYY-MM-DD HH:mm:ss` timestamp.
 * Uses local time (matches the convention of merchant-region Open API SDKs).
 *
 * Exported for unit testing only.
 */
export function formatAlipayTimestamp(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Build the signing string for a set of Alipay Open API parameters:
 * keys sorted alphabetically, joined as `key=value&key=value`. Values
 * are NOT URL-encoded at this stage.
 *
 * Exported for unit testing only.
 */
export function buildSigningString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

/**
 * Derive the response wrapper key for a given method name.
 *
 *   "alipay.aipay.agent.payment.verify"
 *   → "alipay_aipay_agent_payment_verify_response"
 *
 * Exported for unit testing only.
 */
export function responseWrapperKey(method: string): string {
  return `${method.replace(/\./g, '_')}_response`;
}

/**
 * Call an Alipay Open API method.
 *
 * Common methods used by MoltsPay:
 *   - `alipay.aipay.agent.payment.verify` — verify a `Payment-Proof`
 *   - `alipay.aipay.agent.fulfillment.confirm` — confirm fulfillment
 *
 * @param method - Alipay Open API method name
 * @param bizContent - Method-specific business parameters
 * @param config - Gateway URL + credentials
 * @returns Unwrapped business response; check `code === "10000"` for success
 * @throws On HTTP-level failure, malformed JSON, or missing response wrapper
 */
export async function alipayOpenApiCall(
  method: string,
  bizContent: Record<string, unknown>,
  config: AlipayOpenApiConfig,
): Promise<AlipayOpenApiResponse> {
  const publicParams: Record<string, string> = {
    app_id: config.app_id,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: config.sign_type ?? 'RSA2',
    timestamp: formatAlipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  };

  const signingString = buildSigningString(publicParams);
  const sign = rsa2Sign(signingString, config.private_key_pem);

  const body = new URLSearchParams({ ...publicParams, sign }).toString();

  const response = await fetch(config.gateway_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '<unreadable>');
    throw new Error(
      `Alipay Open API HTTP ${response.status} for ${method}: ${text.slice(0, 500)}`,
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  const wrapperKey = responseWrapperKey(method);
  const business = json[wrapperKey];

  if (business === undefined || business === null || typeof business !== 'object') {
    throw new Error(
      `Alipay Open API response missing "${wrapperKey}" wrapper for ${method}: ` +
        `${JSON.stringify(json).slice(0, 500)}`,
    );
  }

  return business as AlipayOpenApiResponse;
}
