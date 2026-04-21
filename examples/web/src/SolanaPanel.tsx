/**
 * Solana (Phantom) payment panel.
 *
 * Uses `@solana/wallet-adapter-react` to connect the user's wallet, and
 * wraps the connected adapter with `solanaSigner` to feed MoltsPayWebClient.
 *
 * The panel renders inside a `WalletProvider` installed at the App level.
 * The Connect button is a plain HTML button that calls `wallet.connect()`
 * on the Phantom adapter directly — no `@solana/wallet-adapter-react-ui`
 * dep, to keep the demo bundle small.
 */

import { useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import {
  MoltsPayWebClient,
  solanaSigner,
  PaymentRejectedError,
  UnsupportedChainError,
  ServerError,
  type ChainName,
  type SolanaSignerAdapter,
} from 'moltspay/web';
import { Result, type PayState } from './components/Result';
import { txExplorerUrl } from './components/explorer';

interface Props {
  serverUrl: string;
  acceptedChains: ChainName[];
}

const SOLANA_CHAINS: ChainName[] = ['solana', 'solana_devnet'];

const styles = {
  panel: {
    padding: 16,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--panel)',
  },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const },
  label: { display: 'block', color: 'var(--muted)', fontSize: 12, marginTop: 10, marginBottom: 4 },
  input: {
    width: '100%',
    padding: '8px 10px',
    background: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    boxSizing: 'border-box' as const,
  },
  textarea: {
    width: '100%',
    height: 100,
    padding: '8px 10px',
    background: 'var(--bg)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontSize: 13,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    boxSizing: 'border-box' as const,
    resize: 'vertical' as const,
  },
  button: {
    padding: '8px 14px',
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 500,
  },
  muted: { color: 'var(--muted)', fontSize: 12 },
};

export function SolanaPanel({ serverUrl, acceptedChains }: Props) {
  const wallet = useWallet();
  const [serviceId, setServiceId] = useState('video');
  const [paramsText, setParamsText] = useState('{\n  "prompt": "a cat dancing"\n}');
  const [chain, setChain] = useState<ChainName>('solana_devnet');
  const [state, setState] = useState<PayState>({ kind: 'idle' });

  const client = useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    // `useWallet`'s WalletContextState is broader than what we need. Narrow
    // it to SolanaSignerAdapter so solanaSigner's contract is explicit.
    const adapter: SolanaSignerAdapter = {
      publicKey: wallet.publicKey,
      signTransaction: wallet.signTransaction as SolanaSignerAdapter['signTransaction'],
    };
    return new MoltsPayWebClient({ signer: solanaSigner(adapter) });
  }, [wallet.publicKey, wallet.signTransaction]);

  async function connect() {
    try {
      if (!wallet.wallet) {
        // Auto-select the first available wallet (Phantom in our provider list).
        if (wallet.wallets[0]) {
          wallet.select(wallet.wallets[0].adapter.name);
        } else {
          setState({
            kind: 'error',
            message: 'No Solana wallet detected. Install Phantom or another adapter-compatible wallet.',
          });
          return;
        }
      }
      await wallet.connect();
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }

  async function pay() {
    if (!client || !wallet.publicKey) {
      setState({ kind: 'error', message: 'No Solana wallet connected' });
      return;
    }
    let params: Record<string, unknown>;
    try {
      params = JSON.parse(paramsText);
    } catch (err) {
      setState({ kind: 'error', message: `Invalid JSON in params: ${(err as Error).message}` });
      return;
    }
    setState({ kind: 'signing' });
    try {
      const result = await client.pay(serverUrl, serviceId, params, { chain });
      setState({ kind: 'waiting' });
      const txHash =
        (result as { transaction?: string; payment?: { transaction?: string } }).payment
          ?.transaction ?? (result as { transaction?: string }).transaction;
      setState({
        kind: 'success',
        payload: result,
        txHash,
        explorerUrl: txHash ? txExplorerUrl(chain, txHash) : undefined,
      });
    } catch (err) {
      handleError(err);
    }
  }

  function handleError(err: unknown) {
    if (err instanceof UnsupportedChainError) {
      setState({ kind: 'error', code: 'UNSUPPORTED_CHAIN', message: err.message });
      return;
    }
    if (err instanceof PaymentRejectedError) {
      setState({ kind: 'error', code: 'PAYMENT_REJECTED', message: err.message });
      return;
    }
    if (err instanceof ServerError) {
      setState({ kind: 'error', code: `HTTP ${err.status}`, message: err.message });
      return;
    }
    setState({ kind: 'error', message: (err as Error).message ?? String(err) });
  }

  const availableChains = acceptedChains.length > 0
    ? SOLANA_CHAINS.filter((c) => acceptedChains.includes(c))
    : SOLANA_CHAINS;

  return (
    <div style={styles.panel}>
      <h2 style={{ marginTop: 0 }}>Solana (Phantom)</h2>
      <div style={styles.row}>
        {wallet.publicKey ? (
          <span style={styles.muted}>
            Connected: <code>{wallet.publicKey.toBase58()}</code>
          </span>
        ) : (
          <button style={styles.button} onClick={connect}>
            {wallet.connecting ? 'Connecting…' : 'Connect Phantom'}
          </button>
        )}
      </div>

      <label style={styles.label}>Chain</label>
      <select
        style={styles.input}
        value={chain}
        onChange={(e) => setChain(e.target.value as ChainName)}
      >
        {availableChains.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <label style={styles.label}>Service ID</label>
      <input style={styles.input} value={serviceId} onChange={(e) => setServiceId(e.target.value)} />

      <label style={styles.label}>Params (JSON)</label>
      <textarea
        style={styles.textarea}
        value={paramsText}
        onChange={(e) => setParamsText(e.target.value)}
      />

      <div style={{ ...styles.row, marginTop: 12 }}>
        <button
          style={styles.button}
          onClick={pay}
          disabled={!wallet.publicKey || state.kind === 'signing' || state.kind === 'waiting'}
        >
          Pay
        </button>
      </div>

      <Result state={state} />
    </div>
  );
}
