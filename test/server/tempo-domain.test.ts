/**
 * Guardrail: ensure the server's Tempo TIP-20 EIP-712 domain names remain
 * consistent with the on-chain DOMAIN_SEPARATOR values observed during the
 * Phase 0 probe (2026-04-21).
 *
 * If someone edits `TOKEN_DOMAINS['eip155:42431']` in `src/server/index.ts`
 * to an incorrect name/version, one of these tests will fail before the
 * change reaches production and breaks permit signing on Tempo Web Client.
 *
 * Evidence: see `scripts/.probe-tempo-output/results.json` or run
 * `node scripts/probe-tempo-permit.mjs` to re-verify.
 */

import { describe, it, expect } from 'vitest';
import { keccak256, toUtf8Bytes, AbiCoder, getAddress } from 'ethers';
import { TEMPO_EIP2612_DOMAINS } from '../../src/client/core/eip2612.js';

const abi = AbiCoder.defaultAbiCoder();
const DOMAIN_TYPE_HASH = keccak256(
  toUtf8Bytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')
);
const CHAIN_ID = 42431;

function computeDomainSeparator(
  name: string,
  version: string,
  verifyingContract: string
): string {
  return keccak256(
    abi.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        DOMAIN_TYPE_HASH,
        keccak256(toUtf8Bytes(name)),
        keccak256(toUtf8Bytes(version)),
        CHAIN_ID,
        getAddress(verifyingContract),
      ]
    )
  );
}

// Mirror of the server's TOKEN_DOMAINS entry for Tempo (eip155:42431).
// Each test pairs the (name, version) currently hardcoded in the server with
// the verified on-chain DOMAIN_SEPARATOR from the Phase 0 fixtures.
const SERVER_ENTRIES: Array<{ symbol: string; name: string; version: string }> = [
  { symbol: 'pathUSD',  name: 'PathUSD',  version: '1' },
  { symbol: 'AlphaUSD', name: 'AlphaUSD', version: '1' },
  // BetaUSD and ThetaUSD are not currently routed via MoltsPay (USDC/USDT are
  // the advertised currencies) but we still guard them for future use.
  { symbol: 'BetaUSD',  name: 'BetaUSD',  version: '1' },
  { symbol: 'ThetaUSD', name: 'ThetaUSD', version: '1' },
];

describe('server TOKEN_DOMAINS for Tempo Moderato match on-chain DOMAIN_SEPARATOR', () => {
  for (const entry of SERVER_ENTRIES) {
    const fixture = TEMPO_EIP2612_DOMAINS[entry.symbol];

    it(`${entry.symbol} (name="${entry.name}", version="${entry.version}") matches fixture @ ${fixture.address}`, () => {
      const computed = computeDomainSeparator(entry.name, entry.version, fixture.address);
      expect(computed.toLowerCase()).toBe(fixture.expectedDomainSeparator.toLowerCase());
    });
  }
});
