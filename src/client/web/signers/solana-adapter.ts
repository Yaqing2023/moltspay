/**
 * Solana wallet-adapter signer — wraps a wallet adapter (Phantom, Solflare,
 * Backpack, any `@solana/wallet-adapter` compatible object) into a
 * `PaymentSigner`.
 *
 * We intentionally accept only the subset of the WalletAdapter interface we
 * actually use (`publicKey` + `signTransaction`) so the caller doesn't have
 * to pull in the full `@solana/wallet-adapter-base` type transitively.
 *
 * Behavior matches `NodeSigner.signSolanaTransaction`:
 *  - The wallet signs the serialized transaction and returns it base64-encoded.
 *  - We never submit — the server does, after the x402 payload lands.
 *  - `partialSign: true` is passed through to the adapter so the server's fee
 *    payer signature is preserved (gasless Solana mode).
 */

import { Transaction } from '@solana/web3.js';
import type { PublicKey } from '@solana/web3.js';
import type { PaymentSigner } from '../../signer.js';
import {
  base64ToUint8Array,
  uint8ArrayToBase64,
  PaymentRejectedError,
} from '../../core/index.js';

/** Minimal Solana wallet-adapter shape the signer needs. */
export interface SolanaSignerAdapter {
  /** Connected account's public key, or `null` if disconnected. */
  publicKey: PublicKey | null;
  /**
   * Signs a legacy Solana `Transaction` and returns the same transaction with
   * signatures attached. Wallet adapters already implement this — we simply
   * delegate. We do NOT use `signAllTransactions` or `signMessage`.
   */
  signTransaction(tx: Transaction): Promise<Transaction>;
}

/**
 * Wallet-rejection heuristic for Solana adapters. Adapters raise
 * `WalletSignTransactionError` with `name` like `WalletSignTransactionError`
 * or messages containing "reject"; different wallets vary, so we err on
 * the side of propagating the original error and only surface
 * `PaymentRejectedError` when the signal is clear.
 */
function isUserRejection(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  const message = String((err as { message?: string })?.message ?? '');
  return (
    name.toLowerCase().includes('reject') ||
    /user rejected|user denied|rejected by user/i.test(message)
  );
}

/**
 * Build a `PaymentSigner` backed by a Solana wallet adapter.
 *
 * The returned signer exposes only Solana capabilities — `getEvmAddress`
 * throws, because the Web Client dispatches by chain and never asks a Solana
 * signer to sign EVM data. To support both EVM and Solana in one client,
 * compose this with `eip1193Signer` via `composeSigners`.
 */
export function solanaSigner(adapter: SolanaSignerAdapter): PaymentSigner {
  return {
    async getEvmAddress(): Promise<string> {
      throw new Error(
        'solanaSigner does not support EVM. Compose with eip1193Signer for multi-chain.'
      );
    },

    async getSolanaAddress(): Promise<string | null> {
      return adapter.publicKey ? adapter.publicKey.toBase58() : null;
    },

    async signTypedData(): Promise<string> {
      throw new Error('solanaSigner does not support EIP-712 signing.');
    },

    async signSolanaTransaction(args: {
      transactionBase64: string;
      partialSign: boolean;
    }): Promise<string> {
      if (!adapter.publicKey) {
        throw new PaymentRejectedError('Solana wallet not connected');
      }
      const tx = Transaction.from(base64ToUint8Array(args.transactionBase64));
      let signed: Transaction;
      try {
        // Wallet adapters themselves decide between full-sign and partial-sign
        // behavior based on the transaction's declared feePayer. We rely on
        // the caller passing `partialSign: true` when a feePayer is set so
        // the server-side signature slot is preserved.
        signed = await adapter.signTransaction(tx);
      } catch (err) {
        if (isUserRejection(err)) {
          throw new PaymentRejectedError('User rejected Solana signature');
        }
        throw err;
      }
      const serialized = signed.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      return uint8ArrayToBase64(serialized);
    },
  };
}
