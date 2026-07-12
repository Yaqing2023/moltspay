/**
 * Base64URL encoding helpers for Alipay AI Pay wire format.
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

/**
 * Normalize an RSA key into PEM form.
 *
 * Alipay Open Platform hands out keys as **bare Base64** (a single line of
 * Base64-encoded DER, no `-----BEGIN-----` armor), but Node's `crypto`
 * key loaders and {@link rsa2Sign} require PEM. This wraps bare Base64 in
 * the requested PEM armor (64-char lines per RFC 7468); input that already
 * carries a `-----BEGIN` header is returned unchanged (trimmed).
 *
 * @param key  Bare Base64 (DER) or an already-armored PEM string.
 * @param kind `'PRIVATE'` → PKCS#8 `PRIVATE KEY`; `'PUBLIC'` → SPKI `PUBLIC KEY`.
 */
export function toPem(key: string, kind: 'PRIVATE' | 'PUBLIC'): string {
  const trimmed = key.trim();
  if (trimmed.includes('-----BEGIN')) return trimmed;
  const label = kind === 'PRIVATE' ? 'PRIVATE KEY' : 'PUBLIC KEY';
  const body = trimmed.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
