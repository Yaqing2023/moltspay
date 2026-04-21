/**
 * PaymentSigner — runtime-agnostic signing interface.
 *
 * Implemented by:
 *   - `NodeSigner` (src/client/node/signer.ts)  → wraps an ethers.Wallet + optional Solana Keypair
 *   - `eip1193Signer(provider)` (src/client/web/signers/eip1193.ts, Phase 4) → delegates to MetaMask / WalletConnect / etc.
 *   - `solanaSigner(adapter)` (src/client/web/signers/solana-adapter.ts, Phase 4) → delegates to @solana/wallet-adapter
 *   - `composeSigners(...)` (Phase 4) → routes per-method between multiple backing signers
 *
 * The interface is intentionally narrow:
 *   - `signTypedData` covers every EIP-712 signing path (EIP-3009 on Base/Polygon, EIP-2612 on Tempo, BNB PaymentIntent).
 *   - `sendEvmTransaction` covers BNB approve (and any future EVM writes). Optional because most signers only sign.
 *   - `signSolanaTransaction` covers Solana SPL transfer signing. Optional because not every signer supports Solana.
 *
 * Deliberately excluded: Tempo MPP's `Actions.token.transfer` path (uses viem's Tempo chain extension with custom
 * `feeToken` semantics that do not map cleanly through a generic signer). The MPP flow stays Node-only and uses
 * viem directly; the Web client does not implement MPP.
 */

import type { TypedDataEnvelope } from './core/index.js';

export interface PaymentSigner {
  /**
   * Return the EVM address (0x-prefixed, checksummed or lowercase; callers should normalize as needed).
   * Required for every EVM payment path (Base / Polygon / BNB).
   */
  getEvmAddress(): Promise<string>;

  /**
   * Return the Solana address (base58). Required only when paying on `solana` or `solana_devnet`.
   * Implementations that don't support Solana should omit or return `null`.
   */
  getSolanaAddress?(): Promise<string | null>;

  /**
   * Sign an EIP-712 typed-data envelope. Used for:
   *   - EIP-3009 TransferWithAuthorization (Base / Polygon / Base Sepolia)
   *   - EIP-2612 Permit (Tempo Moderato)
   *   - BNB MoltsPay PaymentIntent
   *
   * Returns a 0x-prefixed 65-byte (r||s||v) signature.
   */
  signTypedData<TMessage>(envelope: TypedDataEnvelope<TMessage>): Promise<string>;

  /**
   * Send a raw EVM transaction and return its hash. Used for the BNB `approve` flow only in the
   * initial release; future versions may use it for other write paths.
   *
   * `chainId` allows the signer to switch chains (e.g. EIP-1193 `wallet_switchEthereumChain`).
   * `value` is hex-encoded wei; omitted when zero.
   *
   * Optional — omit on signers that cannot submit transactions (e.g. a read-only Ledger).
   */
  sendEvmTransaction?(args: {
    chainId: number;
    to: string;
    data: string;
    value?: string;
  }): Promise<string>;

  /**
   * Sign a Solana transaction without submitting it. Server submits.
   *
   * `transactionBase64` is the serialized unsigned transaction (produced by
   * `createSolanaPaymentTransaction` in core/solana-tx.ts).
   * `partialSign` is `true` when the server specified a `feePayer` and the wallet is only signing
   * for token-transfer authority (gasless Solana mode); `false` means the wallet is paying fees too.
   *
   * Returns the serialized signed transaction as base64.
   */
  signSolanaTransaction?(args: {
    transactionBase64: string;
    partialSign: boolean;
  }): Promise<string>;
}
