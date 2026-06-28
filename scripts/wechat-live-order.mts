#!/usr/bin/env tsx
/**
 * Live integration probe for the WeChat Pay Native rail (2.1.0).
 *
 * Hits the REAL WeChat v3 gateway with production merchant creds and places a
 * Native order. It validates the riskiest parts end-to-end — APIv3 auth-token
 * signing, cert serial, mchid/appid acceptance — WITHOUT anyone paying: a
 * Native order only moves money once a human scans the returned code_url.
 *
 * It does NOT poll and does NOT render a QR. If code_url comes back, the
 * production credentials + signing are proven good.
 *
 * Env (read from process.env; map your production names before running):
 *   WECHAT_MCHID, WECHAT_APPID, WECHAT_SERIAL,
 *   WECHAT_PRIVATE_KEY_PATH, WECHAT_NOTIFY_URL, [WECHAT_APIV3_KEY]
 *   WECHAT_PRICE_CNY (default 0.01), WECHAT_DESC
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { WechatFacilitator, WechatFacilitatorConfig } from '../src/facilitators/wechat.js';

// This host's IPv6 egress is a black hole and api.mch.weixin.qq.com resolves
// AAAA-first; undici has no Happy-Eyeballs fallback, so global fetch hangs
// (ETIMEDOUT) on IPv6. Patch the real (CJS) dns module — the one undici uses —
// to pin lookups to IPv4 (1.13.x reachable). Must use createRequire: the ESM
// `import dns` default is a synthetic object whose mutations undici won't see.
const dns = createRequire(import.meta.url)('dns');
const realLookup = dns.lookup.bind(dns);
dns.lookup = (host: any, opts: any, cb: any) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  return realLookup(host, { ...opts, family: 4 }, cb);
};

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function main(): Promise<void> {
  const cfg: WechatFacilitatorConfig = {
    mchid: reqEnv('WECHAT_MCHID'),
    appid: reqEnv('WECHAT_APPID'),
    serial_no: reqEnv('WECHAT_SERIAL'),
    private_key_pem: readFileSync(reqEnv('WECHAT_PRIVATE_KEY_PATH'), 'utf-8'),
    apiv3_key: process.env.WECHAT_APIV3_KEY,
    notify_url: reqEnv('WECHAT_NOTIFY_URL'),
  };
  const price = process.env.WECHAT_PRICE_CNY || '0.01';
  const desc = process.env.WECHAT_DESC || 'moltspay live integration probe';

  console.log('WeChat Native — LIVE order-create probe');
  console.log(`  mchid:  ${cfg.mchid}`);
  console.log(`  appid:  ${cfg.appid}`);
  console.log(`  serial: ${cfg.serial_no}`);
  console.log(`  amount: CNY ${price}`);
  console.log(`  gateway: ${(WechatFacilitator as any).WECHAT_API_BASE ?? 'default v3'}\n`);

  const fac = new WechatFacilitator(cfg);

  const t0 = Date.now();
  const { codeUrl, outTradeNo, x402Accepts } = await fac.createPaymentRequirements({
    priceCny: price,
    description: desc,
  });
  const dt = Date.now() - t0;

  console.log(`✓ order accepted by WeChat gateway in ${dt}ms`);
  console.log(`  out_trade_no: ${outTradeNo}`);
  console.log(`  code_url:     ${codeUrl}`);
  console.log(`  scheme:       ${(x402Accepts as any)?.scheme ?? 'wechatpay-native'}`);
  if (!codeUrl || !codeUrl.startsWith('weixin://')) {
    throw new Error(`unexpected code_url: ${codeUrl}`);
  }
  console.log('\nPROBE_OK — signing + cert serial + mchid accepted (no money moved; order unscanned).');
}

main().catch((e) => {
  console.error('\n✗ PROBE_FAILED');
  console.error(e?.message ?? e);
  if (e?.response) console.error('response:', JSON.stringify(e.response));
  process.exitCode = 1;
});
