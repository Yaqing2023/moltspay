/**
 * Alipay-rail client errors (2.0.0).
 *
 * Every class carries a stable `code` (the 1.6.0 convention established in
 * `../core/errors.ts`) so MCP hosts / upper-layer agents can branch on the
 * kind without string-matching `.message`:
 *
 *   - ALIPAY_CLI_NOT_FOUND     → guide the user to install alipay-bot
 *   - ALIPAY_CLI_VERSION       → guide the user to update alipay-bot
 *   - ALIPAY_NEEDS_WALLET_SETUP→ guide the user to open/bind a wallet
 *   - ALIPAY_PAYMENT_REJECTED  → user declined / Alipay rejected the charge
 *   - ALIPAY_PAYMENT_TIMEOUT   → pay_before elapsed before completion (retryable)
 *   - ALIPAY_PROTOCOL          → malformed CLI output / contract violation
 *   - UNSUPPORTED_RAIL         → the requested rail is not in server accepts[]
 */

import { MoltsPayError } from '../core/errors.js';

export class AlipayCliNotFoundError extends MoltsPayError {
  constructor(message: string) {
    super('ALIPAY_CLI_NOT_FOUND', message);
    this.name = 'AlipayCliNotFoundError';
  }
}

export class AlipayCliVersionError extends MoltsPayError {
  constructor(message: string) {
    super('ALIPAY_CLI_VERSION', message);
    this.name = 'AlipayCliVersionError';
  }
}

export class NeedsWalletSetupError extends MoltsPayError {
  constructor(message = 'Alipay wallet not set up. Run: moltspay alipay apply') {
    super('ALIPAY_NEEDS_WALLET_SETUP', message);
    this.name = 'NeedsWalletSetupError';
  }
}

export class AlipayPaymentRejectedError extends MoltsPayError {
  constructor(message: string) {
    super('ALIPAY_PAYMENT_REJECTED', message);
    this.name = 'AlipayPaymentRejectedError';
  }
}

export class AlipayPaymentTimeoutError extends MoltsPayError {
  constructor(message: string) {
    super('ALIPAY_PAYMENT_TIMEOUT', message);
    this.name = 'AlipayPaymentTimeoutError';
  }
}

export class AlipayProtocolError extends MoltsPayError {
  constructor(message: string) {
    super('ALIPAY_PROTOCOL', message);
    this.name = 'AlipayProtocolError';
  }
}

export class UnsupportedRailError extends MoltsPayError {
  constructor(public readonly rail: string, message?: string) {
    super('UNSUPPORTED_RAIL', message ?? `Rail not supported by server: ${rail}`);
    this.name = 'UnsupportedRailError';
  }
}
