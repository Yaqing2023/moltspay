/**
 * Unit tests for src/facilitators/alipay/encoding.ts
 *
 * Covers the three padding cases (no padding / `=` / `==`) called out in
 * ALIPAY-INTEGRATION-PLAN.md §1, plus UTF-8 handling, alphabet tolerance,
 * and round-trip fidelity.
 */

import { describe, it, expect } from 'vitest';
import {
  base64url,
  decodeBase64UrlWithPadFix,
} from '../../../src/facilitators/alipay/encoding.js';

describe('alipay/encoding', () => {
  describe('base64url', () => {
    it('encodes ASCII without padding', () => {
      expect(base64url('hello')).toBe('aGVsbG8');
    });

    it('encodes UTF-8 (Chinese) correctly', () => {
      // 支付宝 → 0xE6 0x94 0xAF 0xE4 0xBB 0x98 0xE5 0xAE 0x9D
      expect(base64url('支付宝')).toBe('5pSv5LuY5a6d');
    });

    it('uses URL-safe alphabet (- and _, not + and /)', () => {
      // ">>>>" produces "Pj4+Pg==" in standard base64; expect "-" not "+"
      const out = base64url('>>>>');
      expect(out).toBe('Pj4-Pg');
      expect(out).not.toContain('+');
      expect(out).not.toContain('/');
      expect(out).toMatch(/^[A-Za-z0-9\-_]*$/);
    });

    it('strips trailing = padding', () => {
      expect(base64url('1')).toBe('MQ');       // would be "MQ=="
      expect(base64url('12')).toBe('MTI');     // would be "MTI="
      expect(base64url('123')).toBe('MTIz');   // no padding either way
    });

    it('handles empty string', () => {
      expect(base64url('')).toBe('');
    });
  });

  describe('decodeBase64UrlWithPadFix', () => {
    it('decodes input with no padding', () => {
      expect(decodeBase64UrlWithPadFix('aGVsbG8')).toBe('hello');
    });

    it('decodes input with single = padding', () => {
      expect(decodeBase64UrlWithPadFix('MTI=')).toBe('12');
    });

    it('decodes input with double == padding', () => {
      expect(decodeBase64UrlWithPadFix('MQ==')).toBe('1');
    });

    it('accepts URL-safe alphabet (-, _)', () => {
      expect(decodeBase64UrlWithPadFix('Pj4-Pg')).toBe('>>>>');
      // "??" → "Pz8" (URL-safe) or "Pz8=" (standard)
      expect(decodeBase64UrlWithPadFix('Pz8')).toBe('??');
    });

    it('accepts standard alphabet (+, /) with or without padding', () => {
      expect(decodeBase64UrlWithPadFix('Pj4+Pg==')).toBe('>>>>');
      expect(decodeBase64UrlWithPadFix('Pj4+Pg')).toBe('>>>>');
    });

    it('decodes UTF-8 (Chinese)', () => {
      expect(decodeBase64UrlWithPadFix('5pSv5LuY5a6d')).toBe('支付宝');
    });

    it('handles empty string', () => {
      expect(decodeBase64UrlWithPadFix('')).toBe('');
    });
  });

  describe('round-trip', () => {
    it.each([
      ['ASCII', 'hello'],
      ['Chinese', '支付宝 AI 收'],
      ['JSON payload', JSON.stringify({
        protocol: { amount: '1.00', currency: 'CNY' },
        method: { seller_id: '2088641494699428' },
      })],
      ['mixed control chars', '\x00\x01\x7f'],
      ['empty', ''],
    ])('round-trips %s', (_label, s) => {
      expect(decodeBase64UrlWithPadFix(base64url(s))).toBe(s);
    });
  });
});
