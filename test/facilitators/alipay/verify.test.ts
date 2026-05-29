/**
 * Unit tests for AlipayFacilitator.verify (src/facilitators/alipay.ts)
 *
 * Covers:
 * - extractProofHeader internal helper (input shape tolerance + rejection)
 * - decodeProof internal helper (Base64URL decode + field validation)
 * - verify() happy path (Alipay code=10000 → valid: true with details)
 * - verify() business error pass-through (code=40004 → valid: false)
 * - verify() malformed-payload safety (never throws, always returns
 *   { valid: false, error })
 * - openapi request shape (method name + biz_content with 3 fields)
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  AlipayFacilitator,
  AlipayFacilitatorConfig,
  extractProofHeader,
  decodeProof,
} from '../../../src/facilitators/alipay.js';
import { X402PaymentPayload, X402PaymentRequirements } from '../../../src/facilitators/interface.js';

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

function buildPaymentProof(overrides: Partial<{
  payment_proof: string;
  trade_no: string;
  client_session: string;
}> = {}): {
  encoded: string;
  decoded: { protocol: Record<string, string>; method: Record<string, string> };
} {
  const decoded = {
    protocol: {
      payment_proof: overrides.payment_proof ?? '7cf8a6a93c92ab1e9d2f',
      trade_no: overrides.trade_no ?? '20240528111111111111111111111111',
    },
    method: {
      client_session: overrides.client_session ?? 'ImNsaWVudFNlc3Npb25JZCI=',
    },
  };
  const encoded = Buffer.from(JSON.stringify(decoded), 'utf-8').toString('base64url');
  return { encoded, decoded };
}

const VERIFY_WRAPPER = 'alipay_aipay_agent_payment_verify_response';

const DUMMY_REQUIREMENTS: X402PaymentRequirements = {
  scheme: 'alipay-aipay',
  network: 'alipay',
  asset: 'CNY',
  amount: '1.00',
  payTo: '2088641494699428',
  maxTimeoutSeconds: 1800,
};

describe('AlipayFacilitator verify', () => {
  describe('extractProofHeader', () => {
    it('returns a string payload verbatim', () => {
      expect(extractProofHeader('AAA')).toBe('AAA');
    });

    it('accepts { paymentProof: string }', () => {
      expect(extractProofHeader({ paymentProof: 'BBB' })).toBe('BBB');
    });

    it('accepts { proofHeader: string }', () => {
      expect(extractProofHeader({ proofHeader: 'CCC' })).toBe('CCC');
    });

    it('throws on empty string', () => {
      expect(() => extractProofHeader('')).toThrow(/empty/);
    });

    it('throws on null', () => {
      expect(() => extractProofHeader(null)).toThrow(/Base64URL string or/);
    });

    it('throws on object without matching key', () => {
      expect(() => extractProofHeader({ foo: 'bar' })).toThrow(/Base64URL string or/);
    });

    it('throws when matching key is non-string', () => {
      expect(() => extractProofHeader({ paymentProof: 123 })).toThrow(/Base64URL string or/);
    });
  });

  describe('decodeProof', () => {
    it('decodes a well-formed Base64URL proof', () => {
      const { encoded, decoded } = buildPaymentProof();
      const result = decodeProof(encoded);
      expect(result.protocol.payment_proof).toBe(decoded.protocol.payment_proof);
      expect(result.protocol.trade_no).toBe(decoded.protocol.trade_no);
      expect(result.method.client_session).toBe(decoded.method.client_session);
    });

    it('throws when base64 decodes to non-JSON', () => {
      const garbage = Buffer.from('not json', 'utf-8').toString('base64url');
      expect(() => decodeProof(garbage)).toThrow(/failed to decode/);
    });

    it('throws when decoded value is not an object (e.g. number)', () => {
      const numeric = Buffer.from('42', 'utf-8').toString('base64url');
      expect(() => decodeProof(numeric)).toThrow(/not an object/);
    });

    it('throws on missing protocol.payment_proof', () => {
      const bad = Buffer.from(JSON.stringify({
        protocol: { trade_no: '2024' },
        method: { client_session: 'x' },
      }), 'utf-8').toString('base64url');
      expect(() => decodeProof(bad)).toThrow(/payment_proof/);
    });

    it('throws on missing protocol.trade_no', () => {
      const bad = Buffer.from(JSON.stringify({
        protocol: { payment_proof: 'x' },
        method: { client_session: 'x' },
      }), 'utf-8').toString('base64url');
      expect(() => decodeProof(bad)).toThrow(/trade_no/);
    });

    it('throws on missing method.client_session', () => {
      const bad = Buffer.from(JSON.stringify({
        protocol: { payment_proof: 'x', trade_no: '1' },
        method: {},
      }), 'utf-8').toString('base64url');
      expect(() => decodeProof(bad)).toThrow(/client_session/);
    });
  });

  describe('verify (via mocked Alipay Open API)', () => {
    let keys: KeyPair;
    let facilitator: AlipayFacilitator;
    let config: AlipayFacilitatorConfig;

    beforeAll(() => {
      keys = generateKeyPair();
    });

    beforeEach(() => {
      config = {
        seller_id: '2088641494699428',
        app_id: '2021006150642142',
        seller_name: '上海超响应数字科技有限公司',
        service_id_default: 'API_0EA6DC4FC99A4DF7',
        private_key_pem: keys.privateKey,
        alipay_public_key_pem: keys.publicKey,
        gateway_url: 'https://openapi.alipaydev.com/gateway.do',
      };
      facilitator = new AlipayFacilitator(config);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    function stubFetch(responseJson: unknown, status = 200) {
      const mock = vi.fn(async () =>
        new Response(JSON.stringify(responseJson), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', mock);
      return mock;
    }

    function buildPayload(payload: unknown): X402PaymentPayload {
      return { x402Version: 1, payload };
    }

    it('returns valid: true with details on Alipay code 10000', async () => {
      const { encoded } = buildPaymentProof();
      stubFetch({
        [VERIFY_WRAPPER]: {
          code: '10000',
          active: true,
          out_trade_no: 'VID01',
          trade_no: '20240528111111111111111111111111',
          amount: '1.00',
          resource_id: '/video/v_001',
        },
      });
      const result = await facilitator.verify(buildPayload(encoded), DUMMY_REQUIREMENTS);
      expect(result.valid).toBe(true);
      expect(result.details).toMatchObject({
        trade_no: '20240528111111111111111111111111',
        amount: '1.00',
        out_trade_no: 'VID01',
        resource_id: '/video/v_001',
        active: true,
      });
    });

    it('accepts proof as { paymentProof: string } payload shape', async () => {
      const { encoded } = buildPaymentProof();
      stubFetch({ [VERIFY_WRAPPER]: { code: '10000' } });
      const result = await facilitator.verify(
        buildPayload({ paymentProof: encoded }),
        DUMMY_REQUIREMENTS,
      );
      expect(result.valid).toBe(true);
    });

    it('calls alipay.aipay.agent.payment.verify with the 3 required biz_content fields', async () => {
      const { encoded, decoded } = buildPaymentProof();
      const mock = stubFetch({ [VERIFY_WRAPPER]: { code: '10000' } });
      await facilitator.verify(buildPayload(encoded), DUMMY_REQUIREMENTS);

      const init = mock.mock.calls[0][1] as RequestInit;
      const body = new URLSearchParams(String(init.body));
      expect(body.get('method')).toBe('alipay.aipay.agent.payment.verify');

      const biz = JSON.parse(body.get('biz_content')!);
      expect(biz).toEqual({
        payment_proof: decoded.protocol.payment_proof,
        trade_no: decoded.protocol.trade_no,
        client_session: decoded.method.client_session,
      });
    });

    it('returns valid: false on Alipay business error (code != 10000)', async () => {
      const { encoded } = buildPaymentProof();
      stubFetch({
        [VERIFY_WRAPPER]: {
          code: '40004',
          msg: 'Business Failed',
          sub_code: 'ACQ.TRADE_NOT_EXIST',
          sub_msg: 'trade_no 不存在',
        },
      });
      const result = await facilitator.verify(buildPayload(encoded), DUMMY_REQUIREMENTS);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('40004');
      expect(result.error).toContain('trade_no 不存在');
      expect(result.details).toMatchObject({
        code: '40004',
        sub_code: 'ACQ.TRADE_NOT_EXIST',
        sub_msg: 'trade_no 不存在',
      });
    });

    it('returns valid: false on HTTP error (does not throw)', async () => {
      const { encoded } = buildPaymentProof();
      stubFetch({ error: 'gateway down' }, 503);
      const result = await facilitator.verify(buildPayload(encoded), DUMMY_REQUIREMENTS);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/HTTP 503/);
    });

    it('returns valid: false on malformed proof payload (no throw)', async () => {
      stubFetch({ [VERIFY_WRAPPER]: { code: '10000' } });   // never reached
      const result = await facilitator.verify(buildPayload(null), DUMMY_REQUIREMENTS);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('returns valid: false on proof with missing fields (no throw)', async () => {
      stubFetch({ [VERIFY_WRAPPER]: { code: '10000' } });   // never reached
      const bad = Buffer.from(JSON.stringify({ protocol: {}, method: {} }), 'utf-8').toString('base64url');
      const result = await facilitator.verify(buildPayload(bad), DUMMY_REQUIREMENTS);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/payment_proof|trade_no|client_session/);
    });

    it('does not call fetch when proof decoding fails', async () => {
      const mock = stubFetch({});
      await facilitator.verify(buildPayload(''), DUMMY_REQUIREMENTS);
      expect(mock).not.toHaveBeenCalled();
    });
  });
});
