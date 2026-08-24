/**
 * Unit tests for the earn-side FulfillmentPolicy (commerce-core), the mirror of
 * PolicyEngine: buyer allow/deny, min-price floor, auto-fulfill vs approval.
 *
 * Pure logic — no I/O, no network.
 */
import { describe, it, expect } from 'vitest';
import { FulfillmentPolicy } from '../../src/commerce/index.js';

describe('FulfillmentPolicy', () => {
  it('fulfills by default (no config)', () => {
    const p = new FulfillmentPolicy();
    expect(p.decide({ amountSat: 99, buyerId: '0xabc' }).action).toBe('fulfill');
  });

  it('denies a buyer on the deny list (case-insensitive)', () => {
    const p = new FulfillmentPolicy({ buyers: { deny: ['0xBAD'] } });
    const d = p.decide({ amountSat: 99, buyerId: '0xbad' });
    expect(d.action).toBe('deny');
    expect(d.code).toBe('buyer_denied');
  });

  it('deny takes precedence over allow', () => {
    const p = new FulfillmentPolicy({ buyers: { allow: ['0xbad'], deny: ['0xbad'] } });
    expect(p.decide({ amountSat: 99, buyerId: '0xbad' }).action).toBe('deny');
  });

  it('denies a buyer not on the allow list', () => {
    const p = new FulfillmentPolicy({ buyers: { allow: ['0xgood'] } });
    expect(p.decide({ amountSat: 99, buyerId: '0xother' }).code).toBe('buyer_not_allowed');
    expect(p.decide({ amountSat: 99, buyerId: '0xGOOD' }).action).toBe('fulfill');
  });

  it('denies when no buyer id is supplied but an allow list is set', () => {
    const p = new FulfillmentPolicy({ buyers: { allow: ['0xgood'] } });
    expect(p.decide({ amountSat: 99 }).code).toBe('buyer_not_allowed');
  });

  it('denies below the min-price floor', () => {
    const p = new FulfillmentPolicy({ minPriceSat: 100 }); // $1.00
    expect(p.decide({ amountSat: 99, buyerId: '0xabc' }).code).toBe('below_min_price');
    expect(p.decide({ amountSat: 100, buyerId: '0xabc' }).action).toBe('fulfill');
  });

  it('auto-fulfills below the approval threshold, requires approval at/above', () => {
    const p = new FulfillmentPolicy({ approval: { autoFulfillBelowSat: 500 } }); // $5.00
    expect(p.decide({ amountSat: 499, buyerId: '0xabc' }).action).toBe('fulfill');
    expect(p.decide({ amountSat: 500, buyerId: '0xabc' }).action).toBe('require_approval');
    expect(p.decide({ amountSat: 900, buyerId: '0xabc' }).action).toBe('require_approval');
  });

  it('rejects a non-positive or non-integer amount', () => {
    const p = new FulfillmentPolicy();
    expect(p.decide({ amountSat: 0, buyerId: '0xabc' }).code).toBe('invalid_amount');
    expect(p.decide({ amountSat: -5, buyerId: '0xabc' }).code).toBe('invalid_amount');
    expect(p.decide({ amountSat: 1.5, buyerId: '0xabc' }).code).toBe('invalid_amount');
  });

  it('order of checks: deny buyer beats min-price and threshold', () => {
    const p = new FulfillmentPolicy({
      buyers: { deny: ['0xbad'] },
      minPriceSat: 1000,
      approval: { autoFulfillBelowSat: 100 },
    });
    expect(p.decide({ amountSat: 50, buyerId: '0xbad' }).code).toBe('buyer_denied');
  });

  it('validates config: bad thresholds throw', () => {
    expect(() => new FulfillmentPolicy({ approval: { autoFulfillBelowSat: 100, requireApprovalAboveSat: 50 } }))
      .toThrow(/requireApprovalAboveSat/);
    expect(() => new FulfillmentPolicy({ minPriceSat: -1 })).toThrow(/minPriceSat/);
  });
});
