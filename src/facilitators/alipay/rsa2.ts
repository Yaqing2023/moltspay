/**
 * RSA2 (SHA256WithRSA) signing helpers for Alipay AI Pay.
 *
 * Uses Node's built-in `crypto` module. On the merchant side, MoltsPay
 * signs the 8 fields of the 402 challenge in dictionary order
 * (`amount` / `currency` / `goods_name` / `out_trade_no` / `pay_before` /
 * `resource_id` / `seller_id` / `service_id`). On the verify side, the
 * Alipay platform public key is used against `Payment-Proof` headers.
 *
 * Padding: PKCS#1 v1.5 (Node default for `RSA-SHA256`), matching Alipay's
 * `SHA256WithRSA` algorithm identifier.
 */

import crypto from 'node:crypto';

/**
 * Sign a string with RSA2 (SHA256WithRSA) using a PEM-encoded private key.
 *
 * @param data - The exact bytes to sign (already dictionary-sorted querystring)
 * @param privateKeyPem - PKCS#1 or PKCS#8 PEM-encoded RSA private key
 * @returns Base64-encoded signature suitable for the `seller_signature` field
 * @throws If the private key is malformed
 */
export function rsa2Sign(data: string, privateKeyPem: string): string {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data, 'utf-8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

/**
 * Verify an RSA2 signature against the Alipay platform public key.
 *
 * Returns `false` (never throws) for any failure — malformed input,
 * wrong key, tampered data, or invalid base64. Untrusted callers can
 * pass arbitrary `Payment-Proof` bytes safely.
 *
 * @param data - The exact bytes that were signed
 * @param signature - Base64-encoded signature from `Payment-Proof`
 * @param publicKeyPem - PEM-encoded Alipay platform public key
 * @returns `true` if and only if the signature is valid
 */
export function rsa2Verify(
  data: string,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(data, 'utf-8');
    verifier.end();
    return verifier.verify(publicKeyPem, signature, 'base64');
  } catch {
    return false;
  }
}
