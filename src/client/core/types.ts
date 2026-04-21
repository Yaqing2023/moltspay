/**
 * Core protocol types — shared between Node and Web clients.
 *
 * These describe x402 / MPP wire formats and EIP-712 typed-data shapes.
 * They MUST NOT import from any Node-only modules.
 */

// ===== x402 protocol constants =====

export const X402_VERSION = 2;
export const PAYMENT_REQUIRED_HEADER = 'x-payment-required';
export const PAYMENT_HEADER = 'x-payment';

// ===== x402 payment requirements (server → client) =====

export interface X402PaymentRequirements {
  scheme: string;
  network: string;

  // v2 fields
  amount?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;

  // v1 legacy fields
  maxAmountRequired?: string;
  resource?: string;
  description?: string;
}

// ===== EIP-3009 TransferWithAuthorization (Base / Polygon / Base Sepolia) =====

export interface EIP3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

// ===== EIP-2612 Permit (Tempo — pathUSD / AlphaUSD / BetaUSD / ThetaUSD) =====

export interface EIP2612PermitMessage {
  owner: string;
  spender: string;
  value: string;
  nonce: string;
  deadline: string;
}

/** Signed permit payload carried inside an x402 `scheme: "permit"` payment. */
export interface EIP2612PermitPayload {
  owner: string;
  spender: string;
  value: string;
  nonce: string;
  deadline: string;
  v: number;
  r: string;
  s: string;
}

// ===== BNB payment intent (Phase 3c+ pre-approval flow) =====

export interface BnbPaymentIntent {
  from: string;
  to: string;
  amount: string;
  token: string;
  service: string;
  nonce: number;
  deadline: number;
}

// ===== EIP-712 typed-data envelope (runtime-agnostic signing input) =====

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: number;
  verifyingContract?: string;
  salt?: string;
}

export interface TypedDataField {
  name: string;
  type: string;
}

export interface TypedDataEnvelope<TMessage = Record<string, unknown>> {
  domain: TypedDataDomain;
  types: Record<string, readonly TypedDataField[]>;
  primaryType: string;
  message: TMessage;
}
