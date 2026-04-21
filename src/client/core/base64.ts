/**
 * Universal base64 — works in both browser and Node without polyfills.
 *
 * Node has `Buffer`, browsers have `btoa`/`atob`. We detect at runtime to
 * avoid pulling a Buffer polyfill into the web bundle.
 */

type BufferLike = {
  from(input: string | Uint8Array, encoding?: string): { toString(enc: string): string };
};

const BufferCtor: BufferLike | undefined =
  (globalThis as { Buffer?: BufferLike }).Buffer;

/** Encode a UTF-8 string as base64 (standard, with padding). */
export function encodeBase64(input: string): string {
  if (BufferCtor) {
    return BufferCtor.from(input, 'utf-8').toString('base64');
  }
  // Browser path: btoa requires binary (Latin-1) string; UTF-8 → bytes → binary string.
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode a standard base64 string into a UTF-8 string. */
export function decodeBase64(input: string): string {
  if (BufferCtor) {
    return BufferCtor.from(input, 'base64').toString('utf-8');
  }
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/** Decode a base64url string (RFC 4648 §5: `-` and `_` instead of `+` and `/`, optional padding). */
export function decodeBase64Url(input: string): string {
  const standard = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  return decodeBase64(padded);
}

/** Encode a UTF-8 string as base64url (no padding). */
export function encodeBase64Url(input: string): string {
  return encodeBase64(input)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Decode a base64 string to raw bytes. Used for Solana transactions where the payload is binary. */
export function base64ToUint8Array(input: string): Uint8Array {
  if (BufferCtor) {
    const buf = BufferCtor.from(input, 'base64') as unknown as Uint8Array;
    return new Uint8Array(buf);
  }
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Encode raw bytes as a base64 string. */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (BufferCtor) {
    return BufferCtor.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
