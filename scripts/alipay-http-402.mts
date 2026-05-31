/**
 * Live HTTP proof for the Alipay 402 dual-emit path — NO real money.
 *
 * Boots a real MoltsPayServer with the sr007 keys, hits /execute with NO
 * payment header, and asserts the 402 carries BOTH the x402
 * `X-Payment-Required` header AND the legacy `Payment-Needed` header, that
 * `Payment-Needed` decodes to a signed challenge, and that the x402
 * accepts[] includes the alipay-aipay entry. Proves the dual-emit
 * middleware works over real HTTP.
 *
 * Run: node_modules/.bin/tsx scripts/alipay-http-402.mts
 */
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { MoltsPayServer } from '../src/server/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const certAbs = path.join(repoRoot, 'cert');

const dir = mkdtempSync(path.join(tmpdir(), 'alipay-http-'));
const manifestPath = path.join(dir, 'moltspay.services.json');
writeFileSync(manifestPath, JSON.stringify({
  provider: {
    name: 'sr007 http test',
    wallet: '0x0000000000000000000000000000000000000000',
    chains: [{ chain: 'base', tokens: ['USDC'] }],
    alipay: {
      seller_id: '2088641494699428',
      app_id: '2021006150642142',
      seller_name: '上海超响应数字科技有限公司',
      service_id_default: 'API_0EA6DC4FC99A4DF7',
      private_key_path: path.join(certAbs, 'ALIPAY_PRIVATE_KEY.txt'),
      alipay_public_key_path: path.join(certAbs, 'ALIPAY_PUBLIC_KEY.txt'),
      gateway_url: 'https://openapi.alipaydev.com/gateway.do',
    },
  },
  services: [{
    id: 'video-demo', name: '产品演示视频', price: 0.14, currency: 'USDC',
    input: {}, output: {},
    alipay: { service_id: 'API_0EA6DC4FC99A4DF7', price_cny: '1.00', goods_name: '产品演示视频 - 系列一' },
  }],
}));

const PORT = 39472;
const server = new MoltsPayServer(manifestPath, { port: PORT });
server.skill('video-demo', async () => ({ url: 'https://example.com/v.mp4' }));
server.listen(PORT);

await new Promise((r) => setTimeout(r, 400));

const res = await fetch(`http://127.0.0.1:${PORT}/execute`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ service: 'video-demo', params: {} }),
});

console.log('[1] status:', res.status, res.status === 402 ? 'OK (402)' : 'FAIL');
const xpr = res.headers.get('x-payment-required');
const pn = res.headers.get('payment-needed');
console.log('[2] X-Payment-Required header:', xpr ? 'present OK' : 'MISSING FAIL');
console.log('[3] Payment-Needed header (legacy alipay-bot):', pn ? 'present OK' : 'MISSING FAIL');

let challengeOk = false;
if (pn) {
  const decoded = JSON.parse(Buffer.from(pn, 'base64url').toString('utf-8'));
  challengeOk = !!(decoded?.protocol?.seller_signature && decoded?.protocol?.out_trade_no);
  console.log('[4] Payment-Needed decodes to signed challenge:', challengeOk ? 'OK' : 'FAIL',
    '| out_trade_no=' + decoded?.protocol?.out_trade_no);
}

let acceptsOk = false;
if (xpr) {
  const x402 = JSON.parse(Buffer.from(xpr, 'base64').toString('utf-8'));
  acceptsOk = Array.isArray(x402.accepts) && x402.accepts.some((a: any) => a.scheme === 'alipay-aipay');
  console.log('[5] x402 accepts[] includes alipay-aipay entry:', acceptsOk ? 'OK' : 'FAIL');
}

const pass = res.status === 402 && !!xpr && !!pn && challengeOk && acceptsOk;
console.log(pass ? '\nHTTP 402 DUAL-EMIT PASSED' : '\nHTTP 402 DUAL-EMIT FAILED');
process.exit(pass ? 0 : 1);
