import { describe, it, expect } from 'vitest';
import {
  buildEIP3009TypedData,
  EIP3009_TYPES,
} from '../../../src/client/core/eip3009.js';

describe('eip3009', () => {
  it('assembles the canonical TransferWithAuthorization envelope', () => {
    const envelope = buildEIP3009TypedData({
      from: '0x0000000000000000000000000000000000000001',
      to:   '0x0000000000000000000000000000000000000002',
      value: '990000',
      nonce: '0x' + '11'.repeat(32),
      validAfter: '0',
      validBefore: '9999999999',
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      tokenName: 'USD Coin',
      tokenVersion: '2',
    });

    expect(envelope.primaryType).toBe('TransferWithAuthorization');
    expect(envelope.types).toEqual(EIP3009_TYPES);
    expect(envelope.domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    });
    expect(envelope.message).toEqual({
      from: '0x0000000000000000000000000000000000000001',
      to:   '0x0000000000000000000000000000000000000002',
      value: '990000',
      validAfter: '0',
      validBefore: '9999999999',
      nonce: '0x' + '11'.repeat(32),
    });
  });

  it('defaults validAfter=0 and validBefore=now+3600 when omitted', () => {
    const before = Math.floor(Date.now() / 1000);
    const envelope = buildEIP3009TypedData({
      from: '0x0000000000000000000000000000000000000001',
      to:   '0x0000000000000000000000000000000000000002',
      value: '1',
      nonce: '0x' + '00'.repeat(32),
      chainId: 8453,
      tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      tokenName: 'USD Coin',
      tokenVersion: '2',
    });
    expect(envelope.message.validAfter).toBe('0');
    const validBefore = Number(envelope.message.validBefore);
    expect(validBefore).toBeGreaterThanOrEqual(before + 3599);
    expect(validBefore).toBeLessThanOrEqual(before + 3601);
  });
});
