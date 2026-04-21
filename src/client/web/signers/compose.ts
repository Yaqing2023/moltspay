/**
 * `composeSigners` — merge multiple `PaymentSigner`s into one, routing each
 * method to the first underlying signer that can service it.
 *
 * Typical use: a dApp wants to pay on both EVM chains (via MetaMask) and
 * Solana (via Phantom) from the same `MoltsPayWebClient` instance. Rather
 * than re-instantiating the client per chain, the app composes the two:
 *
 *     const client = new MoltsPayWebClient({
 *       signer: composeSigners(
 *         eip1193Signer(window.ethereum),
 *         solanaSigner(phantomAdapter),
 *       ),
 *     });
 *
 * Routing rule: for each method (`getEvmAddress`, `signTypedData`,
 * `sendEvmTransaction`, `getSolanaAddress`, `signSolanaTransaction`), pick
 * the first signer in argument order whose method returns a successful
 * result. "Successful" = the method is defined on the signer AND does not
 * throw the sentinel `NOT_SUPPORTED` error the adapters emit for off-chain
 * methods (`solanaSigner.getEvmAddress` throws plainly, and that throw is
 * caught and tried on the next signer).
 *
 * Falls through to the last signer's error if none match, so callers still
 * see an actionable message.
 */

import type { PaymentSigner } from '../../signer.js';
import type { TypedDataEnvelope } from '../../core/index.js';

export function composeSigners(...signers: PaymentSigner[]): PaymentSigner {
  if (signers.length === 0) {
    throw new Error('composeSigners requires at least one signer');
  }
  if (signers.length === 1) {
    return signers[0];
  }

  async function tryEach<T>(
    pick: (s: PaymentSigner) => Promise<T> | undefined
  ): Promise<T> {
    let lastError: unknown = new Error('composeSigners: no signer supported the operation');
    for (const signer of signers) {
      const candidate = pick(signer);
      if (candidate === undefined) continue;
      try {
        return await candidate;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  return {
    getEvmAddress: () => tryEach(s => s.getEvmAddress?.()),

    getSolanaAddress: () =>
      tryEach<string | null>(s =>
        s.getSolanaAddress ? s.getSolanaAddress() : undefined
      ),

    signTypedData: <TMessage>(envelope: TypedDataEnvelope<TMessage>) =>
      tryEach(s => s.signTypedData?.(envelope)),

    sendEvmTransaction: (args) =>
      tryEach<string>(s =>
        s.sendEvmTransaction ? s.sendEvmTransaction(args) : undefined
      ),

    signSolanaTransaction: (args) =>
      tryEach<string>(s =>
        s.signSolanaTransaction ? s.signSolanaTransaction(args) : undefined
      ),
  };
}
