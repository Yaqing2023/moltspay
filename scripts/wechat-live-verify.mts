#!/usr/bin/env tsx
/**
 * Live verify + settle for a WeChat Native order placed by wechat-live-order.mts.
 * Polls the real v3 order-query gateway until trade_state===SUCCESS, then settle().
 *
 * Env: same WECHAT_* as wechat-live-order.mts, plus WECHAT_OUT_TRADE_NO.
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { WechatFacilitator, WechatFacilitatorConfig } from '../src/facilitators/wechat.js';
import type { X402PaymentPayload, X402PaymentRequirements } from '../src/facilitators/interface.js';

// See wechat-live-order.mts: pin DNS to IPv4 (IPv6 egress is a black hole here).
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
  const outTradeNo = reqEnv('WECHAT_OUT_TRADE_NO');
  const fac = new WechatFacilitator(cfg);

  const payload = { payload: { out_trade_no: outTradeNo } } as X402PaymentPayload;
  // verify()/settle() only key off out_trade_no for an order query; a minimal requirement is enough.
  const requirement = { scheme: 'wechatpay-native', extra: { out_trade_no: outTradeNo } } as unknown as X402PaymentRequirements;

  console.log(`WeChat Native — LIVE verify+settle\n  out_trade_no: ${outTradeNo}\n`);

  const deadline = Date.now() + 120_000;
  let verified = null as any;
  while (Date.now() < deadline) {
    const r = await fac.verify(payload, requirement);
    const state = (r.details?.trade_state as string) ?? '(none)';
    console.log(`  verify → valid=${r.valid} trade_state=${state}`);
    if (r.valid) { verified = r; break; }
    if (['CLOSED', 'PAYERROR', 'REVOKED'].includes(state)) {
      throw new Error(`terminal state ${state} — not paid`);
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  if (!verified) throw new Error('timed out waiting for SUCCESS');

  console.log(`\n✓ VERIFIED — transaction_id: ${verified.details?.transaction_id}`);
  console.log(`  payer total: ${verified.details?.amount?.total ?? verified.details?.amount} fen`);

  const settled = await fac.settle(payload, requirement);
  console.log(`\n✓ SETTLE — success=${settled.success} txid=${settled.transaction ?? 'n/a'} status=${settled.status ?? ''}`);
  if (!settled.success) throw new Error(`settle failed: ${settled.error}`);
  console.log('\nLIVE_E2E_OK — order → pay → verify(SUCCESS) → settle all green on production.');
}

main().catch((e) => {
  console.error('\n✗ FAILED:', e?.message ?? e);
  process.exitCode = 1;
});
