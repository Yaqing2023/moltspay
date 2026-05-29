/**
 * Unit tests for src/facilitators/alipay/rsa2.ts
 *
 * Uses runtime-generated 2048-bit RSA keypairs (no embedded secrets in repo).
 * Two independent keys are generated to verify cross-key isolation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import {
  rsa2Sign,
  rsa2Verify,
} from '../../../src/facilitators/alipay/rsa2.js';

interface KeyPair {
  publicKey: string;
  privateKey: string;
}

function generateKeyPair(): KeyPair {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

describe('alipay/rsa2', () => {
  let merchant: KeyPair;
  let attacker: KeyPair;

  beforeAll(() => {
    merchant = generateKeyPair();
    attacker = generateKeyPair();
  });

  describe('rsa2Sign', () => {
    it('produces a base64 signature', () => {
      const sig = rsa2Sign('hello', merchant.privateKey);
      expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(sig.length).toBeGreaterThan(0);
    });

    it('is deterministic for the same input (PKCS#1 v1.5)', () => {
      const sig1 = rsa2Sign('hello', merchant.privateKey);
      const sig2 = rsa2Sign('hello', merchant.privateKey);
      expect(sig1).toBe(sig2);
    });

    it('produces different signatures for different data', () => {
      const sig1 = rsa2Sign('hello', merchant.privateKey);
      const sig2 = rsa2Sign('world', merchant.privateKey);
      expect(sig1).not.toBe(sig2);
    });

    it('handles UTF-8 (Chinese) data', () => {
      const sig = rsa2Sign('支付宝 AI 收', merchant.privateKey);
      expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('signs the realistic 8-field payload shape', () => {
      // Dictionary-sorted querystring as built by AlipayFacilitator
      const sortedQs = [
        'amount=1.00',
        'currency=CNY',
        'goods_name=demo',
        'out_trade_no=VID00000000000000000000000000A',
        'pay_before=2026-05-29T07:30:00Z',
        'resource_id=https://merchant.example/r1',
        'seller_id=2088641494699428',
        'service_id=API_0EA6DC4FC99A4DF7',
      ].join('&');
      const sig = rsa2Sign(sortedQs, merchant.privateKey);
      expect(rsa2Verify(sortedQs, sig, merchant.publicKey)).toBe(true);
    });

    it('throws on a malformed private key', () => {
      expect(() => rsa2Sign('hello', 'not-a-pem')).toThrow();
    });
  });

  describe('rsa2Verify', () => {
    it('accepts a valid signature', () => {
      const sig = rsa2Sign('hello', merchant.privateKey);
      expect(rsa2Verify('hello', sig, merchant.publicKey)).toBe(true);
    });

    it('rejects a signature against tampered data', () => {
      const sig = rsa2Sign('hello', merchant.privateKey);
      expect(rsa2Verify('hellX', sig, merchant.publicKey)).toBe(false);
    });

    it('rejects a signature signed by a different private key', () => {
      const sigByAttacker = rsa2Sign('hello', attacker.privateKey);
      expect(rsa2Verify('hello', sigByAttacker, merchant.publicKey)).toBe(false);
    });

    it('rejects signature bytes that have been mangled', () => {
      const sig = rsa2Sign('hello', merchant.privateKey);
      const tampered = sig.slice(0, -8) + 'AAAAAAAA';
      expect(rsa2Verify('hello', tampered, merchant.publicKey)).toBe(false);
    });

    it('returns false (does not throw) on a malformed signature', () => {
      expect(rsa2Verify('hello', '!!!not-base64', merchant.publicKey)).toBe(false);
    });

    it('returns false (does not throw) on a malformed public key', () => {
      const sig = rsa2Sign('hello', merchant.privateKey);
      expect(rsa2Verify('hello', sig, 'not-a-pem')).toBe(false);
    });

    it('returns false on an empty signature string', () => {
      expect(rsa2Verify('hello', '', merchant.publicKey)).toBe(false);
    });

    it('verifies UTF-8 (Chinese) data correctly', () => {
      const data = '支付宝 AI 收';
      const sig = rsa2Sign(data, merchant.privateKey);
      expect(rsa2Verify(data, sig, merchant.publicKey)).toBe(true);
    });
  });
});
