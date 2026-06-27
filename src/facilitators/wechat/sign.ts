/**
 * WeChat Pay v3 signing / verification helpers (SHA256-RSA).
 *
 * Direction of trust:
 * - **Request** (merchant → WeChat): sign the canonical
 *   `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n` string with the merchant RSA
 *   private key, then pack it into the `Authorization` header.
 * - **Response / callback** (WeChat → merchant): verify the
 *   `Wechatpay-Signature` header over `TIMESTAMP\nNONCE\nBODY\n` using the
 *   WeChat **platform certificate** public key.
 *
 * Padding is PKCS#1 v1.5 (Node default for `RSA-SHA256`), which is what
 * WeChat Pay v3 uses (`WECHATPAY2-SHA256-RSA2048`).
 *
 * @see https://pay.weixin.qq.com/docs/merchant/development/interface-rules/signature-generation.html
 */

import crypto from 'node:crypto';

/** The auth scheme token WeChat Pay v3 mandates in the Authorization header. */
export const WECHAT_AUTH_SCHEMA = 'WECHATPAY2-SHA256-RSA2048';

/**
 * Build the canonical message that v3 signs for an outbound request.
 *
 * `urlPath` is the path **plus query string** (e.g.
 * `/v3/pay/transactions/out-trade-no/X?mchid=Y`), NOT the full URL.
 * `body` is the exact request body bytes (`""` for GET / no-body requests).
 *
 * Exported for unit testing only.
 */
export function buildRequestMessage(
  method: string,
  urlPath: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return `${method.toUpperCase()}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
}

/**
 * Sign an outbound v3 request with the merchant private key.
 *
 * @returns Base64 signature for the `signature="..."` field
 * @throws If the private key is malformed
 */
export function wechatV3Sign(
  method: string,
  urlPath: string,
  timestamp: string,
  nonce: string,
  body: string,
  privateKeyPem: string,
): string {
  const message = buildRequestMessage(method, urlPath, timestamp, nonce, body);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(message, 'utf-8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

/**
 * Assemble the `Authorization` header value for a v3 request.
 *
 *   WECHATPAY2-SHA256-RSA2048 mchid="..",nonce_str="..",signature="..",timestamp="..",serial_no=".."
 */
export function buildAuthorizationToken(args: {
  mchid: string;
  serialNo: string;
  nonce: string;
  timestamp: string;
  signature: string;
}): string {
  const fields = [
    `mchid="${args.mchid}"`,
    `nonce_str="${args.nonce}"`,
    `signature="${args.signature}"`,
    `timestamp="${args.timestamp}"`,
    `serial_no="${args.serialNo}"`,
  ].join(',');
  return `${WECHAT_AUTH_SCHEMA} ${fields}`;
}

/**
 * Verify a `Wechatpay-Signature` over a response or async callback.
 *
 * Returns `false` (never throws) for any failure — malformed key, bad
 * base64, tampered body, wrong key. Untrusted callback bytes are safe to
 * pass in.
 *
 * @param platformPublicKeyPem PEM public key extracted from the WeChat
 *   platform certificate (the cert WeChat issues, NOT the merchant key).
 */
export function wechatV3VerifyResponse(
  timestamp: string,
  nonce: string,
  body: string,
  signature: string,
  platformPublicKeyPem: string,
): boolean {
  try {
    const message = `${timestamp}\n${nonce}\n${body}\n`;
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(message, 'utf-8');
    verifier.end();
    return verifier.verify(platformPublicKeyPem, signature, 'base64');
  } catch {
    return false;
  }
}

/**
 * Generate a v3 `nonce_str` (32 hex chars). Cryptographically random.
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}
