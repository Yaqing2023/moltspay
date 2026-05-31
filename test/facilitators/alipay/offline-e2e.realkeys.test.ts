/**
 * Offline E2E with the REAL sr007 merchant keys — NO network, NO real money.
 *
 * Skips automatically when cert/ALIPAY_PRIVATE_KEY.txt is absent (CI / other
 * machines), so it never breaks the normal suite. When the keys ARE present
 * it exercises the real load path: bare Base64 -> toPem -> AlipayFacilitator
 * -> signed 402 challenge -> rsa2Verify against the public key DERIVED from
 * the merchant private key. This is the offline half of the sandbox E2E that
 * the (missing) tsx script would have run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'node:crypto';
import { AlipayFacilitator, ALIPAY_SIGNING_FIELDS } from '../../../src/facilitators/alipay.js';
import { toPem, decodeBase64UrlWithPadFix } from '../../../src/facilitators/alipay/encoding.js';
import { rsa2Verify } from '../../../src/facilitators/alipay/rsa2.js';

const certDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../cert');
const privPath = path.join(certDir, 'ALIPAY_PRIVATE_KEY.txt');
const pubPath = path.join(certDir, 'ALIPAY_PUBLIC_KEY.txt');
const haveKeys = existsSync(privPath) && existsSync(pubPath);

describe.skipIf(!haveKeys)('alipay offline E2E (real sr007 keys)', () => {
  const PRICE = '1.00';
  const GOODS = '产品演示视频 - 系列一';
  const RESOURCE = '/execute?service=video-demo';
  const SERVICE = 'API_0EA6DC4FC99A4DF7';
  const SELLER = '2088641494699428';

  const private_key_pem = toPem(readFileSync(privPath, 'utf-8'), 'PRIVATE');
  const alipay_public_key_pem = toPem(readFileSync(pubPath, 'utf-8'), 'PUBLIC');

  it('bare-base64 keys load + parse as PEM', () => {
    expect(() => crypto.createPrivateKey(private_key_pem)).not.toThrow();
    expect(() => crypto.createPublicKey(alipay_public_key_pem)).not.toThrow();
  });

  it('createPaymentRequirements emits a signed 402 whose signature verifies', async () => {
    const fac = new AlipayFacilitator({
      seller_id: SELLER,
      app_id: '2021006150642142',
      seller_name: '上海超响应数字科技有限公司',
      service_id_default: SERVICE,
      private_key_pem,
      alipay_public_key_pem,
      gateway_url: 'https://openapi.alipaydev.com/gateway.do',
      sign_type: 'RSA2',
    });

    const req = await fac.createPaymentRequirements({
      serviceId: SERVICE,
      priceCny: PRICE,
      goodsName: GOODS,
      resourceId: RESOURCE,
    });

    expect(req.x402Accepts.scheme).toBe('alipay-aipay');
    expect(req.x402Accepts.amount).toBe(PRICE);
    expect(req.x402Accepts.asset).toBe('CNY');

    const challenge = JSON.parse(decodeBase64UrlWithPadFix(req.paymentNeededHeader));
    const p = challenge.protocol;
    expect(p.seller_signature).toBeTruthy();
    expect(p.out_trade_no).toBeTruthy();

    const signed: Record<string, string> = {
      amount: PRICE,
      currency: 'CNY',
      goods_name: GOODS,
      out_trade_no: p.out_trade_no,
      pay_before: p.pay_before,
      resource_id: RESOURCE,
      seller_id: SELLER,
      service_id: SERVICE,
    };
    const signingString = ALIPAY_SIGNING_FIELDS.map((k) => `${k}=${signed[k]}`).join('&');
    const derivedPubPem = crypto
      .createPublicKey(crypto.createPrivateKey(private_key_pem))
      .export({ type: 'spki', format: 'pem' }) as string;

    expect(rsa2Verify(signingString, p.seller_signature, derivedPubPem)).toBe(true);
  });
});
