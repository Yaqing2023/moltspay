/**
 * Unit tests for src/facilitators/alipay/openapi.ts
 *
 * Covers:
 * - Pure helpers: formatAlipayTimestamp, buildSigningString, responseWrapperKey
 * - alipayOpenApiCall request shape (URL, method, content-type, body fields,
 *   sign correctness, alphabetical key order, biz_content stringification)
 * - alipayOpenApiCall response handling (success unwrap, error pass-through,
 *   HTTP error, malformed wrapper)
 *
 * Uses runtime-generated 2048-bit RSA keypair and a vi.fn() fetch mock.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  alipayOpenApiCall,
  AlipayOpenApiConfig,
  formatAlipayTimestamp,
  buildSigningString,
  responseWrapperKey,
} from '../../../src/facilitators/alipay/openapi.js';
import { rsa2Verify } from '../../../src/facilitators/alipay/rsa2.js';

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

const VERIFY_METHOD = 'alipay.aipay.agent.payment.verify';
const VERIFY_WRAPPER = 'alipay_aipay_agent_payment_verify_response';

describe('alipay/openapi', () => {
  let keys: KeyPair;
  let config: AlipayOpenApiConfig;

  beforeAll(() => {
    keys = generateKeyPair();
  });

  beforeEach(() => {
    config = {
      gateway_url: 'https://openapi.alipaydev.com/gateway.do',
      app_id: '2021006150642142',
      private_key_pem: keys.privateKey,
      alipay_public_key_pem: keys.publicKey,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('formatAlipayTimestamp', () => {
    it('formats a fixed Date as YYYY-MM-DD HH:mm:ss', () => {
      // Construct from local-time fields so the assertion is timezone-stable
      const d = new Date(2026, 4, 29, 7, 30, 45); // 2026-05-29 07:30:45 local
      expect(formatAlipayTimestamp(d)).toBe('2026-05-29 07:30:45');
    });

    it('zero-pads single-digit components', () => {
      const d = new Date(2026, 0, 5, 3, 4, 9);
      expect(formatAlipayTimestamp(d)).toBe('2026-01-05 03:04:09');
    });

    it('matches the format pattern when called with no args', () => {
      expect(formatAlipayTimestamp()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });

  describe('buildSigningString', () => {
    it('sorts keys alphabetically and joins with &', () => {
      const s = buildSigningString({ b: '2', a: '1', c: '3' });
      expect(s).toBe('a=1&b=2&c=3');
    });

    it('does not URL-encode values', () => {
      const s = buildSigningString({ x: 'a=b&c d', y: '中文' });
      expect(s).toBe('x=a=b&c d&y=中文');
    });

    it('handles empty params', () => {
      expect(buildSigningString({})).toBe('');
    });
  });

  describe('responseWrapperKey', () => {
    it('replaces dots with underscores and appends _response', () => {
      expect(responseWrapperKey(VERIFY_METHOD)).toBe(VERIFY_WRAPPER);
      expect(responseWrapperKey('alipay.aipay.agent.fulfillment.confirm'))
        .toBe('alipay_aipay_agent_fulfillment_confirm_response');
    });
  });

  describe('alipayOpenApiCall request shape', () => {
    function stubFetchWithSuccess() {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ [VERIFY_WRAPPER]: { code: '10000', active: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    function parseBody(body: BodyInit | null | undefined): URLSearchParams {
      return new URLSearchParams(String(body));
    }

    it('POSTs to the configured gateway URL with form-urlencoded content type', async () => {
      const fetchMock = stubFetchWithSuccess();
      await alipayOpenApiCall(VERIFY_METHOD, {}, config);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(config.gateway_url);
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type'])
        .toBe('application/x-www-form-urlencoded;charset=utf-8');
    });

    it('includes all 8 public params + sign in the body', async () => {
      const fetchMock = stubFetchWithSuccess();
      await alipayOpenApiCall(VERIFY_METHOD, { trade_no: '20240528' }, config);
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const params = parseBody(init.body);
      expect(params.get('app_id')).toBe(config.app_id);
      expect(params.get('method')).toBe(VERIFY_METHOD);
      expect(params.get('format')).toBe('JSON');
      expect(params.get('charset')).toBe('utf-8');
      expect(params.get('sign_type')).toBe('RSA2');
      expect(params.get('version')).toBe('1.0');
      expect(params.get('timestamp')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(params.get('biz_content')).toBe(JSON.stringify({ trade_no: '20240528' }));
      expect(params.get('sign')).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('sign verifies against the merchant public key over the sorted signing string', async () => {
      const fetchMock = stubFetchWithSuccess();
      await alipayOpenApiCall(VERIFY_METHOD, { trade_no: '20240528', extra: '中文' }, config);
      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const params = parseBody(init.body);

      // Reconstruct signing string from body (exclude sign itself)
      const publicParams: Record<string, string> = {};
      params.forEach((value, key) => {
        if (key !== 'sign') publicParams[key] = value;
      });
      const signingString = buildSigningString(publicParams);
      const sign = params.get('sign')!;
      expect(rsa2Verify(signingString, sign, keys.publicKey)).toBe(true);
    });

    it('uses the configured sign_type when overridden', async () => {
      stubFetchWithSuccess();
      await alipayOpenApiCall(VERIFY_METHOD, {}, { ...config, sign_type: 'RSA2' });
      // (Only RSA2 is supported, but the field flows through)
    });
  });

  describe('alipayOpenApiCall response handling', () => {
    function stubFetchWith(responseJson: unknown, status = 200) {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify(responseJson), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    }

    it('returns the unwrapped business response on success', async () => {
      stubFetchWith({
        [VERIFY_WRAPPER]: {
          code: '10000',
          active: true,
          out_trade_no: 'VID123',
          trade_no: '20240528',
          amount: '1.00',
        },
      });
      const result = await alipayOpenApiCall(VERIFY_METHOD, {}, config);
      expect(result.code).toBe('10000');
      expect(result.active).toBe(true);
      expect(result.out_trade_no).toBe('VID123');
      expect(result.amount).toBe('1.00');
    });

    it('returns business error response (code != 10000) without throwing', async () => {
      stubFetchWith({
        [VERIFY_WRAPPER]: {
          code: '40004',
          msg: 'Business Failed',
          sub_code: 'ACQ.TRADE_NOT_EXIST',
          sub_msg: 'trade_no 不存在',
        },
      });
      const result = await alipayOpenApiCall(VERIFY_METHOD, {}, config);
      expect(result.code).toBe('40004');
      expect(result.sub_code).toBe('ACQ.TRADE_NOT_EXIST');
      expect(result.sub_msg).toBe('trade_no 不存在');
    });

    it('throws on non-2xx HTTP status', async () => {
      stubFetchWith({ error: 'gateway down' }, 503);
      await expect(alipayOpenApiCall(VERIFY_METHOD, {}, config))
        .rejects.toThrow(/HTTP 503/);
    });

    it('throws when the response wrapper key is missing', async () => {
      stubFetchWith({ wrong_wrapper: { code: '10000' } });
      await expect(alipayOpenApiCall(VERIFY_METHOD, {}, config))
        .rejects.toThrow(new RegExp(VERIFY_WRAPPER));
    });

    it('handles the fulfillment.confirm method wrapper correctly', async () => {
      const fulfillMethod = 'alipay.aipay.agent.fulfillment.confirm';
      const fulfillWrapper = 'alipay_aipay_agent_fulfillment_confirm_response';
      stubFetchWith({ [fulfillWrapper]: { code: '10000' } });
      const result = await alipayOpenApiCall(fulfillMethod, { trade_no: '2024' }, config);
      expect(result.code).toBe('10000');
    });
  });
});
