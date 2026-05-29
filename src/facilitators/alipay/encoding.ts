/**
 * Base64URL encoding helpers for Alipay AI 收 wire format.
 *
 * Alipay's `Payment-Needed` and `Payment-Proof` headers use Base64URL
 * (`-` replaces `+`, `_` replaces `/`, padding optional). Some proxies
 * strip the trailing `=` padding; `decodeBase64UrlWithPadFix` recovers it
 * and accepts either alphabet.
 */

/**
 * Encode a UTF-8 string as Base64URL (no padding).
 *
 * @param input - UTF-8 string to encode
 * @returns Base64URL representation (no `=` padding)
 */
export function base64url(input: string): string {
  return Buffer.from(input, 'utf-8').toString('base64url');
}

/**
 * Decode a Base64URL (or standard Base64) string to a UTF-8 string.
 *
 * Tolerates either URL-safe (`-` `_`) or standard (`+` `/`) alphabets,
 * with or without trailing `=` padding. Used for `Payment-Needed` and
 * `Payment-Proof` headers where proxies may strip padding.
 *
 * @param input - Base64URL or Base64 string
 * @returns Decoded UTF-8 string
 */
export function decodeBase64UrlWithPadFix(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf-8');
}
