/**
 * Tiny chain → block-explorer-tx-URL mapper used by the Result panel.
 * Kept standalone so the main App file stays focused on orchestration.
 */

import type { ChainName } from 'moltspay/web';

const TX_EXPLORERS: Record<ChainName, (hash: string) => string> = {
  base: (h) => `https://basescan.org/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  base_sepolia: (h) => `https://sepolia.basescan.org/tx/${h}`,
  tempo_moderato: (h) => `https://explore.testnet.tempo.xyz/tx/${h}`,
  bnb: (h) => `https://bscscan.com/tx/${h}`,
  bnb_testnet: (h) => `https://testnet.bscscan.com/tx/${h}`,
  solana: (h) => `https://solscan.io/tx/${h}`,
  solana_devnet: (h) => `https://solscan.io/tx/${h}?cluster=devnet`,
};

export function txExplorerUrl(chain: ChainName, hash: string): string {
  return TX_EXPLORERS[chain](hash);
}
