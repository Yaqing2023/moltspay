/**
 * EVM (EIP-1193) payment panel.
 *
 * Wraps `window.ethereum` with `eip1193Signer`, lets the user pick any of
 * the 6 EVM chains moltspay supports, and calls `MoltsPayWebClient.pay()`.
 *
 * Design choices:
 *  - We deliberately don't bring in WalletConnect / Coinbase Wallet SDK /
 *    Wagmi / RainbowKit — the demo is a reference for `moltspay/web` and
 *    should have the smallest possible dep graph around it.
 *  - Any EIP-1193 injected provider works (MetaMask, Rainbow, Frame, ...)
 *    thanks to the signer's duck typing.
 */

import { useMemo, useState } from 'react';
import {
  MoltsPayWebClient,
  eip1193Signer,
  NeedsApprovalError,
  PaymentRejectedError,
  UnsupportedChainError,
  ServerError,
  type ChainName,
  type Eip1193Provider,
} from 'moltspay/web';
import { Result, type PayState } from './components/Result';
import { txExplorerUrl } from './components/explorer';

const EVM_CHAINS: ChainName[] = [
  'base',
  'polygon',
  'base_sepolia',
  'tempo_moderato',
  'bnb',
  'bnb_testnet',
];

// Injected providers sometimes nest themselves under `window.ethereum.providers[]`
// when multiple wallets are present. This picks the first MetaMask-like one; if
// the user has only one wallet, `window.ethereum` itself is used.
function detectProvider(): Eip1193Provider | null {
  const eth = (window as unknown as { ethereum?: Eip1193Provider & { providers?: Eip1193Provider[] } }).ethereum;
  if (!eth) return null;
  if (eth.providers && eth.providers.length > 0) {
    return eth.providers[0];
  }
  return eth;
}

interface Props {
  serverUrl: string;
  acceptedChains: ChainName[];
}

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

export function EvmPanel({ serverUrl, acceptedChains }: Props) {
  const [address, setAddress] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState('video');
  const [paramsText, setParamsText] = useState('{\n  "prompt": "a cat dancing"\n}');
  const [chain, setChain] = useState<ChainName>('base');
  const [state, setState] = useState<PayState>({ kind: 'idle' });

  const provider = useMemo(detectProvider, []);
  const client = useMemo(
    () =>
      provider
        ? new MoltsPayWebClient({
            signer: eip1193Signer(provider, {
              addChainMetadata: {
                // Tempo Moderato — not in MetaMask's default list.
                42431: {
                  chainName: 'Tempo Moderato',
                  rpcUrls: ['https://rpc.moderato.tempo.xyz'],
                  nativeCurrency: { name: 'Tempo', symbol: 'tTEMPO', decimals: 18 },
                  blockExplorerUrls: ['https://explore.testnet.tempo.xyz'],
                },
                // BNB testnet
                97: {
                  chainName: 'BNB Testnet',
                  rpcUrls: ['https://data-seed-prebsc-1-s1.binance.org:8545'],
                  nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 },
                  blockExplorerUrls: ['https://testnet.bscscan.com'],
                },
              },
            }),
          })
        : null,
    [provider]
  );

  async function connect() {
    if (!provider) {
      setState({ kind: 'error', message: 'No EIP-1193 provider detected. Install MetaMask (or similar).' });
      return;
    }
    try {
      const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
      setAddress(accounts[0] ?? null);
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }

  async function pay() {
    if (!client) {
      setState({ kind: 'error', message: 'No wallet connected' });
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
        (result as { txHash?: string; transaction?: string; payment?: { transaction?: string } })
          .txHash ??
        (result as { transaction?: string }).transaction ??
        (result as { payment?: { transaction?: string } }).payment?.transaction;
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
    if (err instanceof NeedsApprovalError) {
      const d = err.details;
      setState({
        kind: 'error',
        code: 'NEEDS_APPROVAL',
        message: `Allowance ${d.currentAllowance} < required ${d.required} for spender ${d.spender}.`,
        action: {
          label: `Approve ${d.token} on ${d.chain}`,
          run: async () => {
            try {
              setState({ kind: 'signing' });
              await client!.approveBnb({
                chain: d.chain as 'bnb' | 'bnb_testnet',
                spender: d.spender,
                token: d.token as 'USDC' | 'USDT',
              });
              setState({
                kind: 'success',
                payload: { message: 'Approval sent. Retry the payment.' },
              });
            } catch (inner) {
              handleError(inner);
            }
          },
        },
      });
      return;
    }
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
    ? EVM_CHAINS.filter((c) => acceptedChains.includes(c))
    : EVM_CHAINS;

  return (
    <div style={styles.panel}>
      <h2 style={{ marginTop: 0 }}>EVM (MetaMask)</h2>
      <div style={styles.row}>
        {address ? (
          <span style={styles.muted}>
            Connected: <code>{address}</code>
          </span>
        ) : (
          <button style={styles.button} onClick={connect}>
            Connect MetaMask
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
        <button style={styles.button} onClick={pay} disabled={!address || state.kind === 'signing' || state.kind === 'waiting'}>
          Pay
        </button>
      </div>

      <Result state={state} />
    </div>
  );
}
