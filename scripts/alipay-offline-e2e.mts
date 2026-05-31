/**
 * Offline E2E for the Alipay rail — NO network, NO real money.
 *
 * Exercises the real key-load path (bare Base64 -> toPem) with the actual
 * sr007 merchant private key, builds a signed 402 challenge, then verifies
 * the seller_signature via rsa2Verify against the public key DERIVED from
 * that private key. Proves the server->facilitator->signed-challenge path is
 * cryptographically valid end-to-end without touching the Alipay gateway.
 *
 * Run: node_modules/.bin/tsx scripts/alipay-offline-e2e.mts
 */
import { readFileSync } from 'fs';
import crypto from 'node:crypto';
import { AlipayFacilitator, ALIPAY_SIGNING_FIELDS } from '../src/facilitators/alipay.js';
import { toPem, decodeBase64UrlWithPadFix } from '../src/facilitators/alipay/encoding.js';
import { rsa2Verify } from '../src/facilitators/alipay/rsa2.js';

const certDir = new URL('../cert/', import.meta.url);
const private_key_pem = toPem(readFileSync(new URL('ALIPAY_PRIVATE_KEY.txt', certDir), 'utf-8'), 'PRIVATE');
const alipay_public_key_pem = toPem(readFileSync(new URL('ALIPAY_PUBLIC_KEY.txt', certDir), 'utf-8'), 'PUBLIC');

crypto.createPrivateKey(private_key_pem);
crypto.createPublicKey(alipay_public_key_pem);
console.log('[1] keys loaded + parsed (bare base64 -> PEM): OK');

const fac = new AlipayFacilitator({
  seller_id: '2088641494699428',
  app_id: '2021006150642142',
  seller_name: '上海超响应数字科技有限公司',
  service_id_default: 'API_0EA6DC4FC99A4DF7',
  private_key_pem,
  alipay_public_key_pem,
  gateway_url: 'https://openapi.alipaydev.com/gateway.do',
  sign_type: 'RSA2',
});

const PRICE = '1.00';
const GOODS = '产品演示视频 - 系列一';
const RESOURCE = '/execute?service=video-demo';
const SERVICE = 'API_0EA6DC4FC99A4DF7';

const req = await fac.createPaymentRequirements({
  serviceId: SERVICE,
  priceCny: PRICE,
  goodsName: GOODS,
  resourceId: RESOURCE,
});
console.log('[2] createPaymentRequirements: OK  (scheme=' + req.x402Accepts.scheme + ', amount=' + req.x402Accepts.amount + ' ' + req.x402Accepts.asset + ')');

const challenge = JSON.parse(decodeBase64UrlWithPadFix(req.paymentNeededHeader));
const p = challenge.protocol;
const signed: Record<string, string> = {
  amount: PRICE,
  currency: 'CNY',
  goods_name: GOODS,
  out_trade_no: p.out_trade_no,
  pay_before: p.pay_before,
  resource_id: RESOURCE,
  seller_id: '2088641494699428',
  service_id: SERVICE,
};
const signingString = ALIPAY_SIGNING_FIELDS.map((k) => `${k}=${signed[k]}`).join('&');
const derivedPubPem = crypto
  .createPublicKey(crypto.createPrivateKey(private_key_pem))
  .export({ type: 'spki', format: 'pem' }) as string;
const ok = rsa2Verify(signingString, p.seller_signature, derivedPubPem);
console.log('[3] seller_signature verifies (rsa2Verify, derived pubkey):', ok ? 'OK' : 'FAIL');

const validAmount = /^\d+(\.\d{1,2})?$/.test(p.amount);
console.log('[4] amount regex + pay_before:', validAmount ? 'OK' : 'FAIL', '| pay_before=' + p.pay_before);

if (!ok || !validAmount) {
  console.log('\nOFFLINE E2E FAILED');
  process.exit(1);
}
console.log('\nOFFLINE E2E PASSED — signed 402 challenge is cryptographically valid with real sr007 keys.');
