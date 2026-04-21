/**
 * EIP-2612 Permit typed-data builder (pure).
 *
 * Used for gasless payments on Tempo Moderato, where the TIP-20 stablecoin
 * contracts (pathUSD, AlphaUSD, BetaUSD, ThetaUSD) implement EIP-2612 permit
 * but not EIP-3009 transferWithAuthorization.
 *
 * Domain values below were verified on-chain against the live
 * `DOMAIN_SEPARATOR()` returned by each token contract on 2026-04-21.
 * See docs/TEMPO-WEB-SUPPORT.md Section 2 and Phase 0 results in
 * docs/WEB-CLIENT-DESIGN.md.
 */

import type {
  EIP2612PermitMessage,
  TypedDataEnvelope,
} from './types.js';

export interface BuildEIP2612PermitArgs {
  owner: string;
  spender: string;
  /** Token amount in the token's smallest unit. */
  value: string;
  /** Current `nonces(owner)` value on the token contract. Caller must read from chain. */
  nonce: string;
  /** Unix seconds until the permit expires. */
  deadline: string;

  chainId: number;
  /** Token contract address (the `verifyingContract` for EIP-712 domain). */
  tokenAddress: string;
  /** EIP-712 domain name as declared on-chain. See `TEMPO_EIP2612_DOMAINS` for Tempo tokens. */
  tokenName: string;
  /** EIP-712 domain version. */
  tokenVersion: string;
}

export const EIP2612_TYPES = {
  Permit: [
    { name: 'owner',    type: 'address' },
    { name: 'spender',  type: 'address' },
    { name: 'value',    type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export function buildEIP2612PermitTypedData(
  args: BuildEIP2612PermitArgs
): TypedDataEnvelope<EIP2612PermitMessage> {
  const message: EIP2612PermitMessage = {
    owner: args.owner,
    spender: args.spender,
    value: args.value,
    nonce: args.nonce,
    deadline: args.deadline,
  };

  return {
    domain: {
      name: args.tokenName,
      version: args.tokenVersion,
      chainId: args.chainId,
      verifyingContract: args.tokenAddress,
    },
    types: EIP2612_TYPES,
    primaryType: 'Permit',
    message,
  };
}

// ===== Tempo Moderato TIP-20 domain fixtures (verified on-chain 2026-04-21) =====

export const TEMPO_CHAIN_ID = 42431;

export interface TempoTokenDomain {
  /** Symbol case-preserved (e.g. "pathUSD"). */
  symbol: string;
  /** Token contract address. */
  address: string;
  /** EIP-712 domain name (first letter capitalized, e.g. "PathUSD"). */
  name: string;
  /** EIP-712 domain version (uniformly "1" across all 4 Tempo TIP-20s). */
  version: string;
  /** Expected on-chain DOMAIN_SEPARATOR. Used as a guardrail fixture in tests. */
  expectedDomainSeparator: string;
  /** Token decimals. */
  decimals: number;
}

export const TEMPO_EIP2612_DOMAINS: Record<string, TempoTokenDomain> = {
  pathUSD: {
    symbol: 'pathUSD',
    address: '0x20c0000000000000000000000000000000000000',
    name: 'PathUSD',
    version: '1',
    expectedDomainSeparator:
      '0xc601a8a9918b2bf5076e4a47925ebe14407230ba77dc84e248c15218a46ad6b4',
    decimals: 6,
  },
  AlphaUSD: {
    symbol: 'AlphaUSD',
    address: '0x20c0000000000000000000000000000000000001',
    name: 'AlphaUSD',
    version: '1',
    expectedDomainSeparator:
      '0x32d762f61205377e7b402fe1ef8014637c3b3a18234a5629cfab1982efdc2630',
    decimals: 6,
  },
  BetaUSD: {
    symbol: 'BetaUSD',
    address: '0x20c0000000000000000000000000000000000002',
    name: 'BetaUSD',
    version: '1',
    expectedDomainSeparator:
      '0x99a494a75ff574cc1ff179a3b4f4ec0aff55b51cdd0906994aa8e91bf95137d3',
    decimals: 6,
  },
  ThetaUSD: {
    symbol: 'ThetaUSD',
    address: '0x20c0000000000000000000000000000000000003',
    name: 'ThetaUSD',
    version: '1',
    expectedDomainSeparator:
      '0x657494dec20c65c40c636bb1781412e1dd3eb5aba55cd8dc8346a00753b9a782',
    decimals: 6,
  },
};

/** Convenience: build a Permit for a Tempo token by symbol. */
export function buildTempoPermitTypedData(args: {
  symbol: keyof typeof TEMPO_EIP2612_DOMAINS | string;
  owner: string;
  spender: string;
  value: string;
  nonce: string;
  deadline: string;
}): TypedDataEnvelope<EIP2612PermitMessage> {
  const token = TEMPO_EIP2612_DOMAINS[args.symbol];
  if (!token) {
    throw new Error(`Unknown Tempo token: ${args.symbol}`);
  }
  return buildEIP2612PermitTypedData({
    owner: args.owner,
    spender: args.spender,
    value: args.value,
    nonce: args.nonce,
    deadline: args.deadline,
    chainId: TEMPO_CHAIN_ID,
    tokenAddress: token.address,
    tokenName: token.name,
    tokenVersion: token.version,
  });
}
