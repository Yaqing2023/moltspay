/**
 * EIP-2612 Permit builder tests, including DOMAIN_SEPARATOR guardrails.
 *
 * The guardrails recompute each Tempo TIP-20 token's DOMAIN_SEPARATOR locally
 * and assert it matches the value observed on Tempo Moderato mainnet during
 * the Phase 0 probe (2026-04-21). If anyone edits the token name / version,
 * one of these tests will fail and force a re-verification.
 */

import { describe, it, expect } from 'vitest';
import { keccak256, toUtf8Bytes, AbiCoder, getAddress } from 'ethers';
import {
  buildEIP2612PermitTypedData,
  buildTempoPermitTypedData,
  TEMPO_EIP2612_DOMAINS,
  TEMPO_CHAIN_ID,
  EIP2612_TYPES,
} from '../../../src/client/core/eip2612.js';

const abi = AbiCoder.defaultAbiCoder();
const DOMAIN_TYPE_HASH = keccak256(
  toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')
);

function computeDomainSeparator(
  name: string,
  version: string,
  chainId: number,
  verifyingContract: string
): string {
  return keccak256(
    abi.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        DOMAIN_TYPE_HASH,
        keccak256(toUtf8Bytes(name)),
        keccak256(toUtf8Bytes(version)),
        chainId,
        getAddress(verifyingContract),
      ]
    )
  );
}

describe('eip2612 — typed-data shape', () => {
  it('returns canonical EIP-2612 field order', () => {
    const envelope = buildEIP2612PermitTypedData({
      owner: '0x0000000000000000000000000000000000000001',
      spender: '0x0000000000000000000000000000000000000002',
      value: '500000',
      nonce: '0',
      deadline: '9999999999',
      chainId: 42431,
      tokenAddress: '0x20c0000000000000000000000000000000000000',
      tokenName: 'PathUSD',
      tokenVersion: '1',
    });

    expect(envelope.primaryType).toBe('Permit');
    expect(envelope.types).toEqual(EIP2612_TYPES);
    expect(envelope.domain.chainId).toBe(42431);
    expect(envelope.message).toEqual({
      owner: '0x0000000000000000000000000000000000000001',
      spender: '0x0000000000000000000000000000000000000002',
      value: '500000',
      nonce: '0',
      deadline: '9999999999',
    });
  });

  it('buildTempoPermitTypedData resolves by symbol', () => {
    const envelope = buildTempoPermitTypedData({
      symbol: 'pathUSD',
      owner: '0x0000000000000000000000000000000000000001',
      spender: '0x0000000000000000000000000000000000000002',
      value: '1',
      nonce: '0',
      deadline: '1',
    });
    expect(envelope.domain.name).toBe('PathUSD');
    expect(envelope.domain.verifyingContract).toBe(
      '0x20c0000000000000000000000000000000000000'
    );
  });

  it('throws on unknown Tempo symbol', () => {
    expect(() =>
      buildTempoPermitTypedData({
        symbol: 'FakeUSD',
        owner: '0x0000000000000000000000000000000000000001',
        spender: '0x0000000000000000000000000000000000000002',
        value: '1',
        nonce: '0',
        deadline: '1',
      })
    ).toThrow('Unknown Tempo token: FakeUSD');
  });
});

describe('eip2612 — Tempo DOMAIN_SEPARATOR guardrails (verified on-chain 2026-04-21)', () => {
  for (const [symbol, info] of Object.entries(TEMPO_EIP2612_DOMAINS)) {
    it(`${symbol} @ ${info.address}: (${info.name}, v${info.version}) matches live chain value`, () => {
      const local = computeDomainSeparator(
        info.name,
        info.version,
        TEMPO_CHAIN_ID,
        info.address
      );
      expect(local.toLowerCase()).toBe(info.expectedDomainSeparator.toLowerCase());
    });
  }
});
