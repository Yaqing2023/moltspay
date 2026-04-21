import { describe, it, expect } from 'vitest';
import {
  networkToChainName,
  chainNameToNetwork,
  isSolanaNetwork,
  listSupportedChains,
  type ChainName,
} from '../../../src/client/core/chain-map.js';

describe('chain-map', () => {
  const pairs: [string, ChainName][] = [
    ['eip155:8453',    'base'],
    ['eip155:137',     'polygon'],
    ['eip155:84532',   'base_sepolia'],
    ['eip155:42431',   'tempo_moderato'],
    ['eip155:56',      'bnb'],
    ['eip155:97',      'bnb_testnet'],
    ['solana:mainnet', 'solana'],
    ['solana:devnet',  'solana_devnet'],
  ];

  it('round-trips every supported chain', () => {
    for (const [network, chain] of pairs) {
      expect(networkToChainName(network)).toBe(chain);
      expect(chainNameToNetwork(chain)).toBe(network);
    }
  });

  it('returns null for unknown networks', () => {
    expect(networkToChainName('eip155:1')).toBeNull();
    expect(networkToChainName('eip155:99999')).toBeNull();
    expect(networkToChainName('not-a-network')).toBeNull();
    expect(networkToChainName('')).toBeNull();
  });

  it('detects Solana networks', () => {
    expect(isSolanaNetwork('solana:mainnet')).toBe(true);
    expect(isSolanaNetwork('solana:devnet')).toBe(true);
    expect(isSolanaNetwork('eip155:8453')).toBe(false);
  });

  it('lists all 8 supported chains', () => {
    const chains = listSupportedChains();
    expect(chains).toHaveLength(8);
    expect(chains).toEqual(
      expect.arrayContaining([
        'base', 'polygon', 'base_sepolia',
        'tempo_moderato', 'bnb', 'bnb_testnet',
        'solana', 'solana_devnet',
      ])
    );
  });
});
