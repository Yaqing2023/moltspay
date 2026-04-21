/**
 * Chain identifier mapping — pure, runtime-agnostic.
 *
 * Translates between x402 `network` field values (CAIP-2 style, e.g.
 * `eip155:8453`, `solana:mainnet`) and MoltsPay's internal chain names
 * (e.g. `base`, `solana`, `tempo_moderato`).
 */

export type ChainName =
  | 'base'
  | 'polygon'
  | 'base_sepolia'
  | 'tempo_moderato'
  | 'bnb'
  | 'bnb_testnet'
  | 'solana'
  | 'solana_devnet';

const NETWORK_TO_CHAIN: Record<string, ChainName> = {
  'eip155:8453':   'base',
  'eip155:137':    'polygon',
  'eip155:84532':  'base_sepolia',
  'eip155:42431':  'tempo_moderato',
  'eip155:56':     'bnb',
  'eip155:97':     'bnb_testnet',
  'solana:mainnet': 'solana',
  'solana:devnet':  'solana_devnet',
};

const CHAIN_TO_NETWORK: Record<ChainName, string> = Object.fromEntries(
  Object.entries(NETWORK_TO_CHAIN).map(([network, chain]) => [chain, network])
) as Record<ChainName, string>;

/** Convert an x402 `network` identifier to a MoltsPay chain name, or null if unknown. */
export function networkToChainName(network: string): ChainName | null {
  return NETWORK_TO_CHAIN[network] ?? null;
}

/** Convert a MoltsPay chain name to its x402 `network` identifier. */
export function chainNameToNetwork(chain: ChainName): string {
  return CHAIN_TO_NETWORK[chain];
}

/** Check if an x402 `network` identifier is Solana (SVM). */
export function isSolanaNetwork(network: string): boolean {
  return network.startsWith('solana:');
}

/** List every supported chain name. */
export function listSupportedChains(): ChainName[] {
  return Object.keys(CHAIN_TO_NETWORK) as ChainName[];
}
