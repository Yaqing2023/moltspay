/**
 * Unit tests for AlipayFacilitator.createPaymentRequirements
 * (src/facilitators/alipay.ts)
 *
 * Covers all four ALIPAY-INTEGRATION-PLAN.md §1 unit-test items rooted
 * in challenge construction:
 *   - 8-field dictionary-ordered signing string
 *   - Challenge {protocol, method} nested JSON structure
 *   - pay_before ISO 8601, exactly +30 minutes
 *   - amount regex /^\d+(\.\d{1,2})?$/
 *
 * Plus: x402 accepts mirror, sign verifiability, randomness of
 * generated out_trade_no.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  AlipayFacilitator,
  AlipayFacilitatorConfig,
  ALIPAY_NETWORK,
  ALIPAY_SCHEME,
  ALIPAY_AMOUNT_REGEX,
  ALIPAY_PAY_BEFORE_MS,
  ALIPAY_SIGNING_FIELDS,
  generateOutTradeNo,
  formatPayBefore,
} from '../../../src/facilitators/alipay.js';
import { rsa2Verify } from '../../../src/facilitators/alipay/rsa2.js';
import { decodeBase64UrlWithPadFix } from '../../../src/facilitators/alipay/encoding.js';

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

const FIXED_NOW = new Date('2026-05-29T07:00:00.000Z');

describe('AlipayFacilitator.createPaymentRequirements', () => {
  let keys: KeyPair;
  let facilitator: AlipayFacilitator;
  let config: AlipayFacilitatorConfig;

  beforeAll(() => {
    keys = generateKeyPair();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    config = {
      seller_id: '2088641494699428',
      app_id: '2021006150642142',
      seller_name: '上海超响应数字科技有限公司',
      service_id_default: 'API_0EA6DC4FC99A4DF7',
      private_key_pem: keys.privateKey,
      alipay_public_key_pem: keys.publicKey,
    };
    facilitator = new AlipayFacilitator(config);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildOpts(overrides: Partial<{
    serviceId: string;
    priceCny: string;
    goodsName: string;
    resourceId: string;
    outTradeNo: string;
  }> = {}) {
    return {
      serviceId: 'API_0EA6DC4FC99A4DF7',
      priceCny: '1.00',
      goodsName: '产品演示视频 - 系列一',
      resourceId: '/video/v_001',
      outTradeNo: 'VIDtesttesttesttesttesttest012',
      ...overrides,
    };
  }

  describe('amount regex validation', () => {
    it.each([
      ['1', true],
      ['1.0', true],
      ['1.00', true],
      ['0', true],
      ['0.99', true],
      ['100', true],          // accepted by regex; "100元 vs 100分" ambiguity is documented
      ['1.5', true],
      ['1.50', true],
      ['', false],
      ['1.', false],
      ['1.000', false],       // 3 decimals
      ['-1', false],
      ['1.5.0', false],
      ['abc', false],
      ['100元', false],
      [' 1.00', false],       // leading space
    ])('ALIPAY_AMOUNT_REGEX.test(%j) === %j', (input, expected) => {
      expect(ALIPAY_AMOUNT_REGEX.test(input)).toBe(expected);
    });

    it('throws when priceCny does not match the regex', async () => {
      await expect(facilitator.createPaymentRequirements(buildOpts({ priceCny: '1.000' })))
        .rejects.toThrow(/priceCny "1\.000" does not match/);
    });

    it('throws on negative price', async () => {
      await expect(facilitator.createPaymentRequirements(buildOpts({ priceCny: '-1.00' })))
        .rejects.toThrow(/does not match/);
    });

    it('accepts integer-only price (e.g. "100" for 100 元)', async () => {
      const result = await facilitator.createPaymentRequirements(buildOpts({ priceCny: '100' }));
      expect(result.x402Accepts.amount).toBe('100');
    });
  });

  describe('signing string (8 fields, dictionary order)', () => {
    it('signs exactly the 8 fields in alphabetical order', async () => {
      const opts = buildOpts();
      const result = await facilitator.createPaymentRequirements(opts);

      const challenge = JSON.parse(decodeBase64UrlWithPadFix(result.paymentNeededHeader));
      const expectedSignedFields = {
        amount: opts.priceCny,
        currency: 'CNY',
        goods_name: opts.goodsName,
        out_trade_no: opts.outTradeNo,
        pay_before: challenge.protocol.pay_before,
        resource_id: opts.resourceId,
        seller_id: config.seller_id,
        service_id: opts.serviceId,
      };
      // Verify the 8 keys are exactly ALIPAY_SIGNING_FIELDS (no more, no less)
      expect(Object.keys(expectedSignedFields).sort()).toEqual([...ALIPAY_SIGNING_FIELDS]);

      // Reconstruct the dictionary-sorted signing string and verify the sig
      const signingString = ALIPAY_SIGNING_FIELDS
        .map((k) => `${k}=${expectedSignedFields[k as keyof typeof expectedSignedFields]}`)
        .join('&');

      expect(rsa2Verify(
        signingString,
        challenge.protocol.seller_signature,
        keys.publicKey,
      )).toBe(true);
    });

    it('sign breaks if any of the 8 fields is mutated', async () => {
      const result = await facilitator.createPaymentRequirements(buildOpts());
      const challenge = JSON.parse(decodeBase64UrlWithPadFix(result.paymentNeededHeader));
      const sig = challenge.protocol.seller_signature;

      // Mutate amount: signature must no longer verify
      const tamperedSigningString = [
        'amount=999.99',
        'currency=CNY',
        `goods_name=${challenge.method.goods_name}`,
        `out_trade_no=${challenge.protocol.out_trade_no}`,
        `pay_before=${challenge.protocol.pay_before}`,
        `resource_id=${challenge.protocol.resource_id}`,
        `seller_id=${config.seller_id}`,
        `service_id=${challenge.method.service_id}`,
      ].join('&');
      expect(rsa2Verify(tamperedSigningString, sig, keys.publicKey)).toBe(false);
    });
  });

  describe('challenge JSON {protocol, method} structure', () => {
    it('emits the exact protocol field set per protocol §3.2', async () => {
      const opts = buildOpts();
      const result = await facilitator.createPaymentRequirements(opts);
      const challenge = JSON.parse(decodeBase64UrlWithPadFix(result.paymentNeededHeader));

      expect(Object.keys(challenge).sort()).toEqual(['method', 'protocol']);

      expect(Object.keys(challenge.protocol).sort()).toEqual([
        'amount',
        'currency',
        'out_trade_no',
        'pay_before',
        'resource_id',
        'seller_sign_type',
        'seller_signature',
        'seller_unique_id',
      ]);

      expect(challenge.protocol.amount).toBe(opts.priceCny);
      expect(challenge.protocol.currency).toBe('CNY');
      expect(challenge.protocol.out_trade_no).toBe(opts.outTradeNo);
      expect(challenge.protocol.resource_id).toBe(opts.resourceId);
      expect(challenge.protocol.seller_sign_type).toBe('RSA2');
      expect(challenge.protocol.seller_unique_id).toBe(config.seller_id);
      expect(typeof challenge.protocol.seller_signature).toBe('string');
    });

    it('emits the exact method field set per protocol §3.2', async () => {
      const opts = buildOpts();
      const result = await facilitator.createPaymentRequirements(opts);
      const challenge = JSON.parse(decodeBase64UrlWithPadFix(result.paymentNeededHeader));

      expect(Object.keys(challenge.method).sort()).toEqual([
        'goods_name',
        'seller_app_id',
        'seller_id',
        'seller_name',
        'seller_unique_id_key',
        'service_id',
      ]);

      expect(challenge.method.seller_name).toBe(config.seller_name);
      expect(challenge.method.seller_id).toBe(config.seller_id);
      expect(challenge.method.seller_app_id).toBe(config.app_id);
      expect(challenge.method.goods_name).toBe(opts.goodsName);
      expect(challenge.method.seller_unique_id_key).toBe('seller_id');
      expect(challenge.method.service_id).toBe(opts.serviceId);
    });

    it('handles Chinese goods_name and resource_id without corruption', async () => {
      const opts = buildOpts({
        goodsName: '高清视频 - 春日樱花',
        resourceId: '/视频/v_001',
      });
      const result = await facilitator.createPaymentRequirements(opts);
      const challenge = JSON.parse(decodeBase64UrlWithPadFix(result.paymentNeededHeader));
      expect(challenge.method.goods_name).toBe('高清视频 - 春日樱花');
      expect(challenge.protocol.resource_id).toBe('/视频/v_001');
    });
  });

  describe('pay_before (ISO 8601, +30 minutes from now)', () => {
    it('emits ISO 8601 UTC stamp exactly +30 minutes from now', async () => {
      const result = await facilitator.createPaymentRequirements(buildOpts());
      const challenge = JSON.parse(decodeBase64UrlWithPadFix(result.paymentNeededHeader));

      const expected = new Date(FIXED_NOW.getTime() + 30 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      expect(challenge.protocol.pay_before).toBe(expected);
      expect(challenge.protocol.pay_before).toBe('2026-05-29T07:30:00Z');
    });

    it('strips fractional seconds for cleaner querystring signing', async () => {
      const result = await facilitator.createPaymentRequirements(buildOpts());
      const challenge = JSON.parse(decodeBase64UrlWithPadFix(result.paymentNeededHeader));
      expect(challenge.protocol.pay_before).not.toMatch(/\./);
      expect(challenge.protocol.pay_before).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('ALIPAY_PAY_BEFORE_MS is 30 minutes', () => {
      expect(ALIPAY_PAY_BEFORE_MS).toBe(30 * 60 * 1000);
    });
  });

  describe('formatPayBefore helper', () => {
    it('returns now + 30 minutes as ISO 8601 UTC (no ms)', () => {
      const out = formatPayBefore(new Date('2026-05-29T00:00:00.000Z'));
      expect(out).toBe('2026-05-29T00:30:00Z');
    });
  });

  describe('generateOutTradeNo helper', () => {
    it('starts with VID and is exactly 32 chars', () => {
      const id = generateOutTradeNo();
      expect(id).toMatch(/^VID/);
      expect(id.length).toBe(32);
    });

    it('uses base64url alphabet after VID', () => {
      const id = generateOutTradeNo();
      expect(id.slice(3)).toMatch(/^[A-Za-z0-9\-_]+$/);
    });

    it('produces distinct values across calls (statistical)', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateOutTradeNo()));
      expect(ids.size).toBe(100);
    });
  });

  describe('x402 accepts entry (mirror of Payment-Needed)', () => {
    it('emits the alipay scheme + network + CNY asset', async () => {
      const opts = buildOpts();
      const result = await facilitator.createPaymentRequirements(opts);
      expect(result.x402Accepts.scheme).toBe(ALIPAY_SCHEME);
      expect(result.x402Accepts.network).toBe(ALIPAY_NETWORK);
      expect(result.x402Accepts.asset).toBe('CNY');
      expect(result.x402Accepts.amount).toBe(opts.priceCny);
      expect(result.x402Accepts.payTo).toBe(config.seller_id);
      expect(result.x402Accepts.maxTimeoutSeconds).toBe(1800);
    });

    it('includes payment_needed_header in extra for x402-aware clients', async () => {
      const result = await facilitator.createPaymentRequirements(buildOpts());
      expect(result.x402Accepts.extra).toBeDefined();
      expect(result.x402Accepts.extra!.payment_needed_header).toBe(result.paymentNeededHeader);
    });
  });

  describe('out_trade_no behavior', () => {
    it('uses caller-supplied outTradeNo verbatim when provided', async () => {
      const custom = 'VIDmy-custom-trade-no-123456789';
      const result = await facilitator.createPaymentRequirements(buildOpts({ outTradeNo: custom }));
      const challenge = JSON.parse(decodeBase64UrlWithPadFix(result.paymentNeededHeader));
      expect(challenge.protocol.out_trade_no).toBe(custom);
      expect(result.x402Accepts.extra!.out_trade_no).toBe(custom);
    });

    it('auto-generates a 32-char VID-prefixed outTradeNo when not provided', async () => {
      vi.useRealTimers(); // randomness only — no timestamp determinism needed here
      const opts = buildOpts();
      delete (opts as Partial<typeof opts>).outTradeNo;
      const r1 = await facilitator.createPaymentRequirements(opts);
      const r2 = await facilitator.createPaymentRequirements(opts);
      const c1 = JSON.parse(decodeBase64UrlWithPadFix(r1.paymentNeededHeader));
      const c2 = JSON.parse(decodeBase64UrlWithPadFix(r2.paymentNeededHeader));
      expect(c1.protocol.out_trade_no).toMatch(/^VID/);
      expect(c1.protocol.out_trade_no.length).toBe(32);
      expect(c1.protocol.out_trade_no).not.toBe(c2.protocol.out_trade_no);
    });
  });
});
