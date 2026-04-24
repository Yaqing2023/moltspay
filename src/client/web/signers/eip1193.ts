/**
 * EIP-1193 signer adapter — wraps `window.ethereum`-style providers into the
 * runtime-agnostic `PaymentSigner` interface.
 *
 * Works with any EIP-1193 provider: MetaMask, Coinbase Wallet, Rainbow,
 * Frame, a WalletConnect transport, etc. The caller supplies the provider;
 * this module never imports a specific wallet connector.
 *
 * Methods used:
 *   - `eth_requestAccounts`         (getEvmAddress)
 *   - `eth_signTypedData_v4`        (signTypedData)
 *   - `wallet_switchEthereumChain`  (sendEvmTransaction pre-flight; EIP-3326)
 *   - `wallet_addEthereumChain`     (fallback when target chain is unknown; EIP-3085)
 *   - `eth_sendTransaction`         (sendEvmTransaction)
 */

import type { PaymentSigner } from '../../signer.js';
import type { TypedDataEnvelope } from '../../core/index.js';
import { PaymentRejectedError } from '../../core/index.js';

/** Minimal EIP-1193 provider shape. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
}

/**
 * Chain metadata passed alongside `sendEvmTransaction` so the signer can add
 * the chain to the wallet if it is not already known. Required for Tempo /
 * BNB which MetaMask does not ship preconfigured.
 *
 * Keyed by decimal chainId. The signer consults this table only when
 * `wallet_switchEthereumChain` returns the "unknown chain" error (code 4902).
 */
export interface Eip1193ChainMetadata {
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls?: string[];
}

export interface Eip1193SignerOptions {
  /** Optional chain registry for `wallet_addEthereumChain` fallbacks. */
  addChainMetadata?: Record<number, Eip1193ChainMetadata>;
}

/**
 * User-rejection EIP-1193 error codes. Mapped to `PaymentRejectedError`
 * so callers can distinguish explicit cancel from genuine failure.
 */
const USER_REJECTED_CODES = new Set([4001, -32603]);

function isUserRejection(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  return code !== undefined && USER_REJECTED_CODES.has(code);
}

function toHexChainId(chainId: number): string {
  return '0x' + chainId.toString(16);
}

/**
 * Build an EIP-1193-backed `PaymentSigner`.
 *
 * The returned signer is stateless — every method issues a fresh provider
 * request so account changes (user switches wallet, locks, etc.) are picked
 * up on the next call. The caller is free to wrap this in their own cache if
 * account drift mid-session is a concern.
 */
export function eip1193Signer(
  provider: Eip1193Provider,
  options: Eip1193SignerOptions = {}
): PaymentSigner {
  async function getEvmAddress(): Promise<string> {
    const accounts = (await provider.request({
      method: 'eth_requestAccounts',
    })) as string[];
    if (!accounts || accounts.length === 0) {
      throw new PaymentRejectedError('No EVM account available from provider');
    }
    return accounts[0];
  }

  async function ensureChainId(chainId: number): Promise<void> {
    const hexId = toHexChainId(chainId);
    try {
      const current = (await provider.request({ method: 'eth_chainId' })) as string;
      if (current?.toLowerCase() === hexId.toLowerCase()) return;
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hexId }],
      });
    } catch (err) {
      // EIP-3085: unknown chain — try to add it if the caller supplied metadata.
      const code = (err as { code?: number })?.code;
      if (code === 4902 || code === -32603) {
        const meta = options.addChainMetadata?.[chainId];
        if (!meta) {
          throw new Error(
            `Wallet does not know chainId ${chainId}. Provide addChainMetadata to eip1193Signer for automatic addition.`
          );
        }
        await provider.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: hexId,
              chainName: meta.chainName,
              rpcUrls: meta.rpcUrls,
              nativeCurrency: meta.nativeCurrency,
              blockExplorerUrls: meta.blockExplorerUrls,
            },
          ],
        });
        // After adding, MetaMask switches automatically; no second switch call needed.
        return;
      }
      if (isUserRejection(err)) {
        throw new PaymentRejectedError('User rejected chain switch');
      }
      throw err;
    }
  }

  return {
    getEvmAddress,

    async signTypedData<TMessage>(envelope: TypedDataEnvelope<TMessage>): Promise<string> {
      // Signing is chain-independent at the crypto layer, but MetaMask (and
      // some other EIP-1193 providers) throw "Provider is not connected to
      // the requested chain" on eth_signTypedData_v4 when the active chain
      // differs from envelope.domain.chainId. Switch first so the user's
      // wallet matches the x402 EIP-712 domain before the signature prompt.
      if (typeof envelope.domain?.chainId === 'number') {
        await ensureChainId(envelope.domain.chainId);
      }

      const from = await getEvmAddress();

      // eth_signTypedData_v4 expects a JSON envelope that includes the
      // implicit EIP712Domain type. Our core envelopes omit it, so we add
      // the minimal four-field form here. `salt` is not used anywhere in
      // the x402 domain set, so we don't include it in the type list.
      const typesForWire: Record<string, { name: string; type: string }[]> = {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
      };
      for (const [key, fields] of Object.entries(envelope.types)) {
        typesForWire[key] = [...fields];
      }

      const payload = JSON.stringify({
        domain: envelope.domain,
        types: typesForWire,
        primaryType: envelope.primaryType,
        message: envelope.message,
      });

      try {
        return (await provider.request({
          method: 'eth_signTypedData_v4',
          params: [from, payload],
        })) as string;
      } catch (err) {
        if (isUserRejection(err)) {
          throw new PaymentRejectedError('User rejected signature');
        }
        throw err;
      }
    },

    async sendEvmTransaction(args: {
      chainId: number;
      to: string;
      data: string;
      value?: string;
    }): Promise<string> {
      await ensureChainId(args.chainId);
      const from = await getEvmAddress();
      try {
        return (await provider.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from,
              to: args.to,
              data: args.data,
              ...(args.value ? { value: args.value } : {}),
            },
          ],
        })) as string;
      } catch (err) {
        if (isUserRejection(err)) {
          throw new PaymentRejectedError('User rejected transaction');
        }
        throw err;
      }
    },
  };
}
