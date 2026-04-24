/**
 * Verifies MoltsPayWebClient `solanaRpc` option threads the overridden URL
 * into every Solana `Connection`. Required because `api.mainnet-beta.solana.com`
 * now 403s browsers; customers must be able to supply Helius / QuickNode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const capturedUrls: string[] = [];

vi.mock('@solana/web3.js', async () => {
  const actual = await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  class MockConnection {
    constructor(url: string, _commitment?: string) {
      capturedUrls.push(url);
    }
    async getBalance() {
      return 1_000_000_000;
    }
  }
  return { ...actual, Connection: MockConnection };
});

import { MoltsPayWebClient, type PaymentSigner } from '../../../src/client/web/index.js';

function solanaSigner(address: string): PaymentSigner {
  return {
    getEvmAddress: vi.fn(async () => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    getSolanaAddress: vi.fn(async () => address),
    signTypedData: vi.fn(),
  };
}

describe('MoltsPayWebClient.getBalance — solanaRpc override', () => {
  beforeEach(() => {
    capturedUrls.length = 0;
  });

  it('uses overridden RPC URL on Solana mainnet', async () => {
    const client = new MoltsPayWebClient({
      signer: solanaSigner('11111111111111111111111111111111'),
      solanaRpc: { solana: 'https://helius.example/?api-key=X' },
    });
    const bal = await client.getBalance('solana');
    expect(bal.native).toBe(1);
    expect(capturedUrls).toContain('https://helius.example/?api-key=X');
    expect(capturedUrls).not.toContain('https://api.mainnet-beta.solana.com');
  });

  it('falls back to SOLANA_CHAINS default when override is omitted', async () => {
    const client = new MoltsPayWebClient({
      signer: solanaSigner('11111111111111111111111111111111'),
    });
    await client.getBalance('solana_devnet');
    expect(capturedUrls).toContain('https://api.devnet.solana.com');
  });

  it('per-chain override only affects the configured chain', async () => {
    const client = new MoltsPayWebClient({
      signer: solanaSigner('11111111111111111111111111111111'),
      solanaRpc: { solana: 'https://helius.example/?api-key=X' },
    });
    await client.getBalance('solana_devnet');
    expect(capturedUrls).toContain('https://api.devnet.solana.com');
    expect(capturedUrls).not.toContain('https://helius.example/?api-key=X');
  });
});
