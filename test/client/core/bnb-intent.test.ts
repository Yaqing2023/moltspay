import { describe, it, expect } from 'vitest';
import {
  buildBnbIntentTypedData,
  BNB_INTENT_TYPES,
  BNB_DOMAIN_NAME,
  BNB_DOMAIN_VERSION,
} from '../../../src/client/core/bnb-intent.js';

describe('bnb-intent', () => {
  it('assembles the MoltsPay PaymentIntent envelope for BNB', () => {
    const envelope = buildBnbIntentTypedData({
      from: '0x0000000000000000000000000000000000000001',
      to:   '0x0000000000000000000000000000000000000002',
      amount: '990000000000000000',
      tokenAddress: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      service: 'text-to-video',
      nonce: 12345,
      deadline: 1900000000,
      chainId: 56,
    });

    expect(envelope.primaryType).toBe('PaymentIntent');
    expect(envelope.types).toEqual(BNB_INTENT_TYPES);
    expect(envelope.domain).toEqual({
      name: BNB_DOMAIN_NAME,
      version: BNB_DOMAIN_VERSION,
      chainId: 56,
    });
    expect(envelope.domain.verifyingContract).toBeUndefined();
    expect(envelope.message).toEqual({
      from: '0x0000000000000000000000000000000000000001',
      to:   '0x0000000000000000000000000000000000000002',
      amount: '990000000000000000',
      token: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      service: 'text-to-video',
      nonce: 12345,
      deadline: 1900000000,
    });
  });

  it('uses stable constants for domain name + version', () => {
    expect(BNB_DOMAIN_NAME).toBe('MoltsPay');
    expect(BNB_DOMAIN_VERSION).toBe('1');
  });
});
