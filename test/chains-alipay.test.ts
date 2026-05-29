/**
 * Unit tests for the Alipay fiat-rail registration in src/chains/index.ts.
 *
 * Sits at test/ root (not test/facilitators/) to mirror the existing
 * test/chains.test.ts layout for chain-config concerns.
 */

import { describe, it, expect } from 'vitest';
import {
  CHAINS,
  ALIPAY_CHAIN_ID,
  ALIPAY_RAIL,
  isAlipayChainId,
} from '../src/chains/index.js';
import { ALIPAY_SCHEME, ALIPAY_NETWORK } from '../src/facilitators/alipay.js';

describe('chains/index.ts — Alipay rail', () => {
  it('exposes ALIPAY_CHAIN_ID = "alipay"', () => {
    expect(ALIPAY_CHAIN_ID).toBe('alipay');
  });

  it('ALIPAY_RAIL has the documented 5-field shape', () => {
    expect(ALIPAY_RAIL).toEqual({
      id: 'alipay',
      type: 'fiat-rail',
      currency: 'CNY',
      decimals: 2,
      facilitator: 'alipay-aipay',
    });
  });

  it('does NOT appear in the EVM CHAINS Record', () => {
    expect(CHAINS).not.toHaveProperty('alipay');
    expect(Object.keys(CHAINS)).not.toContain('alipay');
  });

  describe('isAlipayChainId', () => {
    it('returns true for "alipay"', () => {
      expect(isAlipayChainId('alipay')).toBe(true);
    });

    it.each([
      'base',
      'polygon',
      'base_sepolia',
      'tempo_moderato',
      'bnb',
      'bnb_testnet',
      'solana',
      'solana_devnet',
      '',
      'Alipay',
      'alipay ',
      'alipay-aipay',
    ])('returns false for %j', (id) => {
      expect(isAlipayChainId(id)).toBe(false);
    });
  });

  describe('cross-module consistency', () => {
    it('ALIPAY_RAIL.id matches ALIPAY_NETWORK in facilitators/alipay.ts', () => {
      expect(ALIPAY_RAIL.id).toBe(ALIPAY_NETWORK);
    });

    it('ALIPAY_RAIL.facilitator matches ALIPAY_SCHEME in facilitators/alipay.ts', () => {
      expect(ALIPAY_RAIL.facilitator).toBe(ALIPAY_SCHEME);
    });
  });
});
