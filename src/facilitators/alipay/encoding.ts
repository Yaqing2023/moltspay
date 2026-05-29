/**
 * Base64URL encoding helpers for Alipay AI 收 wire format.
 *
 * Alipay's `Payment-Needed` and `Payment-Proof` headers use Base64URL
 * (`-` replaces `+`, `_` replaces `/`, padding optional). Some proxies
 * strip the trailing `=` padding; `decodeBase64UrlWithPadFix` recovers it
 * before standard base64 decoding.
 *
 * Stub for 1.7.0-rc.1; implementation tracked in ALIPAY-INTEGRATION-PLAN.md §1.
 */

/**
 * Encode a UTF-8 string as Base64URL (no padding).
 *
 * @param input - UTF-8 string to encode
 * @returns Base64URL representation (no `=` padding)
 */
export function base64url(input: string): string {
  throw new Error('alipay/encoding.base64url: not implemented (1.7.0-rc.1 stub)');
}

/**
 * Decode a Base64URL string (with or without padding) to a UTF-8 string.
 * Automatically restores `=` padding before standard decoding.
 *
 * @param input - Base64URL string, possibly missing trailing `=` padding
 * @returns Decoded UTF-8 string
 */
export function decodeBase64UrlWithPadFix(input: string): string {
  throw new Error('alipay/encoding.decodeBase64UrlWithPadFix: not implemented (1.7.0-rc.1 stub)');
}
