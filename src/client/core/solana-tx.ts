/**
 * Solana SPL token transfer transaction builder (pure).
 *
 * Re-export of the browser-compatible builder from
 * `src/facilitators/solana.ts`. The builder uses only
 * `@solana/web3.js` + `@solana/spl-token`, both of which bundle cleanly
 * for the browser.
 *
 * The Node client uses its local Keypair to sign the returned `Transaction`;
 * the Web client passes the transaction to a Wallet Adapter's
 * `signTransaction` method. In both cases the server submits the signed
 * transaction — the client never broadcasts.
 */

export { createSolanaPaymentTransaction } from '../../facilitators/solana.js';
