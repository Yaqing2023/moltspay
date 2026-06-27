/**
 * Unit tests for src/facilitators/wechat.ts (WechatFacilitator).
 *
 * Covers:
 * - cnyToFen / generateOutTradeNo / extractOutTradeNo helpers
 * - createPaymentRequirements: yuan->fen, Native request shape, code_url passthrough
 * - verify: SUCCESS → valid; NOTPAY → invalid; gateway error → never throws
 * - settle: SUCCESS → transaction_id; non-SUCCESS → failure
 *
 * `fetch` is mocked; no real WeChat gateway is contacted. Response signature
 * verification is exercised separately in sign.test.ts, so configs here omit
 * platform_public_key_pem (verification skipped).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  WechatFacilitator,
  WechatFacilitatorConfig,
  WECHAT_SCHEME,
  WECHAT_NETWORK,
  cnyToFen,
  generateOutTradeNo,
  extractOutTradeNo,
} from '../../../src/facilitators/wechat.js';
import { X402PaymentPayload, X402PaymentRequirements } from '../../../src/facilitators/interface.js';

function merchantKey(): string {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

let CONFIG: WechatFacilitatorConfig;

function makeFacilitator(): WechatFacilitator {
  return new WechatFacilitator(CONFIG);
}

/** Mock the next fetch with a JSON body + status. */
function mockFetchOnce(status: number, json: unknown): void {
  (globalThis.fetch as any).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(json),
  });
}

const REQ: X402PaymentRequirements = {
  scheme: WECHAT_SCHEME,
  network: WECHAT_NETWORK,
  asset: 'CNY',
  amount: '10.00',
  payTo: '1900000001',
  maxTimeoutSeconds: 300,
  extra: { out_trade_no: 'WXorderfromreq' },
};

describe('WechatFacilitator', () => {
  beforeAll(() => {
    CONFIG = {
      mchid: '1900000001',
      appid: 'wx8888888888888888',
      serial_no: 'ABCDEF0123456789',
      private_key_pem: merchantKey(),
      notify_url: 'https://example.com/wechat/notify',
    };
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('cnyToFen', () => {
    it('converts yuan strings to fen integers without float drift', () => {
      expect(cnyToFen('10.00')).toBe(1000);
      expect(cnyToFen('0.10')).toBe(10);
      expect(cnyToFen('0.01')).toBe(1);
      expect(cnyToFen('1')).toBe(100);
      expect(cnyToFen('123.45')).toBe(12345);
    });
  });

  describe('generateOutTradeNo', () => {
    it('is WX + 30 hex, 32 chars, unique', () => {
      const a = generateOutTradeNo();
      expect(a).toMatch(/^WX[0-9a-f]{30}$/);
      expect(a).not.toBe(generateOutTradeNo());
    });
  });

  describe('extractOutTradeNo', () => {
    it('reads a bare string payload', () => {
      expect(extractOutTradeNo({ payload: 'WX123' } as X402PaymentPayload)).toBe('WX123');
    });
    it('reads {out_trade_no} / {outTradeNo}', () => {
      expect(extractOutTradeNo({ payload: { out_trade_no: 'WXa' } } as any)).toBe('WXa');
      expect(extractOutTradeNo({ payload: { outTradeNo: 'WXb' } } as any)).toBe('WXb');
    });
    it('falls back to requirements.extra.out_trade_no', () => {
      expect(extractOutTradeNo({ payload: null } as any, REQ)).toBe('WXorderfromreq');
    });
    it('throws when nothing carries it', () => {
      expect(() => extractOutTradeNo({ payload: null } as any)).toThrow(/out_trade_no/);
    });
  });

  describe('createPaymentRequirements', () => {
    it('places a Native order and returns code_url + x402 accepts', async () => {
      mockFetchOnce(200, { code_url: 'weixin://wxpay/bizpayurl?pr=ABC123' });
      const f = makeFacilitator();
      const out = await f.createPaymentRequirements({ priceCny: '10.00', description: 'a cup of coffee' });

      expect(out.codeUrl).toBe('weixin://wxpay/bizpayurl?pr=ABC123');
      expect(out.outTradeNo).toMatch(/^WX[0-9a-f]{30}$/);
      expect(out.x402Accepts.scheme).toBe(WECHAT_SCHEME);
      expect(out.x402Accepts.asset).toBe('CNY');
      expect(out.x402Accepts.amount).toBe('10.00');
      expect(out.x402Accepts.payTo).toBe('1900000001');
      expect(out.x402Accepts.extra?.code_url).toBe('weixin://wxpay/bizpayurl?pr=ABC123');
      expect(out.x402Accepts.extra?.out_trade_no).toBe(out.outTradeNo);
    });

    it('sends amount.total in fen and the mandated fields', async () => {
      mockFetchOnce(200, { code_url: 'weixin://x' });
      const f = makeFacilitator();
      await f.createPaymentRequirements({ priceCny: '0.10', description: 'd', outTradeNo: 'WXfixed01' });

      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toBe('https://api.mch.weixin.qq.com/v3/pay/transactions/native');
      expect(init.method).toBe('POST');
      const sent = JSON.parse(init.body);
      expect(sent.amount).toEqual({ total: 10, currency: 'CNY' });
      expect(sent.mchid).toBe('1900000001');
      expect(sent.appid).toBe('wx8888888888888888');
      expect(sent.out_trade_no).toBe('WXfixed01');
      expect(sent.notify_url).toBe('https://example.com/wechat/notify');
      expect(typeof sent.time_expire).toBe('string');
      expect(init.headers.Authorization).toMatch(/^WECHATPAY2-SHA256-RSA2048 /);
    });

    it('rejects a malformed price', async () => {
      const f = makeFacilitator();
      await expect(f.createPaymentRequirements({ priceCny: '10.000', description: 'd' })).rejects.toThrow(/yuan/);
    });

    it('rejects an amount below 1 fen', async () => {
      const f = makeFacilitator();
      await expect(f.createPaymentRequirements({ priceCny: '0', description: 'd' })).rejects.toThrow(/minimum/);
    });

    it('throws when the gateway returns no code_url', async () => {
      mockFetchOnce(200, { something_else: true });
      const f = makeFacilitator();
      await expect(f.createPaymentRequirements({ priceCny: '1.00', description: 'd' })).rejects.toThrow(/code_url/);
    });
  });

  describe('verify', () => {
    it('SUCCESS → valid with transaction_id', async () => {
      mockFetchOnce(200, {
        trade_state: 'SUCCESS',
        transaction_id: '4200001234202606270000000001',
        out_trade_no: 'WXorderfromreq',
        amount: { total: 1000, payer_total: 1000, currency: 'CNY' },
      });
      const f = makeFacilitator();
      const r = await f.verify({ payload: 'WXorderfromreq' } as X402PaymentPayload, REQ);
      expect(r.valid).toBe(true);
      expect(r.details?.transaction_id).toBe('4200001234202606270000000001');
      expect(r.details?.trade_state).toBe('SUCCESS');
    });

    it('signs the order-query path including the mchid query string', async () => {
      mockFetchOnce(200, { trade_state: 'SUCCESS', transaction_id: 'T1' });
      const f = makeFacilitator();
      await f.verify({ payload: 'WXabc' } as X402PaymentPayload, REQ);
      const [url, init] = (globalThis.fetch as any).mock.calls[0];
      expect(url).toBe(
        'https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/WXabc?mchid=1900000001',
      );
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
    });

    it('NOTPAY → invalid (not yet paid), never throws', async () => {
      mockFetchOnce(200, { trade_state: 'NOTPAY' });
      const f = makeFacilitator();
      const r = await f.verify({ payload: 'WXabc' } as X402PaymentPayload, REQ);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/NOTPAY/);
    });

    it('gateway error → invalid, never throws', async () => {
      mockFetchOnce(404, { code: 'ORDERNOTEXIST', message: 'order not found' });
      const f = makeFacilitator();
      const r = await f.verify({ payload: 'WXmissing' } as X402PaymentPayload, REQ);
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/ORDERNOTEXIST/);
    });

    it('missing out_trade_no → invalid, never throws', async () => {
      const f = makeFacilitator();
      const r = await f.verify({ payload: null } as any, { ...REQ, extra: {} });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/out_trade_no/);
    });
  });

  describe('settle', () => {
    it('SUCCESS → success with transaction_id', async () => {
      mockFetchOnce(200, { trade_state: 'SUCCESS', transaction_id: 'T9' });
      const f = makeFacilitator();
      const r = await f.settle({ payload: 'WXabc' } as X402PaymentPayload, REQ);
      expect(r.success).toBe(true);
      expect(r.transaction).toBe('T9');
      expect(r.status).toBe('fulfilled');
    });

    it('non-SUCCESS → failure, returns trade_state', async () => {
      mockFetchOnce(200, { trade_state: 'CLOSED' });
      const f = makeFacilitator();
      const r = await f.settle({ payload: 'WXabc' } as X402PaymentPayload, REQ);
      expect(r.success).toBe(false);
      expect(r.status).toBe('CLOSED');
    });
  });

  describe('healthCheck', () => {
    it('passes with a valid key and reachable gateway', async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 200 });
      const f = makeFacilitator();
      const h = await f.healthCheck();
      expect(h.healthy).toBe(true);
      expect(typeof h.latencyMs).toBe('number');
    });

    it('fails on a bad apiv3_key length', async () => {
      const f = new WechatFacilitator({ ...CONFIG, apiv3_key: 'too-short' });
      const h = await f.healthCheck();
      expect(h.healthy).toBe(false);
      expect(h.error).toMatch(/apiv3_key/);
    });
  });
});
