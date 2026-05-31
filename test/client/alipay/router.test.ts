import { describe, it, expect } from 'vitest';
import { selectRail, railOf, ALIPAY_RAIL } from '../../../src/client/alipay/router.js';
import { UnsupportedRailError } from '../../../src/client/alipay/errors.js';
import type { X402PaymentRequirements } from '../../../src/client/core/types.js';

const alipayReq: X402PaymentRequirements = {
  scheme: 'alipay-aipay', network: 'alipay', asset: 'CNY', amount: '1.00',
};
const baseReq: X402PaymentRequirements = {
  scheme: 'exact', network: 'eip155:8453', asset: 'USDC', amount: '0.14',
};
const polygonReq: X402PaymentRequirements = {
  scheme: 'exact', network: 'eip155:137', asset: 'USDC', amount: '0.14',
};

describe('railOf', () => {
  it('maps the alipay scheme/network to the alipay rail', () => {
    expect(railOf(alipayReq)).toBe('alipay');
    expect(railOf({ scheme: 'x', network: 'alipay' })).toBe('alipay');
  });
  it('maps EVM networks to chain names', () => {
    expect(railOf(baseReq)).toBe('base');
    expect(railOf(polygonReq)).toBe('polygon');
  });
  it('falls back to the raw network for unknown chains', () => {
    expect(railOf({ scheme: 'exact', network: 'eip155:99999' })).toBe('eip155:99999');
  });
});

describe('selectRail', () => {
  it('1. explicit rail wins when the server offers it', () => {
    const sel = selectRail({ serverAccepts: [baseReq, alipayReq], explicitRail: 'alipay' });
    expect(sel.rail).toBe('alipay');
    expect(sel.requirement).toBe(alipayReq);
  });

  it('1. explicit rail the server does NOT offer → UnsupportedRailError', () => {
    expect(() => selectRail({ serverAccepts: [baseReq], explicitRail: 'alipay' }))
      .toThrowError(UnsupportedRailError);
  });

  it('2. preference picks the first server-accepted rail', () => {
    const sel = selectRail({
      serverAccepts: [baseReq, alipayReq],
      preference: ['polygon', 'alipay', 'base'],
    });
    expect(sel.rail).toBe('alipay'); // polygon not offered, alipay is next
  });

  it('3. availability: evmReady prefers a crypto rail over alipay', () => {
    const sel = selectRail({
      serverAccepts: [alipayReq, baseReq],
      availability: { evmReady: true },
    });
    expect(sel.rail).toBe('base');
  });

  it('3. availability: alipayReady (no EVM) picks alipay', () => {
    const sel = selectRail({
      serverAccepts: [baseReq, alipayReq],
      availability: { alipayReady: true },
    });
    expect(sel.rail).toBe('alipay');
  });

  it('4. fallback to the first server offer', () => {
    const sel = selectRail({ serverAccepts: [baseReq, alipayReq] });
    expect(sel.requirement).toBe(baseReq);
  });

  it('throws when the server offered nothing', () => {
    expect(() => selectRail({ serverAccepts: [] })).toThrowError(UnsupportedRailError);
  });

  it('explicit rail takes priority over preference', () => {
    const sel = selectRail({
      serverAccepts: [baseReq, alipayReq],
      explicitRail: 'base',
      preference: ['alipay'],
    });
    expect(sel.rail).toBe('base');
  });

  it('ALIPAY_RAIL constant is the documented string', () => {
    expect(ALIPAY_RAIL).toBe('alipay');
  });
});
