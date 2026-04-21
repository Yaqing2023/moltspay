/**
 * EIP-3009 TransferWithAuthorization typed-data builder (pure).
 *
 * Used for gasless payments on Base / Polygon / Base Sepolia where the token
 * contract (USDC, USDT variants) implements the `transferWithAuthorization`
 * function selector.
 *
 * The builder is runtime-agnostic: it returns the envelope, and the signer
 * (Node `ethers.Wallet` or Web EIP-1193 provider) does the actual signing.
 */

import type {
  EIP3009Authorization,
  TypedDataEnvelope,
} from './types.js';

export interface BuildEIP3009Args {
  /** Payer address (will become `from`). */
  from: string;
  /** Payee address (will become `to`). */
  to: string;
  /** Token amount in the token's smallest unit (e.g. 6 decimals for USDC → 500000 = $0.50). */
  value: string;
  /** Random 32-byte nonce as 0x-prefixed hex. Caller generates with their environment's CSPRNG. */
  nonce: string;
  /** Unix seconds when the authorization starts being valid. Default 0. */
  validAfter?: string;
  /** Unix seconds when the authorization expires. Default now + 3600. */
  validBefore?: string;

  /** EIP-155 chain id. */
  chainId: number;
  /** Token contract address. */
  tokenAddress: string;
  /** EIP-712 domain name as declared on-chain (e.g. "USD Coin" for USDC Base). */
  tokenName: string;
  /** EIP-712 domain version. Usually "2" for USDC, varies for USDT. */
  tokenVersion: string;
}

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
} as const;

export function buildEIP3009TypedData(
  args: BuildEIP3009Args
): TypedDataEnvelope<EIP3009Authorization> {
  const validAfter = args.validAfter ?? '0';
  const validBefore =
    args.validBefore ?? (Math.floor(Date.now() / 1000) + 3600).toString();

  const authorization: EIP3009Authorization = {
    from: args.from,
    to: args.to,
    value: args.value,
    validAfter,
    validBefore,
    nonce: args.nonce,
  };

  return {
    domain: {
      name: args.tokenName,
      version: args.tokenVersion,
      chainId: args.chainId,
      verifyingContract: args.tokenAddress,
    },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: authorization,
  };
}
