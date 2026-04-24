/**
 * eip1193Signer adapter — unit tests with a mocked EIP-1193 provider.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  eip1193Signer,
  type Eip1193Provider,
} from '../../../src/client/web/signers/eip1193.js';
import { PaymentRejectedError } from '../../../src/client/core/errors.js';
import type { TypedDataEnvelope } from '../../../src/client/core/types.js';

function mockProvider(handlers: Record<string, (params: unknown) => unknown>): Eip1193Provider {
  return {
    request: vi.fn(async (args: { method: string; params?: unknown }) => {
      const handler = handlers[args.method];
      if (!handler) {
        throw new Error(`mock: unhandled method ${args.method}`);
      }
      return handler(args.params);
    }),
  };
}

const sampleEnvelope: TypedDataEnvelope = {
  domain: {
    name: 'USD Coin',
    version: '2',
    chainId: 8453,
    verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  types: {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  },
  primaryType: 'TransferWithAuthorization',
  message: {
    from: '0x1111111111111111111111111111111111111111',
    to: '0x2222222222222222222222222222222222222222',
    value: '500000',
    validAfter: '0',
    validBefore: '9999999999',
    nonce: '0x' + 'ab'.repeat(32),
  },
};

describe('eip1193Signer', () => {
  it('getEvmAddress returns the first account', async () => {
    const provider = mockProvider({
      eth_requestAccounts: () => ['0xAbc0000000000000000000000000000000000001'],
    });
    const signer = eip1193Signer(provider);
    expect(await signer.getEvmAddress()).toBe('0xAbc0000000000000000000000000000000000001');
  });

  it('signTypedData builds a JSON envelope with EIP712Domain prepended', async () => {
    let seen: unknown;
    const provider = mockProvider({
      eth_requestAccounts: () => ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      eth_chainId: () => '0x2105', // 8453 — already on Base, ensureChainId no-ops
      eth_signTypedData_v4: (params) => {
        seen = params;
        return '0xdeadbeef';
      },
    });
    const signer = eip1193Signer(provider);
    const sig = await signer.signTypedData(sampleEnvelope);
    expect(sig).toBe('0xdeadbeef');
    expect(Array.isArray(seen)).toBe(true);
    const [from, payloadJson] = seen as [string, string];
    expect(from).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const payload = JSON.parse(payloadJson);
    expect(payload.primaryType).toBe('TransferWithAuthorization');
    expect(payload.types.EIP712Domain).toBeDefined();
    expect(payload.types.EIP712Domain.map((f: { name: string }) => f.name)).toEqual([
      'name', 'version', 'chainId', 'verifyingContract',
    ]);
    expect(payload.domain.chainId).toBe(8453);
  });

  it('signTypedData rejection surfaces as PaymentRejectedError', async () => {
    const provider = mockProvider({
      eth_requestAccounts: () => ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      eth_chainId: () => '0x2105',
      eth_signTypedData_v4: () => {
        const err: Error & { code?: number } = new Error('User rejected');
        err.code = 4001;
        throw err;
      },
    });
    const signer = eip1193Signer(provider);
    await expect(signer.signTypedData(sampleEnvelope)).rejects.toBeInstanceOf(
      PaymentRejectedError
    );
  });

  it('sendEvmTransaction switches chain when already on it it is a no-op', async () => {
    const switchCalls: unknown[] = [];
    const provider = mockProvider({
      eth_chainId: () => '0x2105', // 8453 hex
      wallet_switchEthereumChain: (params) => {
        switchCalls.push(params);
        return null;
      },
      eth_requestAccounts: () => ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      eth_sendTransaction: () => '0xsent',
    });
    const signer = eip1193Signer(provider);
    const hash = await signer.sendEvmTransaction!({
      chainId: 8453,
      to: '0xbb',
      data: '0x',
    });
    expect(hash).toBe('0xsent');
    // Already on chain 8453 → skip switch.
    expect(switchCalls).toHaveLength(0);
  });

  it('sendEvmTransaction adds unknown chain via EIP-3085 metadata', async () => {
    const addCalls: unknown[] = [];
    const provider = mockProvider({
      eth_chainId: () => '0x1', // on Ethereum mainnet
      wallet_switchEthereumChain: () => {
        const err: Error & { code?: number } = new Error('Unknown chain');
        err.code = 4902;
        throw err;
      },
      wallet_addEthereumChain: (params) => {
        addCalls.push(params);
        return null;
      },
      eth_requestAccounts: () => ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      eth_sendTransaction: () => '0xok',
    });
    const signer = eip1193Signer(provider, {
      addChainMetadata: {
        56: {
          chainName: 'BNB Smart Chain',
          rpcUrls: ['https://bsc-dataseed.binance.org'],
          nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
          blockExplorerUrls: ['https://bscscan.com'],
        },
      },
    });
    const hash = await signer.sendEvmTransaction!({
      chainId: 56,
      to: '0xcc',
      data: '0x',
    });
    expect(hash).toBe('0xok');
    expect(addCalls).toHaveLength(1);
    expect((addCalls[0] as Array<{ chainId: string }>)[0].chainId).toBe('0x38');
  });

  it('sendEvmTransaction throws informatively when unknown chain has no metadata', async () => {
    const provider = mockProvider({
      eth_chainId: () => '0x1',
      wallet_switchEthereumChain: () => {
        const err: Error & { code?: number } = new Error('Unknown chain');
        err.code = 4902;
        throw err;
      },
    });
    const signer = eip1193Signer(provider);
    await expect(
      signer.sendEvmTransaction!({ chainId: 42431, to: '0x0', data: '0x' })
    ).rejects.toThrow(/chainId 42431/);
  });
});
