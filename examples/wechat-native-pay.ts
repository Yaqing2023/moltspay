#!/usr/bin/env npx ts-node
/**
 * Scenario A demo: agent issues a WeChat Native code, payer not pre-bound.
 *
 * Flow:
 *   1. Agent places a Native order -> code_url (payer-agnostic, no openid)
 *   2. Render the code_url as a QR in the terminal -> whoever scans pays
 *   3. Poll verify() every 3s until trade_state === SUCCESS (or timeout)
 *   4. settle() to confirm and obtain the transaction_id
 *
 * It is one-code-one-payment: the first scanner who pays settles this order;
 * to collect again, issue a new code. All funds go to the one configured mchid.
 *
 * Usage:
 *   # Mock mode (default): no real WeChat call, simulates NOTPAY -> SUCCESS.
 *   npx ts-node examples/wechat-native-pay.ts
 *
 *   # Real mode: hits the live WeChat v3 gateway with your merchant creds.
 *   WECHAT_REAL=1 \
 *   WECHAT_MCHID=... WECHAT_APPID=... WECHAT_SERIAL=... \
 *   WECHAT_PRIVATE_KEY_PATH=./cert/wechat_apiclient_key.pem \
 *   WECHAT_APIV3_KEY=... WECHAT_NOTIFY_URL=https://your.host/wechat/notify \
 *   npx ts-node examples/wechat-native-pay.ts
 */

import { readFileSync } from 'fs';
import qrcode from 'qrcode-terminal';
import {
  WechatFacilitator,
  WechatFacilitatorConfig,
} from '../src/facilitators/wechat.js';
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  VerifyResult,
} from '../src/facilitators/interface.js';

const PRICE_CNY = process.env.WECHAT_PRICE_CNY || '10.00';
const DESCRIPTION = process.env.WECHAT_DESC || 'a cup of coffee';
const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Poll the order until paid, closed, or timed out. Mirrors the alipay-bot
 * polling model: one verify() query per tick.
 */
async function pollUntilPaid(
  facilitator: WechatFacilitator,
  outTradeNo: string,
  requirement: X402PaymentRequirements,
): Promise<VerifyResult> {
  const deadline = Date.now() + TIMEOUT_MS;
  const payload = { payload: { out_trade_no: outTradeNo } } as X402PaymentPayload;

  while (Date.now() < deadline) {
    const result = await facilitator.verify(payload, requirement);
    if (result.valid) return result;

    const state = (result.details?.trade_state as string) ?? 'NOTPAY';
    if (state === 'CLOSED' || state === 'PAYERROR' || state === 'REVOKED') {
      return result; // terminal failure
    }
    process.stdout.write(`  waiting... (trade_state=${state})\n`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { valid: false, error: `timed out after ${TIMEOUT_MS / 1000}s` };
}

/**
 * Build a facilitator. In mock mode we stub `fetch` so the demo runs offline
 * and deterministically (NOTPAY on the first poll, SUCCESS thereafter).
 */
function makeFacilitator(): WechatFacilitator {
  const real = process.env.WECHAT_REAL === '1';

  if (!real) {
    let polls = 0;
    (globalThis as any).fetch = async (url: string, init: any) => {
      const body =
        typeof init?.body === 'string' && url.includes('/native')
          ? { code_url: 'weixin://wxpay/bizpayurl?pr=DEMO0MOCK' }
          : (() => {
              polls += 1;
              return polls < 2
                ? { trade_state: 'NOTPAY' }
                : { trade_state: 'SUCCESS', transaction_id: '4200MOCK0001', amount: { total: 1000 } };
            })();
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(body),
      } as any;
    };

    const dummyKey = (require('crypto') as typeof import('crypto'))
      .generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      }).privateKey;

    return new WechatFacilitator({
      mchid: '1900000001',
      appid: 'wx8888888888888888',
      serial_no: 'MOCKSERIAL',
      private_key_pem: dummyKey,
      notify_url: 'https://example.com/wechat/notify',
    });
  }

  const cfg: WechatFacilitatorConfig = {
    mchid: requireEnv('WECHAT_MCHID'),
    appid: requireEnv('WECHAT_APPID'),
    serial_no: requireEnv('WECHAT_SERIAL'),
    private_key_pem: readFileSync(requireEnv('WECHAT_PRIVATE_KEY_PATH'), 'utf-8'),
    apiv3_key: process.env.WECHAT_APIV3_KEY,
    notify_url: requireEnv('WECHAT_NOTIFY_URL'),
  };
  return new WechatFacilitator(cfg);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (real mode requires it)`);
  return v;
}

async function main(): Promise<void> {
  const facilitator = makeFacilitator();
  console.log(`\nWeChat Native pay — scenario A (${process.env.WECHAT_REAL === '1' ? 'REAL' : 'MOCK'})`);

  // 1) Issue a payer-agnostic code
  const { x402Accepts, codeUrl, outTradeNo } = await facilitator.createPaymentRequirements({
    priceCny: PRICE_CNY,
    description: DESCRIPTION,
  });
  console.log(`\nout_trade_no: ${outTradeNo}`);
  console.log(`amount:       CNY ${PRICE_CNY}`);
  console.log(`code_url:     ${codeUrl}\n`);

  // 2) Render the QR — whoever scans pays
  qrcode.generate(codeUrl, { small: true });
  console.log('\nScan the QR with any WeChat account to pay. Polling...\n');

  // 3) Poll until paid
  const result = await pollUntilPaid(facilitator, outTradeNo, x402Accepts);
  if (!result.valid) {
    console.error(`\n✗ not paid: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  // 4) Confirm settlement
  const settled = await facilitator.settle(
    { payload: { out_trade_no: outTradeNo } } as X402PaymentPayload,
    x402Accepts,
  );
  console.log(`\n✓ paid — transaction_id: ${result.details?.transaction_id}`);
  console.log(`  settle: ${settled.success ? 'confirmed' : 'failed: ' + settled.error}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
