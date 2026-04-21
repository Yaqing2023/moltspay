# MoltsPay Web Demo

Minimal React + Vite reference app for `moltspay/web`. Connect MetaMask or Phantom, discover an x402 provider's services, pay for one in the browser.

## What it does

- Calls `client.getServices(url)` and shows the provider + accepted chains.
- EVM panel: wraps `window.ethereum` (MetaMask / Rainbow / Frame / any EIP-1193 provider) with `eip1193Signer`. Supports all six EVM chains — Base, Polygon, Base Sepolia, Tempo Moderato, BNB, BNB Testnet. On Tempo, the client uses the EIP-2612 permit path automatically (no chain-switch prompt, settler submits).
- Solana panel: uses `@solana/wallet-adapter-react` with the Phantom adapter, wrapped via `solanaSigner`. Supports `solana` and `solana_devnet`.
- Result panel renders loading / signing / waiting / success / error states. On `NeedsApprovalError` for BNB, it offers a one-click `approveBnb()` button.

## Run

```bash
# From this directory
npm install
npm run dev
```

Vite serves on <http://localhost:5173>. Open the page, fill in the provider URL (default `https://moltspay.com/a/zen7`), click **Discover**, then connect a wallet in the appropriate panel.

## Important: use `moltspay/web` from source during dev

`vite.config.ts` aliases `moltspay/web` directly to `../../src/client/web/index.ts`. That means:

- Edits in the parent `src/` are reflected on the next HMR reload — no rebuild loop.
- If you want to test the published artifact instead, comment out the alias in `vite.config.ts` and run `npm run build` in the parent first. Then `moltspay/web` resolves to `../../dist/client/web/index.mjs` via the package.json `exports` field.

## Wallets tested

| Chain | Wallet | Status |
|-------|--------|--------|
| Base / Polygon / Base Sepolia | MetaMask | Happy path confirmed via unit tests; live browser QA pending (tracked in design doc Phase 6). |
| BNB / BNB Testnet | MetaMask | Approve → pay flow; requires ~0.001 BNB for the one-time approve tx. |
| Tempo Moderato | MetaMask | Pure EIP-712 permit; no chain switch prompt, no user gas. |
| Solana / Solana Devnet | Phantom | Wallet-adapter `signTransaction` path; server fee-payer supported. |

## What this demo deliberately doesn't do

- **No WalletConnect / Coinbase Wallet SDK / Wagmi / RainbowKit.** The demo stays lean — `moltspay/web` accepts any EIP-1193 object, so BYO connector. Wiring a different provider is a one-line change.
- **No styling framework.** Plain inline styles + a few CSS custom properties in `index.html`. Borrow them or replace them.
- **No session persistence.** Reload = reconnect.
- **No multi-token selection.** Defaults to USDC (or pathUSD on Tempo); the wire protocol accepts USDT on Base / Polygon too if the provider advertises it, but adding that UI is out of scope for v1.

## Security posture

This demo shares the design posture of `moltspay/web` itself:
- **No private key ever held in browser memory.** Every signature comes from the user's wallet via the standard prompt.
- **No filesystem access.** The demo doesn't read or write any local file.
- **Optional `spendingLimits` are off.** External wallets already enforce per-signature policy; per-browser limits in `localStorage` give false comfort. The option exists if you want a session-level cap — see `SpendingLimitsConfig` in the SDK.
- **Provider CORS is required.** The provider at `serverUrl` must have `cors: true` (or explicit origin allowlist) in its `MoltsPayServer` config, or the 402 challenge won't reach the browser. Most `moltspay.com/a/*` providers are already configured that way.
