/**
 * Alipay Open API caller for AI 收 verify and fulfillment.
 *
 * Wraps the `application/x-www-form-urlencoded` gateway protocol
 * (`https://openapi.alipay.com/gateway.do` for production,
 * `https://openapi.alipaydev.com/gateway.do` for sandbox). Handles
 * RSA2 request signing, response parsing, and Alipay error-code
 * surfacing.
 *
 * Stub for 1.7.0-rc.1; implementation tracked in ALIPAY-INTEGRATION-PLAN.md §1.
 */

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
 * Call an Alipay Open API method.
 *
 * Common methods used by MoltsPay:
 * - `alipay.aipay.agent.payment.verify` — verify a Payment-Proof
 * - `alipay.aipay.agent.fulfillment.confirm` — confirm fulfillment after resource delivery
 *
 * @param method - Alipay Open API method name
 * @param bizContent - Method-specific business parameters
 * @param config - Gateway URL + credentials
 * @returns Unwrapped business response object; check `code === "10000"` for success
 * @throws On transport-layer failure (network, malformed response). Business
 *         errors are returned as `{ code, msg, sub_code, sub_msg }`.
 */
export async function alipayOpenApiCall(
  method: string,
  bizContent: Record<string, unknown>,
  config: AlipayOpenApiConfig,
): Promise<AlipayOpenApiResponse> {
  throw new Error('alipay/openapi.alipayOpenApiCall: not implemented (1.7.0-rc.1 stub)');
}
