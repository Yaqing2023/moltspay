/**
 * Result panel — unified UI for loading / success / error states across the
 * EVM and Solana panels. Intentionally small: the demo's job is to show
 * that a single `pay()` call works, not to be a polished transaction UI.
 */

import { type ReactNode } from 'react';

export type PayState =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | { kind: 'waiting' }
  | { kind: 'success'; payload: Record<string, unknown>; txHash?: string; explorerUrl?: string }
  | { kind: 'error'; message: string; code?: string; action?: { label: string; run: () => void | Promise<void> } };

interface Props {
  state: PayState;
}

const styles = {
  panel: {
    marginTop: 16,
    padding: 14,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--panel)',
    minHeight: 60,
  },
  label: { color: 'var(--muted)', fontSize: 12, marginBottom: 6 },
  value: { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const, fontSize: 13 },
  successTag: { color: 'var(--success)', fontWeight: 600 },
  errorTag: { color: 'var(--error)', fontWeight: 600 },
  warnTag: { color: 'var(--warn)', fontWeight: 600 },
  link: { color: 'var(--accent)' },
  button: {
    marginTop: 8,
    padding: '6px 12px',
    background: 'var(--accent)',
    color: 'white',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
  },
};

export function Result({ state }: Props) {
  let header: ReactNode;
  let body: ReactNode;

  switch (state.kind) {
    case 'idle':
      header = <div style={styles.label}>No payment yet</div>;
      body = <div style={styles.value}>Connect a wallet and submit a service to begin.</div>;
      break;

    case 'signing':
      header = <span style={styles.warnTag}>Awaiting wallet signature…</span>;
      body = <div style={styles.value}>Approve the typed-data prompt in your wallet.</div>;
      break;

    case 'waiting':
      header = <span style={styles.warnTag}>Settling on server…</span>;
      body = <div style={styles.value}>Server is verifying and submitting the payment.</div>;
      break;

    case 'success':
      header = <span style={styles.successTag}>Paid</span>;
      body = (
        <>
          {state.explorerUrl && state.txHash && (
            <div style={styles.value}>
              tx:{' '}
              <a href={state.explorerUrl} target="_blank" rel="noreferrer" style={styles.link}>
                {state.txHash}
              </a>
            </div>
          )}
          <div style={styles.value}>
            <strong>Result:</strong> <code>{JSON.stringify(state.payload, null, 2)}</code>
          </div>
        </>
      );
      break;

    case 'error':
      header = (
        <span style={styles.errorTag}>
          {state.code ? `${state.code}: ` : ''}Error
        </span>
      );
      body = (
        <>
          <div style={styles.value}>{state.message}</div>
          {state.action && (
            <button style={styles.button} onClick={() => state.action!.run()}>
              {state.action.label}
            </button>
          )}
        </>
      );
      break;
  }

  return (
    <div style={styles.panel}>
      <div style={{ marginBottom: 6 }}>{header}</div>
      {body}
    </div>
  );
}
