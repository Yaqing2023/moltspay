/**
 * Structured error classes used by both Node and Web clients.
 *
 * Every error carries a `code` field so callers can branch on the kind
 * without string-matching `.message`.
 */

export class MoltsPayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MoltsPayError';
    this.code = code;
  }
}

export class NotInitializedError extends MoltsPayError {
  constructor(message = 'Client not initialized') {
    super('NOT_INITIALIZED', message);
    this.name = 'NotInitializedError';
  }
}

export class UnsupportedChainError extends MoltsPayError {
  constructor(public readonly chain: string, message?: string) {
    super('UNSUPPORTED_CHAIN', message ?? `Chain not supported: ${chain}`);
    this.name = 'UnsupportedChainError';
  }
}

export interface NeedsApprovalDetails {
  chain: string;
  spender: string;
  token: string;
  currentAllowance: string;
  required: string;
}

export class NeedsApprovalError extends MoltsPayError {
  constructor(public readonly details: NeedsApprovalDetails, message?: string) {
    super(
      'NEEDS_APPROVAL',
      message ??
        `Insufficient allowance for ${details.spender}. Current=${details.currentAllowance}, required=${details.required}.`
    );
    this.name = 'NeedsApprovalError';
  }
}

export class InsufficientBalanceError extends MoltsPayError {
  constructor(message: string) {
    super('INSUFFICIENT_BALANCE', message);
    this.name = 'InsufficientBalanceError';
  }
}

export class SpendingLimitExceededError extends MoltsPayError {
  constructor(message: string) {
    super('SPENDING_LIMIT_EXCEEDED', message);
    this.name = 'SpendingLimitExceededError';
  }
}

export class PaymentRejectedError extends MoltsPayError {
  constructor(message: string) {
    super('PAYMENT_REJECTED', message);
    this.name = 'PaymentRejectedError';
  }
}

export class ServerError extends MoltsPayError {
  constructor(public readonly status: number, message: string) {
    super('SERVER_ERROR', message);
    this.name = 'ServerError';
  }
}

export class InvalidPaymentHeaderError extends MoltsPayError {
  constructor(message: string) {
    super('INVALID_PAYMENT_HEADER', message);
    this.name = 'InvalidPaymentHeaderError';
  }
}
