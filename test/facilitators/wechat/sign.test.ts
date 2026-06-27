/**
 * Unit tests for src/facilitators/wechat/sign.ts
 *
 * Uses runtime-generated 2048-bit RSA keypairs (no embedded secrets in repo).
 * A second independent keypair models the WeChat platform key for verify, and
 * an attacker key proves cross-key isolation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import {
  WECHAT_AUTH_SCHEMA,
  buildRequestMessage,
  wechatV3Sign,
  buildAuthorizationToken,
  wechatV3VerifyResponse,
  generateNonce,
} from '../../../src/facilitators/wechat/sign.js';

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

describe('wechat/sign', () => {
  let merchant: KeyPair;
  let platform: KeyPair;
  let attacker: KeyPair;

  beforeAll(() => {
    merchant = generateKeyPair();
    platform = generateKeyPair();
    attacker = generateKeyPair();
  });

  describe('buildRequestMessage', () => {
    it('joins the 5 fields with newlines and a trailing newline', () => {
      const msg = buildRequestMessage(
        'post',
        '/v3/pay/transactions/native',
        '1700000000',
        'abc',
        '{"a":1}',
      );
      expect(msg).toBe('POST\n/v3/pay/transactions/native\n1700000000\nabc\n{"a":1}\n');
    });

    it('uppercases the HTTP method', () => {
      const msg = buildRequestMessage('get', '/x', '1', 'n', '');
      expect(msg.startsWith('GET\n')).toBe(true);
    });

    it('preserves an empty body as just a trailing newline', () => {
      const msg = buildRequestMessage('GET', '/x', '1', 'n', '');
      expect(msg).toBe('GET\n/x\n1\nn\n\n');
    });
  });

  describe('wechatV3Sign', () => {
    it('produces a base64 signature', () => {
      const sig = wechatV3Sign('POST', '/v3/x', '1700000000', 'nonce1', '{}', merchant.privateKey);
      expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('signs exactly the canonical message (verifiable with merchant public key)', () => {
      const args = ['POST', '/v3/pay/transactions/native', '1700000000', 'nonce2', '{"amount":10}'] as const;
      const sig = wechatV3Sign(...args, merchant.privateKey);
      const message = buildRequestMessage(...args);
      const ok = crypto
        .createVerify('RSA-SHA256')
        .update(message, 'utf-8')
        .verify(merchant.publicKey, sig, 'base64');
      expect(ok).toBe(true);
    });

    it('throws on a malformed private key', () => {
      expect(() => wechatV3Sign('GET', '/x', '1', 'n', '', 'not-a-key')).toThrow();
    });
  });

  describe('buildAuthorizationToken', () => {
    it('emits the WECHATPAY2-SHA256-RSA2048 schema with all 5 fields', () => {
      const token = buildAuthorizationToken({
        mchid: '1900000001',
        serialNo: 'ABCD1234',
        nonce: 'n1',
        timestamp: '1700000000',
        signature: 'sig==',
      });
      expect(token.startsWith(`${WECHAT_AUTH_SCHEMA} `)).toBe(true);
      expect(token).toContain('mchid="1900000001"');
      expect(token).toContain('serial_no="ABCD1234"');
      expect(token).toContain('nonce_str="n1"');
      expect(token).toContain('timestamp="1700000000"');
      expect(token).toContain('signature="sig=="');
    });
  });

  describe('wechatV3VerifyResponse', () => {
    function signAsPlatform(timestamp: string, nonce: string, body: string): string {
      return crypto
        .createSign('RSA-SHA256')
        .update(`${timestamp}\n${nonce}\n${body}\n`, 'utf-8')
        .sign(platform.privateKey, 'base64');
    }

    it('returns true for a genuine platform signature', () => {
      const ts = '1700000000';
      const nc = 'srvnonce';
      const body = '{"trade_state":"SUCCESS"}';
      const sig = signAsPlatform(ts, nc, body);
      expect(wechatV3VerifyResponse(ts, nc, body, sig, platform.publicKey)).toBe(true);
    });

    it('returns false when the body is tampered', () => {
      const ts = '1700000000';
      const nc = 'srvnonce';
      const sig = signAsPlatform(ts, nc, '{"trade_state":"SUCCESS"}');
      expect(
        wechatV3VerifyResponse(ts, nc, '{"trade_state":"CLOSED"}', sig, platform.publicKey),
      ).toBe(false);
    });

    it('returns false for a signature from a different (attacker) key', () => {
      const ts = '1700000000';
      const nc = 'srvnonce';
      const body = '{"x":1}';
      const sig = crypto
        .createSign('RSA-SHA256')
        .update(`${ts}\n${nc}\n${body}\n`, 'utf-8')
        .sign(attacker.privateKey, 'base64');
      expect(wechatV3VerifyResponse(ts, nc, body, sig, platform.publicKey)).toBe(false);
    });

    it('never throws on garbage input', () => {
      expect(wechatV3VerifyResponse('x', 'y', 'z', 'not-base64!!', 'not-a-key')).toBe(false);
    });
  });

  describe('generateNonce', () => {
    it('produces 32 hex chars', () => {
      expect(generateNonce()).toMatch(/^[0-9a-f]{32}$/);
    });

    it('is unique across calls', () => {
      expect(generateNonce()).not.toBe(generateNonce());
    });
  });
});
