/**
 * Long-running MoltsPayServer for the live Alipay 1-CNY E2E (manual QA).
 *
 * Boots with the real sr007 merchant keys + one alipay service, registers a
 * trivial skill, and listens until killed. Pair with:
 *   moltspay pay --rail alipay http://127.0.0.1:39555 video-demo
 *
 * Run: PATH="$HOME/.local/bin:$PATH" node_modules/.bin/tsx scripts/alipay-live-server.mts
 */
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { MoltsPayServer } from '../src/server/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const certAbs = path.join(repoRoot, 'cert');
const PORT = 39555;

const dir = mkdtempSync(path.join(tmpdir(), 'alipay-live-'));
const manifestPath = path.join(dir, 'moltspay.services.json');
writeFileSync(manifestPath, JSON.stringify({
  provider: {
    name: 'sr007 live test',
    wallet: '0x0000000000000000000000000000000000000000',
    chains: ['base'],
    alipay: {
      seller_id: '2088641494699428',
      app_id: '2021006150642142',
      seller_name: '上海超响应数字科技有限公司',
      service_id_default: 'API_0EA6DC4FC99A4DF7',
      private_key_path: path.join(certAbs, 'ALIPAY_PRIVATE_KEY.txt'),
      alipay_public_key_path: path.join(certAbs, 'ALIPAY_PUBLIC_KEY.txt'),
      // Production gateway: the buyer paid via the production "AI付" wallet, so
      // verify/confirm must hit production (sandbox alipaydev.com is also 502).
      gateway_url: 'https://openapi.alipay.com/gateway.do',
    },
  },
  services: [{
    id: 'video-demo', name: '产品演示视频', price: 0.14, currency: 'USDC',
    input: {}, output: {},
    alipay: { service_id: 'API_0EA6DC4FC99A4DF7', price_cny: '1.00', goods_name: '产品演示视频 - 系列一' },
  }],
}));

const server = new MoltsPayServer(manifestPath, { port: PORT });
server.skill('video-demo', async () => ({ url: 'https://example.com/demo-video.mp4', delivered_at: 'live-e2e' }));
server.listen(PORT);
console.log(`[live] MoltsPayServer up on http://127.0.0.1:${PORT} (service: video-demo, 1.00 CNY)`);
