/**
 * composeSigners — routing tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { composeSigners } from '../../../src/client/web/signers/compose.js';
import type { PaymentSigner } from '../../../src/client/signer.js';
import type { TypedDataEnvelope } from '../../../src/client/core/types.js';

const evmOnly: PaymentSigner = {
  getEvmAddress: vi.fn(async () => '0xEEE'),
  signTypedData: vi.fn(async () => '0xsig'),
};

const solanaOnly: PaymentSigner = {
  getEvmAddress: async () => {
    throw new Error('no evm here');
  },
  getSolanaAddress: vi.fn(async () => 'SolanaPubKey11111'),
  signTypedData: async () => {
    throw new Error('solana cannot sign eip712');
  },
  signSolanaTransaction: vi.fn(async () => 'signedTxBase64'),
};

describe('composeSigners', () => {
  it('throws when no signers provided', () => {
    expect(() => composeSigners()).toThrow(/at least one/i);
  });

  it('returns the single signer unchanged', () => {
    const composed = composeSigners(evmOnly);
    expect(composed).toBe(evmOnly);
  });

  it('routes getEvmAddress to the first signer that succeeds', async () => {
    const composed = composeSigners(solanaOnly, evmOnly);
    expect(await composed.getEvmAddress()).toBe('0xEEE');
  });

  it('routes getSolanaAddress to the Solana signer', async () => {
    const composed = composeSigners(evmOnly, solanaOnly);
    expect(await composed.getSolanaAddress!()).toBe('SolanaPubKey11111');
  });

  it('routes signSolanaTransaction to the signer that defines it', async () => {
    const composed = composeSigners(evmOnly, solanaOnly);
    const out = await composed.signSolanaTransaction!({
      transactionBase64: 'abcd',
      partialSign: true,
    });
    expect(out).toBe('signedTxBase64');
    expect(solanaOnly.signSolanaTransaction).toHaveBeenCalled();
  });

  it('propagates the last error if no signer can service the call', async () => {
    const noEvmNoEip712: PaymentSigner = {
      getEvmAddress: async () => {
        throw new Error('no evm');
      },
      signTypedData: async <TMessage>(_: TypedDataEnvelope<TMessage>): Promise<string> => {
        throw new Error('nope');
      },
    };
    const composed = composeSigners(noEvmNoEip712, solanaOnly);
    await expect(
      composed.signTypedData({
        domain: {},
        types: {},
        primaryType: 'X',
        message: {},
      })
    ).rejects.toThrow(/solana cannot sign eip712|nope/);
  });
});
