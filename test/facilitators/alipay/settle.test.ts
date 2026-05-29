/**
 * Unit tests for AlipayFacilitator.settle + AlipayFacilitator.healthCheck
 * (src/facilitators/alipay.ts)
 *
 * settle:
 *  - calls alipay.aipay.agent.fulfillment.confirm with { trade_no }
 *  - code 10000 → { success: true, transaction: trade_no, status: 'fulfilled' }
 *  - business error → { success: false } with code/sub_code preserved
 *  - never throws (matches verify's safety contract)
 *
 * healthCheck:
 *  - parses both PEM keys via Node crypto
 *  - HEAD-probes the gateway URL with 5s timeout
 *  - returns { healthy, latencyMs, error }
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  AlipayFacilitator,
  AlipayFacilitatorConfig,
  ALIPAY_GATEWAY_PROD,
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

function buildProofHeader(trade_no = '20240528111111111111111111111111'): string {
  const proof = {
    protocol: {
      payment_proof: '7cf8a6a93c92ab1e9d2f',
      trade_no,
    },
    method: {
      client_session: 'ImNsaWVudFNlc3Npb25JZCI=',
    },
  };
  return Buffer.from(JSON.stringify(proof), 'utf-8').toString('base64url');
}

const FULFILL_WRAPPER = 'alipay_aipay_agent_fulfillment_confirm_response';

const DUMMY_REQUIREMENTS: X402PaymentRequirements = {
  scheme: 'alipay-aipay',
  network: 'alipay',
  asset: 'CNY',
  amount: '1.00',
  payTo: '2088641494699428',
  maxTimeoutSeconds: 1800,
};

describe('AlipayFacilitator settle + healthCheck', () => {
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

  function stubFetch(handler: (input: unknown, init?: RequestInit) => Response | Promise<Response>) {
    const mock = vi.fn(async (input: unknown, init?: RequestInit) => handler(input, init));
    vi.stubGlobal('fetch', mock);
    return mock;
  }

  function stubFetchWithJson(responseJson: unknown, status = 200) {
    return stubFetch(async () =>
      new Response(JSON.stringify(responseJson), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  function buildPayload(payload: unknown): X402PaymentPayload {
    return { x402Version: 1, payload };
  }

  describe('settle', () => {
    it('returns success on Alipay code 10000 with trade_no as transaction', async () => {
      const trade_no = '20240528222222222222222222222222';
      stubFetchWithJson({ [FULFILL_WRAPPER]: { code: '10000' } });
      const result = await facilitator.settle(buildPayload(buildProofHeader(trade_no)), DUMMY_REQUIREMENTS);
      expect(result.success).toBe(true);
      expect(result.transaction).toBe(trade_no);
      expect(result.status).toBe('fulfilled');
    });

    it('calls alipay.aipay.agent.fulfillment.confirm with biz_content = { trade_no }', async () => {
      const trade_no = '20240528333333333333333333333333';
      const mock = stubFetchWithJson({ [FULFILL_WRAPPER]: { code: '10000' } });
      await facilitator.settle(buildPayload(buildProofHeader(trade_no)), DUMMY_REQUIREMENTS);

      const init = mock.mock.calls[0][1] as RequestInit;
      const body = new URLSearchParams(String(init.body));
      expect(body.get('method')).toBe('alipay.aipay.agent.fulfillment.confirm');
      expect(JSON.parse(body.get('biz_content')!)).toEqual({ trade_no });
    });

    it('returns success: false on Alipay business error with code preserved', async () => {
      const trade_no = '20240528444444444444444444444444';
      stubFetchWithJson({
        [FULFILL_WRAPPER]: {
          code: '40004',
          msg: 'Business Failed',
          sub_code: 'ACQ.TRADE_STATUS_ERROR',
          sub_msg: 'trade already fulfilled',
        },
      });
      const result = await facilitator.settle(buildPayload(buildProofHeader(trade_no)), DUMMY_REQUIREMENTS);
      expect(result.success).toBe(false);
      expect(result.transaction).toBe(trade_no);
      expect(result.error).toContain('40004');
      expect(result.error).toContain('trade already fulfilled');
      expect(result.status).toBe('fulfillment_failed');
    });

    it('returns success: false on HTTP error (does not throw)', async () => {
      stubFetchWithJson({ error: 'gateway down' }, 503);
      const result = await facilitator.settle(
        buildPayload(buildProofHeader()),
        DUMMY_REQUIREMENTS,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/HTTP 503/);
    });

    it('returns success: false on malformed proof (no throw, no fetch)', async () => {
      const mock = stubFetchWithJson({});
      const result = await facilitator.settle(buildPayload(null), DUMMY_REQUIREMENTS);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(mock).not.toHaveBeenCalled();
    });

    it('accepts proof as { paymentProof: string } payload shape', async () => {
      stubFetchWithJson({ [FULFILL_WRAPPER]: { code: '10000' } });
      const result = await facilitator.settle(
        buildPayload({ paymentProof: buildProofHeader('20240528555555555555555555555555') }),
        DUMMY_REQUIREMENTS,
      );
      expect(result.success).toBe(true);
    });
  });

  describe('healthCheck', () => {
    it('returns healthy when keys parse + gateway responds', async () => {
      stubFetch(async () => new Response(null, { status: 200 }));
      const result = await facilitator.healthCheck();
      expect(result.healthy).toBe(true);
      expect(typeof result.latencyMs).toBe('number');
      expect(result.latencyMs!).toBeGreaterThanOrEqual(0);
    });

    it('uses HEAD method against the configured gateway URL', async () => {
      const mock = stubFetch(async () => new Response(null, { status: 200 }));
      await facilitator.healthCheck();
      const [url, init] = mock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(config.gateway_url);
      expect(init.method).toBe('HEAD');
    });

    it('falls back to ALIPAY_GATEWAY_PROD when gateway_url is not configured', async () => {
      const cfg = { ...config };
      delete cfg.gateway_url;
      const f = new AlipayFacilitator(cfg);
      const mock = stubFetch(async () => new Response(null, { status: 200 }));
      await f.healthCheck();
      // Constructor defaults gateway_url to ALIPAY_GATEWAY_PROD
      expect(mock.mock.calls[0][0]).toBe(ALIPAY_GATEWAY_PROD);
    });

    it('returns unhealthy on bad private key (no network call)', async () => {
      const bad = new AlipayFacilitator({ ...config, private_key_pem: 'not-a-pem' });
      const mock = stubFetch(async () => new Response(null, { status: 200 }));
      const result = await bad.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toMatch(/private_key_pem parse failed/);
      expect(mock).not.toHaveBeenCalled();
    });

    it('returns unhealthy on bad alipay public key (no network call)', async () => {
      const bad = new AlipayFacilitator({ ...config, alipay_public_key_pem: 'not-a-pem' });
      const mock = stubFetch(async () => new Response(null, { status: 200 }));
      const result = await bad.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toMatch(/alipay_public_key_pem parse failed/);
      expect(mock).not.toHaveBeenCalled();
    });

    it('returns unhealthy when the gateway is unreachable', async () => {
      stubFetch(async () => { throw new Error('connect ECONNREFUSED'); });
      const result = await facilitator.healthCheck();
      expect(result.healthy).toBe(false);
      expect(result.error).toMatch(/unreachable/);
      expect(typeof result.latencyMs).toBe('number');
    });
  });
});
