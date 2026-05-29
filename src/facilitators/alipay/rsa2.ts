/**
 * RSA2 (SHA256WithRSA) signing helpers for Alipay AI 收.
 *
 * Uses Node's built-in `crypto` module. On the merchant side, MoltsPay
 * signs the 8 fields of the 402 challenge in dictionary order
 * (`amount` / `currency` / `goods_name` / `out_trade_no` / `pay_before` /
 * `resource_id` / `seller_id` / `service_id`). On the verify side, the
 * Alipay platform public key is used against `Payment-Proof` headers.
 *
 * Stub for 1.7.0-rc.1; implementation tracked in ALIPAY-INTEGRATION-PLAN.md §1.
 */

/**
 * Sign a string with RSA2 (SHA256WithRSA) using a PEM-encoded private key.
 *
 * @param data - The exact bytes to sign (already dictionary-sorted querystring)
 * @param privateKeyPem - PKCS#1 or PKCS#8 PEM-encoded RSA private key
 * @returns Base64-encoded signature suitable for the `seller_signature` field
 */
export function rsa2Sign(data: string, privateKeyPem: string): string {
  throw new Error('alipay/rsa2.rsa2Sign: not implemented (1.7.0-rc.1 stub)');
}

/**
 * Verify an RSA2 signature against the Alipay platform public key.
 *
 * @param data - The exact bytes that were signed
 * @param signature - Base64-encoded signature from `Payment-Proof`
 * @param publicKeyPem - PEM-encoded Alipay platform public key
 * @returns `true` if the signature is valid
 */
export function rsa2Verify(
  data: string,
  signature: string,
  publicKeyPem: string,
): boolean {
  throw new Error('alipay/rsa2.rsa2Verify: not implemented (1.7.0-rc.1 stub)');
}
