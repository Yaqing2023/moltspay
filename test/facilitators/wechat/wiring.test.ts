/**
 * Wiring tests: the WeChat rail is reachable through the public surfaces
 * (registry factory, facilitators barrel export, chains rail metadata).
 */

import { describe, it, expect } from 'vitest';
import { FacilitatorRegistry } from '../../../src/facilitators/registry.js';
import { WechatFacilitator } from '../../../src/facilitators/index.js';
import { isWechatChainId, WECHAT_RAIL, WECHAT_CHAIN_ID } from '../../../src/chains/index.js';

const DUMMY = {
  mchid: '1900000001',
  appid: 'wx8888888888888888',
  serial_no: 's',
  private_key_pem: 'x',
  notify_url: 'https://example.com/notify',
} as const;

describe('wechat wiring', () => {
  it('registry resolves the wechat factory to a WechatFacilitator', () => {
    const r = new FacilitatorRegistry();
    const w = r.get('wechat', DUMMY as any);
    expect(w.name).toBe('wechat');
    expect(w.supportsNetwork('wechat')).toBe(true);
    expect(w).toBeInstanceOf(WechatFacilitator);
  });

  it('chains rail metadata + guard', () => {
    expect(WECHAT_CHAIN_ID).toBe('wechat');
    expect(isWechatChainId('wechat')).toBe(true);
    expect(isWechatChainId('base')).toBe(false);
    expect(WECHAT_RAIL.type).toBe('fiat-rail');
    expect(WECHAT_RAIL.currency).toBe('CNY');
    expect(WECHAT_RAIL.facilitator).toBe('wechatpay-native');
  });
});
