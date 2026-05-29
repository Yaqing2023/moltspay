/**
 * Type contract tests for the Alipay-rail extensions to ServicesManifest
 * (src/server/types.ts).
 *
 * Runtime assertions are minimal — the value comes from `tsc --noEmit`
 * catching shape mismatches at compile time. These tests anchor the
 * shapes against the JSON schema in schemas/moltspay.services.schema.json
 * so the two stay in lockstep.
 */

import { describe, it, expect } from 'vitest';
import {
  ServicesManifest,
  ProviderAlipayConfig,
  ServiceAlipayConfig,
} from '../../src/server/types.js';

describe('ServicesManifest types — Alipay rail (1.7.0)', () => {
  it('accepts a full manifest with provider.alipay + services[].alipay', () => {
    const manifest: ServicesManifest = {
      provider: {
        name: '灵机一物',
        wallet: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
        alipay: {
          seller_id: '2088641494699428',
          app_id: '2021006150642142',
          seller_name: '上海超响应数字科技有限公司',
          service_id_default: 'API_0EA6DC4FC99A4DF7',
          private_key_path: './cert/ALIPAY_PRIVATE_KEY.txt',
          alipay_public_key_path: './cert/ALIPAY_PUBLIC_KEY.txt',
        },
      },
      services: [{
        id: 'text-to-video',
        name: 'Text to Video',
        price: 0.99,
        currency: 'USDC',
        function: 'textToVideo',
        input: {},
        output: {},
        alipay: {
          service_id: 'API_0EA6DC4FC99A4DF7',
          price_cny: '7.00',
          goods_name: '产品演示视频 - 系列一',
        },
      }],
    };

    expect(manifest.provider.alipay?.seller_id).toBe('2088641494699428');
    expect(manifest.services[0].alipay?.price_cny).toBe('7.00');
  });

  it('keeps both alipay fields optional (backward compat with pre-1.7.0)', () => {
    const manifest: ServicesManifest = {
      provider: {
        name: 'demo',
        wallet: '0x' + 'a'.repeat(40),
      },
      services: [{
        id: 'demo',
        name: 'Demo',
        price: 0.99,
        currency: 'USDC',
        input: {},
        output: {},
      }],
    };

    expect(manifest.provider.alipay).toBeUndefined();
    expect(manifest.services[0].alipay).toBeUndefined();
  });

  it('accepts ProviderAlipayConfig with only the 6 required fields (gateway_url + sign_type default)', () => {
    const cfg: ProviderAlipayConfig = {
      seller_id: '2088641494699428',
      app_id: '2021006150642142',
      seller_name: 'demo',
      service_id_default: 'API_xyz',
      private_key_path: './cert/k1.pem',
      alipay_public_key_path: './cert/k2.pem',
    };
    expect(cfg.gateway_url).toBeUndefined();
    expect(cfg.sign_type).toBeUndefined();
  });

  it('accepts ProviderAlipayConfig overriding gateway_url for sandbox', () => {
    const cfg: ProviderAlipayConfig = {
      seller_id: '2088641494699428',
      app_id: '2021006150642142',
      seller_name: 'demo',
      service_id_default: 'API_xyz',
      private_key_path: './cert/k1.pem',
      alipay_public_key_path: './cert/k2.pem',
      gateway_url: 'https://openapi.alipaydev.com/gateway.do',
      sign_type: 'RSA2',
    };
    expect(cfg.gateway_url).toContain('alipaydev');
    expect(cfg.sign_type).toBe('RSA2');
  });

  it('ServiceAlipayConfig service_id is optional (falls back to provider.alipay.service_id_default)', () => {
    const cfg: ServiceAlipayConfig = {
      price_cny: '1.00',
      goods_name: 'demo',
    };
    expect(cfg.service_id).toBeUndefined();
  });

  it('ServiceAlipayConfig accepts all 3 fields populated', () => {
    const cfg: ServiceAlipayConfig = {
      service_id: 'API_xyz',
      price_cny: '100.00',
      goods_name: 'demo',
    };
    expect(cfg.service_id).toBe('API_xyz');
  });
});

describe('JSON schema parity', () => {
  it('schemas/moltspay.services.schema.json parses as JSON and has alipay extensions', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const schemaPath = path.resolve(here, '../../schemas/moltspay.services.schema.json');
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf-8'));

    // 'alipay' is in both single-chain enum and chains array enum
    expect(schema.properties.provider.properties.chain.enum).toContain('alipay');
    expect(schema.properties.provider.properties.chains.items.enum).toContain('alipay');

    // provider.alipay object with required fields
    expect(schema.properties.provider.properties.alipay).toBeDefined();
    expect(schema.properties.provider.properties.alipay.required).toEqual(
      expect.arrayContaining([
        'seller_id', 'app_id', 'seller_name', 'service_id_default',
        'private_key_path', 'alipay_public_key_path',
      ]),
    );

    // services[].alipay object with required fields
    const svcAlipay = schema.properties.services.items.properties.alipay;
    expect(svcAlipay).toBeDefined();
    expect(svcAlipay.required).toEqual(expect.arrayContaining(['price_cny', 'goods_name']));
    expect(svcAlipay.properties.price_cny.pattern).toBe('^\\d+(\\.\\d{1,2})?$');
  });
});
