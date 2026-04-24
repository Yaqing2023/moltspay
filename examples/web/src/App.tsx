/**
 * App shell — top-level URL + chain discovery, panels for EVM and Solana.
 *
 * Layout:
 *   ┌────────────── Server URL + Discover ──────────────┐
 *   │ Provider + accepted chains                         │
 *   ├─────────── EvmPanel ────┬─── SolanaPanel ──────────┤
 *   │                         │                          │
 *   └─────────────────────────┴──────────────────────────┘
 *
 * The WalletProvider wrapper is only needed by the Solana branch but it's
 * cheap enough that we mount it at the top — wallet adapters are lazy and
 * don't load anything until `connect()` fires.
 */

import { useMemo, useState } from 'react';
import {
  ConnectionProvider,
  WalletProvider,
} from '@solana/wallet-adapter-react';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-wallets';
import {
  MoltsPayWebClient,
  eip1193Signer,
  type ChainName,
} from 'moltspay/web';
import { EvmPanel } from './EvmPanel';
import { SolanaPanel } from './SolanaPanel';

const DEFAULT_SERVER_URL = 'http://localhost:8402';
const SOLANA_DEVNET_RPC = 'https://api.devnet.solana.com';

const styles = {
  header: { marginBottom: 20 },
  h1: { marginBottom: 4 },
  subtitle: { color: 'var(--muted)', fontSize: 13, marginBottom: 16 },
  row: { display: 'flex', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    padding: '8px 10px',
    background: 'var(--panel)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
  button: {
    padding: '8px 14px',
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
  },
  accepted: { color: 'var(--muted)', fontSize: 12, marginTop: 8 },
  panels: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
    gap: 16,
    marginTop: 16,
  },
};

export function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [acceptedChains, setAcceptedChains] = useState<ChainName[]>([]);
  const [providerName, setProviderName] = useState<string | null>(null);
  const [discoverErr, setDiscoverErr] = useState<string | null>(null);

  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);

  /**
   * Fetch the provider's services manifest and extract the unique list of
   * `chain` values. This is used to constrain the chain dropdowns in each
   * panel so the user only sees chains the server will actually accept.
   */
  async function discover() {
    setDiscoverErr(null);
    try {
      // Build a throwaway client just for the read. No signer is needed for
      // `getServices` so we pass a no-op; passing real `window.ethereum` would
      // demand a wallet connection before the first RPC call.
      const anyEvmProvider =
        (window as unknown as { ethereum?: unknown }).ethereum ?? {
          request: async () => {
            throw new Error('No wallet');
          },
        };
      const client = new MoltsPayWebClient({
        signer: eip1193Signer(anyEvmProvider as Parameters<typeof eip1193Signer>[0]),
      });
      const services = await client.getServices(serverUrl);
      setProviderName(services.provider?.name ?? null);

      // Collect accepted chain names across all services + provider-level defaults.
      const chainSet = new Set<ChainName>();
      const maybeChainList =
        services.provider && (services.provider.chains ?? services.provider.chain);
      if (Array.isArray(maybeChainList)) {
        for (const entry of maybeChainList) {
          const name = typeof entry === 'string' ? entry : (entry as { chain?: string }).chain;
          if (name) chainSet.add(name as ChainName);
        }
      } else if (typeof maybeChainList === 'string') {
        chainSet.add(maybeChainList as ChainName);
      }
      setAcceptedChains([...chainSet]);
    } catch (err) {
      setDiscoverErr((err as Error).message);
    }
  }

  return (
    <ConnectionProvider endpoint={SOLANA_DEVNET_RPC}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <header style={styles.header}>
          <h1 style={styles.h1}>MoltsPay Web Demo</h1>
          <div style={styles.subtitle}>
            Reference implementation for <code>moltspay/web</code> — pay for x402 services from a browser wallet.
          </div>

          <div style={styles.row}>
            <input
              style={styles.input}
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://provider.example.com"
            />
            <button style={styles.button} onClick={discover}>
              Discover
            </button>
          </div>

          {providerName && (
            <div style={styles.accepted}>
              Provider: <strong>{providerName}</strong>
              {acceptedChains.length > 0 && (
                <>
                  {' '}· Accepts: <code>{acceptedChains.join(', ')}</code>
                </>
              )}
            </div>
          )}
          {discoverErr && (
            <div style={{ ...styles.accepted, color: 'var(--error)' }}>
              Discovery failed: {discoverErr}
            </div>
          )}
        </header>

        <div style={styles.panels}>
          <EvmPanel serverUrl={serverUrl} acceptedChains={acceptedChains} />
          <SolanaPanel serverUrl={serverUrl} acceptedChains={acceptedChains} />
        </div>
      </WalletProvider>
    </ConnectionProvider>
  );
}
