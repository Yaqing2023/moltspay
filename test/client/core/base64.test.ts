import { describe, it, expect } from 'vitest';
import {
  encodeBase64,
  decodeBase64,
  encodeBase64Url,
  decodeBase64Url,
} from '../../../src/client/core/base64.js';

describe('base64', () => {
  it('encodes/decodes ASCII', () => {
    const input = 'hello world';
    expect(encodeBase64(input)).toBe('aGVsbG8gd29ybGQ=');
    expect(decodeBase64('aGVsbG8gd29ybGQ=')).toBe(input);
  });

  it('encodes/decodes JSON (typical x402 payload)', () => {
    const payload = { x402Version: 2, scheme: 'permit', network: 'eip155:42431' };
    const encoded = encodeBase64(JSON.stringify(payload));
    const decoded = JSON.parse(decodeBase64(encoded));
    expect(decoded).toEqual(payload);
  });

  it('encodes/decodes UTF-8 multibyte characters', () => {
    const input = 'Hello, 世界 🌍';
    expect(decodeBase64(encodeBase64(input))).toBe(input);
  });

  it('base64url replaces +/ with -_ and strips padding', () => {
    // Input crafted so standard base64 contains + and /:
    // "\xfb\xff\xbe" → "+/++" in standard, "-_--" in url-safe (no padding).
    const raw = String.fromCharCode(0xfb, 0xff, 0xbe);
    const std = encodeBase64(raw);
    const url = encodeBase64Url(raw);
    expect(std).toContain('+');
    expect(url).not.toContain('+');
    expect(url).not.toContain('/');
    expect(url).not.toContain('=');
  });

  it('base64url round-trips', () => {
    const input = 'MPP credentials typically use base64url-no-padding';
    expect(decodeBase64Url(encodeBase64Url(input))).toBe(input);
  });
});
