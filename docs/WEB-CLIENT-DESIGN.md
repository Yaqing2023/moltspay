# MoltsPay Web Client Design

Add a browser-native client so web applications can pay for x402 services using the user's external wallet (MetaMask, Coinbase Wallet, Phantom, etc.).

## Summary

| Decision | Choice |
|----------|--------|
| Wallet source | External wallets only (EIP-1193 for EVM, Wallet Adapter for Solana) |
| Embedded wallet | Not supported (no private key ever handled in browser) |
| Chains in scope | **All 8 supported chains**: Base, Polygon, Base Sepolia, BNB, BNB Testnet, Solana, Solana Devnet, **Tempo Moderato (via EIP-2612 permit, verified 2026-04-21)** |
| Chains deferred | None |
| Package layout | Single `moltspay` package, new `./web` subpath export |
| Code sharing | Extract pure protocol logic into `src/client/core/` shared by Node + Web |
| Demo framework | React + Vite single-page app |
| Spending limits | Off by default on Web (optional, localStorage-backed when enabled) |
| Server requirement | `MoltsPayServer` gains CORS support (required for browsers) |
| Release | `moltspay@1.6.0` on npm (minor, backwards compatible) |

## Goals

- Let browser apps call `client.pay(serverUrl, serviceId, params, { chain })` end-to-end with one external-wallet signature.
- Zero private key material in browser code. No file system access. No `~/.moltspay/`.
- Keep `MoltsPayClient` (Node) API unchanged — this is purely additive.
- Reuse a single implementation of the x402 flow (402 parsing, header construction, chain selection) across Node and Web via a `PaymentSigner` abstraction.
- Ship a working React demo that connects MetaMask or Phantom, discovers services, and pays on every supported chain (all 8 including Tempo).

## Non-goals

- No WalletConnect / Coinbase Wallet / RainbowKit connector UI bundled in the package. Applications bring their own connector; we accept an EIP-1193 provider object.
- No Solana wallet-selection UI bundled; applications bring their own `WalletAdapter`-compatible signer.
- No React hooks package in this release. Class-based API only. A thin `@moltspay/react` can follow later if demand emerges.
- No browser-side CDP / MCP / server code.
- No MPP (Machine Payments Protocol / `WWW-Authenticate: Payment`) flow in Web Client. Tempo is supported via the x402 + EIP-2612 permit path instead (see below).
- No on-ramp / faucet / CLI command equivalents in the browser.

## Impact on Existing Deployments

This work is **purely additive**. Upgrading from `moltspay@1.5.x` to `1.6.0` with no config changes produces byte-identical runtime behavior for every current code path.

### Node / CLI users

| Surface | Impact |
|---------|--------|
| `MoltsPayClient` public API (constructor, methods, return shapes, error messages) | None |
| `npx moltspay init / fund / pay / status / approve / faucet / services` | None |
| `~/.moltspay/wallet.json`, `config.json`, `spending.json`, `wallet-solana.json` | Format unchanged, location unchanged |
| `import { MoltsPayClient } from 'moltspay'` | Continues to work |
| `import { MoltsPayClient } from 'moltspay/client'` | Continues to work (subpath retained, re-routed to Node implementation internally) |
| Deep imports like `moltspay/dist/client/index.js` | Would break — but this was never a supported path. If we discover any real consumer doing this, we add a forwarding stub. Default: do not add. |

Internal file moves (`src/client/index.ts` → `src/client/node/index.ts`, new `src/client/core/`) are invisible through the package's `exports` field.

### Detailed per-phase impact on CLI

Bottom line: **none of the 8 phases touches CLI behavior, commands, UX, wire protocol, or wallet files.** A `moltspay@1.5.x` user can upgrade to `1.6.0` with zero config or filesystem changes. This table walks through each phase concretely.

| Phase | Change | CLI impact |
|-------|--------|------------|
| **1. Core extraction** | Move `src/client/index.ts` → `src/client/node/index.ts`; add `src/client/core/` | Source path change only. Three internal imports (`src/index.ts`, `src/cli/index.ts`, `src/mcp/server.ts`) get updated, OR a one-line re-export shim stays at `src/client/index.ts`. Published package surface unchanged. **User-visible change: none.** |
| **2. PaymentSigner abstraction** | Introduce `PaymentSigner` interface; `MoltsPayClient.pay()` delegates to an injected `NodeSigner` | Internal refactor. `NodeSigner` reads `~/.moltspay/wallet.json` on construction, produces the same signatures as today's inline `new Wallet(...)`. `MoltsPayClient` public API — constructor, methods, return shapes, error messages — byte-identical. |
| **3. Server CORS + Tempo permit** | `cors` option (default `false`); fix `pathUSD` → `PathUSD` domain typo; `TempoFacilitator` gains permit dispatch; 402 response advertises `tempoSpender` | Server-side change. CLI is a client, does not run server code. **When CLI calls an upgraded server**, the server still emits `WWW-Authenticate: Payment ...` exactly as before; CLI's `if (wwwAuth?.includes('payment')) → handleMPPPayment` branch at `src/client/index.ts:235` triggers as always, ignoring the newly-added `scheme: "permit"` entry in the x402 `accepts` array. |
| **4. Web Client** | New code under `src/client/web/` | Entirely separate tree. CLI source never imports from `web/`. |
| **5. Build & Package** | `tsup.config.ts` dual build; `package.json` adds `./web` export | `./client` subpath preserved; `bin: moltspay` still resolves to `dist/cli/index.js`. |
| **6. React Demo** | New `examples/web/` folder | Unrelated. |
| **7. Docs** | README / AGENTS.md / this design doc | Unrelated. |
| **8. Release** | `npm publish 1.6.0` | Minor version bump, semver-compatible. |

#### CLI's Tempo flow: current vs. after 1.6.0

Every step in the CLI's MPP path is preserved byte-for-byte. The table below shows what the CLI does at each stage of a Tempo payment today and after Phase 3 ships:

| Step | CLI today (`1.5.x`) | CLI after upgrade (`1.6.x`) | Change? |
|------|---------------------|------------------------------|---------|
| Initial request | `POST /execute` | `POST /execute` | No |
| 402 response | Receives `X-Payment-Required` + `WWW-Authenticate: Payment ...` | Same (server continues dual-emit) | No |
| Protocol routing | `wwwAuth?.includes('payment') → handleMPPPayment` | Same | No |
| Challenge parsing | Parse `id` / `method` / `request` params | Same | No |
| On-chain submit | `viem/tempo` `Actions.token.transfer(...)` | Same | No |
| Confirmation | `waitForTransactionReceipt` | Same | No |
| Credential build | `{ challenge, payload: { hash, type: 'hash' }, source: 'did:pkh:eip155:42431:...' }` | Same | No |
| Retry request | `Authorization: Payment <base64url>` | Same | No |
| Server verification | `TempoFacilitator.verify()` reads receipt, validates Transfer event | Same (permit is a separate dispatch branch, invisible to `{txHash, chainId}` payloads) | No |

#### TempoFacilitator dispatch (Phase 3, pseudocode)

```ts
async verify(payload: X402PaymentPayload, req): Promise<VerifyResult> {
  const inner = payload.payload;
  if ('txHash' in inner)  return this.verifyTxHash(inner, req);   // existing CLI / MPP path
  if ('permit'  in inner) return this.verifyPermit(inner, req);   // new Web Client path
  return { valid: false, error: 'Unknown payload shape' };
}
```

The CLI always sends `{ txHash, chainId }` (see `src/server/index.ts:780-784`), so it always takes the first branch. The new branch exists but is unreachable from CLI traffic.

#### Can CLI opt into the new permit path later?

Yes — as a free side effect, because `core/eip2612.ts` and `NodeSigner` are runtime-agnostic. Not done by default in `1.6.0`:

| Action | Planned? | Rationale |
|--------|----------|-----------|
| Default-switch CLI Tempo payments from MPP → permit | No | Would violate the "CLI behavior unchanged" guarantee of this release. |
| Hidden flag `moltspay pay ... --tempo-mode=permit` | Optional, Phase 4 or v1.7 | Lets power users / QA exercise the new path on Node without disruption. |
| Deprecate CLI MPP path | Not before v1.7 earliest | Observe permit stability in production first. |

#### Risks to CLI already mitigated

| Potential risk | Mitigation already in the design |
|----------------|----------------------------------|
| Phase 1 file move breaks external deep imports like `moltspay/dist/client/index.js` | `package.json` `exports` field masks internal paths; add a forwarding stub only if a real consumer is found. |
| `pathUSD` → `PathUSD` domain fix changes existing EIP-712 signature outputs | Current CLI MPP path never calls `getTokenDomain()` for Tempo signing — the stale value was dead code. Fix is a no-op at runtime for 1.5.x CLI. |
| Server CORS default changes something | Default `cors: false` mirrors 1.5.x exactly; CLI traffic is not browser-origin so CORS headers are irrelevant either way. |
| `registry.verify()` extra dispatch branch slows things down | Single `if ('txHash' in inner)` check, negligible overhead. |

#### What a CLI user must do to upgrade

Nothing beyond running the upgrade command:

```bash
npm i -g moltspay@1.6.0        # or update project devDependency
```

Specifically **no** action required on:

- Wallet migration — `~/.moltspay/wallet.json` format unchanged
- Re-init — existing wallet still works
- BNB re-approval — allowance state on-chain is unaffected
- Provider config — `moltspay.services.json` schema unchanged
- Faucet re-collection — testnet balances persist

### Server operators (providers running `MoltsPayServer`)

**The server code flow does not change for non-Tempo traffic.** A Web Client's request to Base / Polygon / BNB / Solana is byte-identical to a Node Client's request — both use `src/client/core/` to build the `X-Payment` header, so the server cannot tell them apart.

**Tempo is the exception.** Web Client and Node CLI speak different wire protocols for Tempo:

| Aspect | Node CLI (all versions incl. 1.6.x default) | Web Client (new in 1.6.0) |
|--------|---------------------------------------------|---------------------------|
| URL hit | Service-specific endpoint (`/text-to-video` etc.) | `/execute` |
| Payment header | `Authorization: Payment <MPP credential, base64url>` | `X-Payment: <x402 payload, base64>` |
| x402 scheme in payload | N/A (MPP credential is a different format) | `"permit"` (new in 1.6.0) |
| Payment model | Pay-first (client submits TIP-20 tx, then sends hash) | Pay-for-success (server submits permit + transferFrom after signature) |

Server identifies the wire protocol by request headers and routes accordingly. Both paths reach the same `TempoFacilitator`, which dispatches on payload shape (`{txHash}` vs `{permit}`). See the "Tempo (`tempo_moderato`) — gasless via EIP-2612 permit" section for details.

**Also note:** in 1.5.x, the server's 402 response for `/execute` advertised a Tempo entry with `scheme: "exact"` (EIP-3009), but pathUSD does not implement EIP-3009 — that advertisement was unusable and no client could actually settle on it via `/execute`. Phase 3c replaces it with `scheme: "permit"`, which pathUSD does support. This is a **fix**, not a behavior regression, because no working code relied on the old advertisement.

| Server-facing surface | Impact |
|-----------------------|--------|
| `/services`, `/execute`, `/api/services`, `/registry/services` endpoints | Unchanged |
| x402 v2 `X-Payment` header format (`scheme` / `network` / `payload` / `accepted`) | Unchanged |
| EIP-3009 authorization payload structure | Unchanged |
| BNB `PaymentIntent` payload structure | Unchanged |
| Solana `signedTransaction` payload structure | Unchanged |
| 402 response (`X-Payment-Required`, `WWW-Authenticate`) | Unchanged |
| `moltspay.services.json` provider config schema | Unchanged |
| Facilitator configuration (CDP / BNB / Solana / Tempo) | Unchanged |
| Smart contracts, deployed facilitators | Unchanged — no redeployment |
| Wallet migrations, approval state | Unchanged — existing BNB approvals stay valid |

The **only** server-side addition is an opt-in CORS option on `MoltsPayServer`:

```ts
interface MoltsPayServerOptions {
  // existing fields unchanged...
  cors?: boolean | string[] | CorsOptions; // NEW — defaults to false
}
```

| `cors` value | Behavior |
|--------------|----------|
| unset / `false` (default) | No CORS headers emitted, no OPTIONS preflight handler — identical to current `1.5.x` behavior |
| `true` | Allow all origins (`Access-Control-Allow-Origin: *`) |
| `string[]` | Origin allowlist |
| `CorsOptions` object | Fine-grained control |

When enabled, the server additionally emits `Access-Control-Expose-Headers: X-Payment-Required, WWW-Authenticate`. Without this, browser fetch cannot read the 402 payment challenge — providers must opt in for Web Clients to work.

### What server operators need to do

| Scenario | Action required |
|----------|-----------------|
| Provider is only called by Node/CLI clients | None. Upgrade is a drop-in. |
| Provider wants to accept Web Client traffic | Add one line: `cors: true` or `cors: ['https://myapp.example.com']` |
| Third-party hosted providers we operate (e.g. `moltspay.com/a/...`) | We enable CORS as part of this rollout — external providers do so on their own schedule |

### Tests / CI gates before merging any phase

- All existing unit + integration tests pass unmodified.
- CLI end-to-end on Base Sepolia (init → faucet → pay → status) completes successfully.
- Provider receiving a Web Client payment sees identical payload fields to an equivalent CLI payment (byte-compare fixture).

Any phase failing these gates blocks the merge.

## Verified: Tempo pathUSD EIP-2612 Capability

Probe run against `https://rpc.moderato.tempo.xyz` on 2026-04-21. Every entry below is a direct observation from `eth_call` against contract `0x20c0000000000000000000000000000000000000`.

### Supported selectors

| Function | Selector | Result |
|----------|----------|--------|
| `name()` | `0x06fdde03` | Returns `"pathUSD"` |
| `symbol()` | `0x95d89b41` | Returns `"pathUSD"` |
| `decimals()` | `0x313ce567` | Returns `6` |
| `approve(address,uint256)` | `0x095ea7b3` | Returns `true` |
| `allowance(address,address)` | `0xdd62ed3e` | Returns `uint256` |
| `DOMAIN_SEPARATOR()` | `0x3644e515` | Returns `0xc601a8a9918b2bf5076e4a47925ebe14407230ba77dc84e248c15218a46ad6b4` |
| `nonces(address)` | `0x7ecebe00` | Returns `uint256` (EIP-2612) |
| **`permit(...)`** | **`0xd505accf`** | **Exists and executes** — zero-deadline call reverts with semantic error `"TIP20 token error: PermitExpired"`, proving the function dispatches and validates |

### Unsupported selectors

| Function | Selector | Evidence of absence |
|----------|----------|---------------------|
| `transferWithAuthorization(...)` (EIP-3009) | `0xe3ee160e` | Reverts with `UnknownSelector(bytes4)` custom error (`0xaa4bc69a` prefix), identical shape to `0xdeadbeef` nonsense-selector baseline |
| `authorizationState(address,bytes32)` (EIP-3009) | `0xe94a0102` | Same `UnknownSelector` revert shape |
| `eip712Domain()` (EIP-5267) | `0x84b0196e` | Same revert shape |
| `version()` | `0x54fd4d50` | Same revert shape |

### EIP-712 domain — all 4 Tempo TIP-20 tokens

Computed `DOMAIN_SEPARATOR` matched the on-chain value for every token. The pattern is consistent: `name` equals the on-chain symbol (first letter capitalized), `version` is always `"1"`.

| Token | Address | `domain.name` | `version` | On-chain `DOMAIN_SEPARATOR` |
|-------|---------|---------------|-----------|-----------------------------|
| pathUSD  | `0x20c0000000000000000000000000000000000000` | `"PathUSD"`  | `"1"` | `0xc601a8a9918b2bf5076e4a47925ebe14407230ba77dc84e248c15218a46ad6b4` |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` | `"AlphaUSD"` | `"1"` | `0x32d762f61205377e7b402fe1ef8014637c3b3a18234a5629cfab1982efdc2630` |
| BetaUSD  | `0x20c0000000000000000000000000000000000002` | `"BetaUSD"`  | `"1"` | `0x99a494a75ff574cc1ff179a3b4f4ec0aff55b51cdd0906994aa8e91bf95137d3` |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` | `"ThetaUSD"` | `"1"` | `0x657494dec20c65c40c636bb1781412e1dd3eb5aba55cd8dc8346a00753b9a782` |

Computation formula: `keccak256(abi.encode(typeHash("EIP712Domain(string,string,uint256,address)"), keccak256(name), keccak256("1"), 42431, tokenAddress))`.

### Live permit + transferFrom round-trip

Phase 0 additionally executed a real `permit()` + `transferFrom()` on pathUSD between two freshly-generated wallets (see "Phase 0 — Tempo probe validation" for full details). All state transitions matched expectations. Permit tx `0x4a112847...`, transferFrom tx `0xfe85b890...`.

### Implication

pathUSD is a Tempo-native **precompile** (not EVM bytecode — `eth_getCode` returns `0xef`, a 1-byte stub). It exposes ERC-20 + EIP-2612 permit, but not EIP-3009. This makes **permit the gasless path for Tempo**:

```
1. Browser signs EIP-2612 Permit typed data (owner, spender, value, nonce, deadline)
2. Signature -> server
3. Server calls pathUSD.permit(..., v, r, s) [consumes signature, sets allowance]
4. Server calls pathUSD.transferFrom(owner, payTo, value) [moves funds]
```

Functionally equivalent to EIP-3009 from the user's perspective (one signature prompt, no gas), just one extra cheap on-chain call on the server side.

### Server-side bugs found (all fixable in one PR as Phase 3b)

`src/server/index.ts:121-124` currently hardcodes for Tempo:

```ts
'eip155:42431': {
  USDC: { name: 'pathUSD',  version: '1' },   // ❌ should be 'PathUSD'
  USDT: { name: 'alphaUSD', version: '1' },   // ❌ should be 'AlphaUSD'
}
```

Both values are wrong. The correct on-chain names are `PathUSD` and `AlphaUSD` (first letter capitalized). These bugs are currently inert — Tempo today uses the MPP flow (tx-hash verification, no EIP-712 signing), so the stale values are never read at runtime — but they **must be fixed** before Web Client can settle via permit.

BetaUSD and ThetaUSD are not in the current server config but should be added when multi-token support on Tempo is expanded. Their domain names are available in the probe evidence above.

## Current State

The existing `MoltsPayClient` in `src/client/index.ts` is Node-only. Key couplings that block browser use:

| Coupling | Where | Impact |
|----------|-------|--------|
| File I/O for wallet | `loadWallet()`, `statSync`, `chmodSync` | `fs`/`os` absent in browser |
| Plaintext private key on disk | `new Wallet(this.walletData.privateKey)` | Unacceptable in browser |
| Solana wallet file | `loadSolanaWallet(this.configDir)` | Same |
| Config + spending files | `~/.moltspay/config.json`, `spending.json` | No filesystem |
| CLI-style error messages | `"Run: npx moltspay init"` | Meaningless in browser |
| `Buffer` usage | `Buffer.from(...).toString('base64')` | Polyfill needed or replace |
| Build target | `tsup` cjs+esm only, no browser platform | Bundle would pull Node APIs |

The x402 protocol itself is HTTP + headers + EIP-712 signatures. None of that is Node-specific. The only browser barrier is the private-key-on-disk assumption.

## Architecture

### Module layout

```
src/client/
  core/                      NEW — Pure protocol logic, zero Node APIs, runtime-agnostic
    index.ts
    x402.ts                    402 parsing, requirements selection, header (de)serialization
    eip3009.ts                 EIP-3009 TransferWithAuthorization typed-data builder (Base/Polygon/Base Sepolia)
    eip2612.ts                 EIP-2612 Permit typed-data builder (Tempo pathUSD)
    bnb-intent.ts              MoltsPay PaymentIntent typed-data builder (BNB)
    solana-tx.ts               SPL token transfer transaction builder
    chain-map.ts               networkToChainName, chain selection logic
    base64.ts                  Universal base64 (btoa / Buffer shim)
    errors.ts                  Structured error classes (see below)
    types.ts                   X402PaymentRequirements, EIP3009Authorization, Eip2612Permit, BnbIntent, etc.
  signer.ts                  NEW — PaymentSigner interface
  node/
    index.ts                   Existing MoltsPayClient, refactored to use core + NodeSigner
    signer.ts                  NodeSigner: ethers.Wallet + @solana/web3.js Keypair
  web/                       NEW
    index.ts                   MoltsPayWebClient
    signers/
      eip1193.ts               EIP-1193 (EVM) signer adapter
      solana-adapter.ts        Solana WalletAdapter signer adapter
    storage.ts                 Optional localStorage spending tracker
  types.ts                     Shared public types (ServicesResponse, ServiceInfo, etc. — mostly unchanged)
```

Paths are final; existing public exports of `MoltsPayClient` stay importable from `moltspay` (no breaking change).

### What moves to `core/`

From current `src/client/index.ts`, these extract cleanly:

| Current code | New home | Notes |
|--------------|----------|-------|
| 402 header decode + v1/v2 array/object dispatch | `core/x402.ts` | Pure parsing |
| `networkToChainName` | `core/chain-map.ts` | Pure |
| `networkToChainName` reverse + `eip155:<id>` construction | `core/chain-map.ts` | Pure |
| EIP-3009 typed-data structure (domain + types + message shape) | `core/eip3009.ts` | Returns `{ domain, types, message }` — signing happens in signer |
| **EIP-2612 Permit typed-data structure** (Tempo pathUSD) | **`core/eip2612.ts`** | **New module. Same `{ domain, types, message }` pattern. Used only for Tempo in this release.** |
| BNB PaymentIntent typed-data structure | `core/bnb-intent.ts` | Same pattern |
| `createSolanaPaymentTransaction` (already in `src/facilitators/solana.ts`) | Re-export via `core/solana-tx.ts` | Verify it has no Node dependencies; if it does, split |
| x-payment header assembly (base64 of payload) | `core/x402.ts` | Uses `core/base64.ts` |
| Body shape (`rawData` vs wrapped `{ service, params }`) | `core/x402.ts` | Helper |
| Server chain selection + validation (user vs accepted list) | `core/x402.ts` | Pure |

After extraction, the Node `MoltsPayClient.pay()` becomes a ~60-line orchestrator that delegates every non-I/O step to `core` and every signature to its injected `PaymentSigner`.

## PaymentSigner Interface

```ts
// src/client/signer.ts
import type { TypedDataDomain, TypedDataField } from './core/types.js';

export interface PaymentSigner {
  /** Return EVM address (0x-prefixed). Required for EVM chains. */
  getEvmAddress(): Promise<string>;

  /** Return Solana address (base58). Required when paying on Solana. */
  getSolanaAddress?(): Promise<string>;

  /** Sign EIP-712 typed data. Used for both EIP-3009 (gasless USDC/USDT) and BNB PaymentIntent. */
  signTypedData(args: {
    domain: TypedDataDomain;
    types: Record<string, TypedDataField[]>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<string>; // 0x-prefixed signature

  /**
   * Send a raw EVM transaction. Required only for BNB approve() flow.
   * Return transaction hash. May throw if signer can't submit (then caller falls back).
   */
  sendEvmTransaction?(args: {
    chainId: number;
    to: string;
    data: string;
    value?: string; // hex wei
  }): Promise<string>;

  /**
   * Sign a Solana transaction. Must not submit it — server submits.
   * Returns base64-encoded signed transaction.
   */
  signSolanaTransaction?(args: {
    transactionBase64: string;
    partialSign: boolean; // true when feePayer is server (gasless)
  }): Promise<string>;
}
```

### Why typed-data at this layer, not method-per-scheme

The EIP-3009 flow and the BNB intent flow both reduce to "sign an EIP-712 typed message." Exposing `signTypedData` keeps the interface small and lets the core builders in `core/eip3009.ts` and `core/bnb-intent.ts` emit identical shapes regardless of runtime. A thicker interface (`signEIP3009`, `signBnbIntent`) duplicates the domain/types construction in each signer and invites drift.

### Node signer

```ts
// src/client/node/signer.ts
export class NodeSigner implements PaymentSigner {
  constructor(private evmWallet: ethers.Wallet, private solanaKeypair?: Keypair) {}

  async getEvmAddress() { return this.evmWallet.address; }
  async getSolanaAddress() { return this.solanaKeypair?.publicKey.toBase58(); }

  async signTypedData({ domain, types, message }) {
    return this.evmWallet.signTypedData(domain, types, message);
  }

  async sendEvmTransaction({ chainId, to, data, value }) {
    // Build provider from chain registry, send tx, return hash
    ...
  }

  async signSolanaTransaction({ transactionBase64, partialSign }) {
    const tx = Transaction.from(Buffer.from(transactionBase64, 'base64'));
    partialSign ? tx.partialSign(this.solanaKeypair!) : tx.sign(this.solanaKeypair!);
    return tx.serialize({ requireAllSignatures: false }).toString('base64');
  }
}
```

### Web signers

```ts
// src/client/web/signers/eip1193.ts
export function eip1193Signer(provider: Eip1193Provider): PaymentSigner {
  return {
    async getEvmAddress() {
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      return accounts[0];
    },
    async signTypedData({ domain, types, primaryType, message }) {
      const from = await this.getEvmAddress();
      const payload = JSON.stringify({ domain, types: { EIP712Domain: [...], [primaryType]: types[primaryType] }, primaryType, message });
      return provider.request({ method: 'eth_signTypedData_v4', params: [from, payload] });
    },
    async sendEvmTransaction({ chainId, to, data, value }) {
      await ensureChainId(provider, chainId); // wallet_switchEthereumChain
      const from = await this.getEvmAddress();
      return provider.request({ method: 'eth_sendTransaction', params: [{ from, to, data, value }] });
    },
  };
}
```

```ts
// src/client/web/signers/solana-adapter.ts
export function solanaSigner(adapter: SolanaSignerAdapter): PaymentSigner {
  // SolanaSignerAdapter = Pick<WalletAdapter, 'publicKey' | 'signTransaction'>
  return {
    async getSolanaAddress() {
      if (!adapter.publicKey) throw new Error('Solana wallet not connected');
      return adapter.publicKey.toBase58();
    },
    async signSolanaTransaction({ transactionBase64 }) {
      const tx = Transaction.from(base64ToUint8Array(transactionBase64));
      const signed = await adapter.signTransaction(tx);
      return uint8ArrayToBase64(signed.serialize({ requireAllSignatures: false }));
    },
  };
}
```

## Public API

### Import paths

```ts
// Node (unchanged)
import { MoltsPayClient } from 'moltspay';

// Web (new)
import { MoltsPayWebClient, eip1193Signer, solanaSigner } from 'moltspay/web';
```

### Web client usage

```ts
import { MoltsPayWebClient, eip1193Signer } from 'moltspay/web';

const client = new MoltsPayWebClient({
  signer: eip1193Signer(window.ethereum),
});

const services = await client.getServices('https://provider.example.com');

const result = await client.pay(
  'https://provider.example.com',
  'text-to-video',
  { prompt: 'a cat dancing' },
  { chain: 'base' }
);
```

### Solana

```ts
import { MoltsPayWebClient, solanaSigner } from 'moltspay/web';
import { useWallet } from '@solana/wallet-adapter-react';

const wallet = useWallet();
const client = new MoltsPayWebClient({ signer: solanaSigner(wallet) });
await client.pay(url, 'svc', params, { chain: 'solana' });
```

### Dual (EVM + Solana) — composed signer

```ts
import { MoltsPayWebClient, composeSigners, eip1193Signer, solanaSigner } from 'moltspay/web';

const client = new MoltsPayWebClient({
  signer: composeSigners(eip1193Signer(window.ethereum), solanaSigner(phantomAdapter)),
});
```

`composeSigners` picks the underlying signer by which method is called. Useful when an app wants to offer both EVM and Solana in one session without re-instantiating the client.

### MoltsPayWebClient options

```ts
interface MoltsPayWebClientOptions {
  signer: PaymentSigner;

  /** Default chain when the server accepts more than one and no `chain` option is passed. Off by default. */
  defaultChain?: ChainName;

  /** Enable spending limits in the browser. Persisted to localStorage. Default: disabled. */
  spendingLimits?: {
    maxPerTx: number;
    maxPerDay: number;
    storageKey?: string; // default 'moltspay:spending'
  };

  /** Optional fetch override for testing or proxying. Default: global fetch. */
  fetch?: typeof fetch;
}
```

### Method surface

Intentionally narrower than the Node client:

| Method | In Web? | Notes |
|--------|---------|-------|
| `pay(url, service, params, options)` | Yes | Main entry — dispatches to EIP-3009 / EIP-2612 / BNB intent / Solana flow based on selected chain |
| `getServices(url)` | Yes | Discovery |
| `getBalance(chain?)` | Yes | Read-only RPC call via `ethers.JsonRpcProvider` or `Connection` — does not require signer |
| `approveBnb({ chain, spender, token, amount? })` | Yes | Needed for BNB; triggers wallet tx |
| Tempo (`tempo_moderato`) | Yes | Goes through `pay()` via EIP-2612 permit. Client ignores `WWW-Authenticate` and always reads `X-Payment-Required`. |
| `init()` (wallet creation) | No | Not applicable; wallet is external |
| `static init()` | No | Not exposed |
| `getAllBalances()` | Optional, phase 2 | |
| `payWithMPP()` | No | MPP flow not reimplemented in Web Client — Tempo uses EIP-2612 permit instead |

## Per-Chain Flows in Web Client

### EVM (Base / Polygon / Base Sepolia) — gasless via EIP-3009

1. Fetch services, find endpoint.
2. POST body → server returns 402 with `X-Payment-Required`.
3. Core decodes requirements, selects chain.
4. Core builds EIP-3009 typed data (domain = token's EIP-712 domain from `req.extra`, types = `TransferWithAuthorization`, message = authorization).
5. Signer signs typed data → 0x signature.
6. Core assembles x402 v2 payload → base64 → `X-Payment` header.
7. POST body again with header → result.

Identical to current Node flow, minus the file I/O for the wallet.

### BNB (BNB / BNB Testnet) — pre-approval + intent

1. Fetch services, POST body → 402 with `bnbSpender` in `req.extra`.
2. Web client reads on-chain allowance via JSON-RPC (read-only, no signer needed).
3. If allowance < amount: throw `NeedsApprovalError { chain, spender, token }`. App catches and calls `client.approveBnb({...})` which:
   - Switches wallet to BNB chain via `wallet_switchEthereumChain` (EIP-3326) / `wallet_addEthereumChain` (EIP-3085) if unknown.
   - Sends `approve(spender, maxUint256)` via `sendEvmTransaction`. Costs user gas in BNB. No way around this — matches current CLI behavior.
4. Build `PaymentIntent` typed data, sign via signer.
5. Assemble payload, POST with `X-Payment` header.

Error shape:

```ts
class NeedsApprovalError extends Error {
  code = 'NEEDS_APPROVAL';
  constructor(public details: { chain: ChainName; spender: string; token: TokenSymbol; currentAllowance: string; required: string }) {
    super(`Insufficient allowance for ${details.spender}. Call client.approveBnb(...) before retrying.`);
  }
}
```

### Solana — pay-for-success transfer

1. POST → 402 with `payTo`, `asset`, optional `solanaFeePayer` in `req.extra`.
2. Core builds SPL transfer transaction using sender public key from `signer.getSolanaAddress()`.
3. Client RPC call fills `recentBlockhash`.
4. `signer.signSolanaTransaction({ transactionBase64, partialSign: !!feePayer })` — wallet adapter prompts user.
5. Assemble payload (`signedTransaction`, `sender`, `chain`), POST with `X-Payment` header.
6. Server submits and settles; returns tx signature.

Wallet adapters implement `signTransaction(tx: Transaction): Promise<Transaction>`, which is all we need.

### Tempo (`tempo_moderato`) — gasless via EIP-2612 permit

**Deep dive:** [`TEMPO-WEB-SUPPORT.md`](./TEMPO-WEB-SUPPORT.md) contains the full Tempo-specific design — probe evidence, end-to-end timing diagram, per-step JSON payloads, component responsibilities, alternatives considered, and outstanding validation items. The summary below is a high-level recap for readers of the parent design doc.

Tempo's pathUSD is a native precompile implementing ERC-20 + EIP-2612 but **not** EIP-3009 (verified on-chain — see "Verified: Tempo pathUSD EIP-2612 Capability" above). Web Client therefore uses EIP-2612 permit instead of EIP-3009 for Tempo. From the user's perspective the UX is identical: one `signTypedData_v4` prompt, no wallet chain switch, no user gas.

**Why Web Client doesn't see MPP at all:** Web Client always POSTs to `/execute`, never to service-specific endpoints like `/text-to-video`. The server's MPP `WWW-Authenticate` header is only emitted by `sendMPPPaymentRequired()`, which runs inside `handleMPPRequest` — a handler that's only reachable via service-specific endpoint routing. `/execute` goes through `handleExecute` → `sendPaymentRequired()`, which emits only `X-Payment-Required`. So for Web Client, the MPP header simply never appears; there's nothing to "ignore."

**Flow:**

1. POST body → server returns 402 with `X-Payment-Required` (x402 v2 `accepts` array containing a Tempo entry with `scheme: "permit"`). No `WWW-Authenticate` header on this code path.
2. Core selects the Tempo requirement (`network: eip155:42431`).
3. Core fetches `nonces(owner)` from pathUSD via JSON-RPC (`https://rpc.moderato.tempo.xyz`). Read-only, no signer needed.
4. Core builds EIP-2612 Permit typed data:
   - `domain = { name: "PathUSD", version: "1", chainId: 42431, verifyingContract: 0x20c0... }`
   - `types = { Permit: [owner, spender, value, nonce, deadline] }`
   - `message = { owner, spender: <server's settler address from req.extra>, value, nonce, deadline: now + 3600 }`
5. Signer signs typed data → 0x signature (split into v/r/s by server).
6. Core assembles x402 v2 payload with `scheme: "permit"` (new sub-scheme under `exact`) carrying `{ permit: { owner, spender, value, nonce, deadline, v, r, s } }` → base64 → `X-Payment` header.
7. POST body again with header → server executes `pathUSD.permit(...)` + `pathUSD.transferFrom(owner, payTo, value)` → returns service result.

**Server-side prerequisites** (tracked in Phase 3):
- Fix EIP-712 domain name from `pathUSD` → `PathUSD` in `src/server/index.ts:122`.
- Verify alphaUSD domain name the same way before enabling USDT-on-Tempo.
- `TempoFacilitator` gains a permit-mode `verify/settle` path that recognizes the `scheme: "permit"` payload and executes the two calls on Tempo. The existing tx-hash mode is retained for backwards compatibility with Node CLI / MPP clients.
- Server must advertise its settler address in the 402 `req.extra.tempoSpender` field so the client knows what to put in the `spender` slot of the permit message.

**Why we ignore MPP in the browser:** MPP is pay-first (client submits on-chain tx, then hands server the hash). That requires the browser wallet to know Tempo, hold Tempo assets for gas, and submit a TIP-20 transfer — constraints that MetaMask / Coinbase Wallet / Rainbow don't meet cleanly today (Tempo's `feeToken` model is non-standard). EIP-2612 permit needs none of that: the wallet never touches Tempo, only signs typed data.

**USDT on Tempo (alphaUSD):** same flow, pending domain verification (see probe section).

## Error Classes

Structured errors in `core/errors.ts`. Replaces the CLI-flavored `throw new Error("Run: npx moltspay init")` strings.

```ts
export class MoltsPayError extends Error { code: string; }
export class NotInitializedError extends MoltsPayError { code = 'NOT_INITIALIZED'; }
export class UnsupportedChainError extends MoltsPayError { code = 'UNSUPPORTED_CHAIN'; }
export class NeedsApprovalError extends MoltsPayError { code = 'NEEDS_APPROVAL'; }
export class InsufficientBalanceError extends MoltsPayError { code = 'INSUFFICIENT_BALANCE'; }
export class SpendingLimitExceededError extends MoltsPayError { code = 'SPENDING_LIMIT_EXCEEDED'; }
export class PaymentRejectedError extends MoltsPayError { code = 'PAYMENT_REJECTED'; }
export class ServerError extends MoltsPayError { code = 'SERVER_ERROR'; status: number; }
```

All web client code throws these. Node client adopts them too (silent change — existing string matches still work because `err.message` stays descriptive).

## Package & Build Config

### `package.json`

```json
{
  "exports": {
    ".":         { "require": "./dist/index.js", "import": "./dist/index.mjs", "types": "./dist/index.d.ts" },
    "./server":  { "require": "./dist/server/index.js", "import": "./dist/server/index.mjs", "types": "./dist/server/index.d.ts" },
    "./client":  { "require": "./dist/client/node/index.js", "import": "./dist/client/node/index.mjs", "types": "./dist/client/node/index.d.ts" },
    "./web":     { "browser": "./dist/client/web/index.browser.mjs", "import": "./dist/client/web/index.mjs", "types": "./dist/client/web/index.d.ts" },
    "./chains":  "./dist/chains/index.js",
    "./wallet":  "./dist/wallet/index.js",
    "./facilitators": { "require": "./dist/facilitators/index.js", "import": "./dist/facilitators/index.mjs", "types": "./dist/facilitators/index.d.ts" },
    "./mcp":     { "require": "./dist/mcp/index.js", "import": "./dist/mcp/index.mjs", "types": "./dist/mcp/index.d.ts" }
  }
}
```

Note: existing `./client` still points to the Node client to preserve backwards compatibility, now sourced from `src/client/node/`.

### `tsup.config.ts`

Two config blocks:

```ts
import { defineConfig } from 'tsup';

export default defineConfig([
  // Node build (existing)
  {
    entry: [
      'src/index.ts',
      'src/server/index.ts',
      'src/client/node/index.ts',
      'src/cli/index.ts',
      'src/mcp/index.ts',
      'src/chains/index.ts',
      'src/wallet/index.ts',
      'src/verify/index.ts',
      'src/cdp/index.ts',
      'src/facilitators/index.ts',
    ],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    shims: true,
  },
  // Web build
  {
    entry: { 'client/web/index': 'src/client/web/index.ts' },
    format: ['esm'],
    target: 'es2020',
    platform: 'browser',
    dts: true,
    sourcemap: true,
    splitting: false,
    shims: false,
    external: ['node:*', 'fs', 'os', 'path', 'crypto', 'stream'],
    esbuildOptions(options) {
      options.conditions = ['browser', 'import', 'default'];
    },
    outExtension() { return { js: '.mjs' }; },
  },
]);
```

### Bundle verification

Add a script `scripts/verify-web-bundle.mjs` that imports `dist/client/web/index.mjs` and greps for forbidden symbols (`require(`, `from "fs"`, `process.platform`, `homedir`, etc.). Runs as part of `prepublishOnly`. Failure blocks publish.

### Dependencies

Current deps used in web path:

| Dep | Used in Web? | Notes |
|-----|--------------|-------|
| `ethers` | Yes | Only `ethers.JsonRpcProvider`, `ethers.Contract` for balance/allowance reads. Tree-shakeable ESM. |
| `@solana/web3.js` | Yes | `Connection`, `Transaction`, `PublicKey`. Already browser-compatible. |
| `@solana/spl-token` | Yes | Transaction builders; browser-compatible. |
| `viem` | No in v1 | Only Tempo path uses it. Stays Node-only. |
| `@x402/fetch` | No | Current client doesn't import it either. Unchanged. |
| `commander`, `qrcode-terminal` | No | CLI only, excluded from web bundle. |
| `@coinbase/cdp-sdk` | No | Server-side; stays as peer dep. |
| `dotenv`, `mppx`, `bs58` | No | Not on web path. |

No new runtime deps. Web bundle target size: under 150 KB gzipped (`ethers` + `@solana/web3.js` dominate).

## Server: CORS Support

Browsers can't call third-party providers without the provider allowing the origin. `MoltsPayServer` must expose a CORS option. This is **required** for Web Client to be useful in practice.

```ts
interface MoltsPayServerOptions {
  // existing fields...

  /**
   * CORS configuration. Default: false (no CORS headers — same-origin only).
   * - true: allow all origins (Access-Control-Allow-Origin: *)
   * - string[]: explicit allowlist of origins
   * - object: fine-grained control
   */
  cors?: boolean | string[] | {
    origins: string[] | ((origin: string) => boolean);
    credentials?: boolean;
    maxAge?: number;
  };
}
```

Implementation:
- Handle `OPTIONS` preflight on `/services`, `/execute`, `/api/services`, `/registry/services`.
- Mirror `Access-Control-Allow-Headers: X-Payment, Content-Type, Authorization`.
- Expose `Access-Control-Expose-Headers: X-Payment-Required, WWW-Authenticate`. **Critical** — without `Expose-Headers`, browser fetch cannot read the 402 payment challenge.

Docs update: add a paragraph to README explaining providers must enable CORS when expecting web clients.

## Spending Limits on Web

**Default: disabled.** Rationale:
- Limits on the Node CLI were about preventing a stolen machine from draining a local wallet. Web wallets are external; the limit logic would need to be on the wallet side (which is what MetaMask / hardware wallets already do per-signature).
- Per-browser localStorage limits don't sync across devices and give a false sense of security.
- Apps that want per-session limits can wire them up themselves via the thrown error.

When enabled (`spendingLimits: { maxPerTx, maxPerDay }`):
- Persist to `localStorage` under `moltspay:spending` (or user-provided key).
- Same daily-reset logic as Node (`new Date().setHours(0,0,0,0)`).
- On exceed: throw `SpendingLimitExceededError` before signing prompt — do **not** consume a wallet-signature confirmation.

## React Demo

Location: `examples/web/`. Vite + React + TypeScript.

```
examples/web/
  package.json              (workspace-linked moltspay, vite, react, @solana/wallet-adapter-react + -wallets + -base)
  vite.config.ts
  tsconfig.json
  index.html
  src/
    main.tsx
    App.tsx                 (chain selector, connect buttons, pay form, result panel)
    EvmPanel.tsx            (window.ethereum connect, pay with --chain base/polygon/bnb)
    SolanaPanel.tsx         (WalletProvider wrapper, Phantom, pay with --chain solana_devnet)
    components/Result.tsx
  README.md                 (how to run, which wallets tested)
```

Demo features:
- "Connect MetaMask" / "Connect Phantom" buttons.
- Service URL input (default: `https://moltspay.com/a/zen7`).
- Chain dropdown populated from `getServices()` response.
- Service ID dropdown + parameter form (freeform JSON textarea is fine for v1).
- Pay button → shows loading, signature prompt, final result / tx hash + explorer link.
- Error surface: catches `NeedsApprovalError` and offers an "Approve BNB" button; catches generic `UnsupportedChainError` with clear message.

Not a tutorial — it's a working reference. No UI framework beyond plain CSS modules.

## Testing

### Unit tests (`test/client/`)

- `core/x402.test.ts` — decode v1/v2 arrays/objects, malformed base64, missing fields.
- `core/eip3009.test.ts` — typed-data structure matches spec fixtures for USDC on Base / Polygon.
- `core/eip2612.test.ts` — typed-data structure matches fixture for pathUSD on Tempo; DOMAIN_SEPARATOR recomputation test against the on-chain value `0xc601a8a9...` to catch any future domain drift.
- `core/bnb-intent.test.ts` — domain + message shape.
- `core/solana-tx.test.ts` — transfer transaction builds correctly given fixed inputs.
- `core/chain-map.test.ts` — every supported network round-trips (all 8 chains).

All core tests run in both Node (vitest default) and JSDOM environment to catch runtime assumption leaks.

### Integration tests (`test/client/web/`)

- `MoltsPayWebClient` with a fake `PaymentSigner` stub + MSW-mocked server.
- Each chain path: Base, Polygon, BNB (with/without approval path), Solana (with/without feePayer), Tempo (EIP-2612 permit).
- Tempo permit path: client correctly ignores `WWW-Authenticate` when `X-Payment-Required` is present, fetches nonce, builds permit with expected domain, posts signed payload.
- Spending limits on + off.

### Bundle tests

- `scripts/verify-web-bundle.mjs` (see above).
- Size budget: fail if `dist/client/web/index.mjs` exceeds 250 KB minified (soft warning at 150 KB).

### Manual QA checklist (pre-publish)

- MetaMask on Base mainnet, $0.10 real payment.
- MetaMask on Polygon mainnet.
- MetaMask on BNB testnet (approve → pay).
- MetaMask on Base Sepolia (EIP-3009 testnet).
- MetaMask on Tempo Moderato (EIP-2612 permit → server submits). Verify user never gets a chain-switch prompt.
- Phantom on Solana mainnet.
- Phantom on Solana devnet (partial sign with server feePayer).
- Cross-browser: Chrome, Firefox, Safari.

## Implementation Phases

Each phase lands as a reviewable unit; main stays shippable throughout.

### Phase 0 — Tempo probe validation (COMPLETE — 2026-04-21)

**Status:** Done. All gate criteria met. Phase 3c unblocked. All 4 Tempo TIP-20 tokens' EIP-712 domains recovered in the same run, so USDT-on-Tempo can ship in 1.6.0 instead of being deferred.

Hands-on verification executed by `scripts/probe-tempo-permit.mjs` (committed to the repo). The script generates two fresh Tempo wallets, funds both via the Tempo faucet, signs an EIP-2612 Permit with wallet A, has wallet B submit `pathUSD.permit(...)` followed by `pathUSD.transferFrom(...)`, then asserts balance / nonce / allowance deltas.

**Recorded evidence** (`scripts/.probe-tempo-output/results.json`):

| Check | Expected | Observed |
|-------|----------|----------|
| `pathUSD.permit(...)` status | `0x1` | `0x1` ✓ |
| `pathUSD.transferFrom(...)` status | `0x1` | `0x1` ✓ |
| A balance delta | `−500000` | `−500000` ✓ |
| payTo balance delta | `+500000` | `+500000` ✓ |
| `nonces(A)` | `0 → 1` | `0 → 1` ✓ |
| `allowance(A,B)` after permit | `500000` | `500000` ✓ |
| `allowance(A,B)` after transferFrom | `0` | `0` ✓ |

**Transaction explorer links:**
- permit: https://explore.testnet.tempo.xyz/tx/0x4a112847a45b3d251b9b1dbe5254603eecb6595c13cfc3e4d16a48e55981cc01
- transferFrom: https://explore.testnet.tempo.xyz/tx/0xfe85b8908c8a0d91054d819bc04c1fcb953ae10b71900cd7feb87f3a32bf5b2f

**Gas behavior (key finding):** Settler wallet B held only pathUSD / AlphaUSD / BetaUSD / ThetaUSD (all distributed by the faucet) and no native tTEMPO. Both transactions succeeded, confirming that Tempo's `feeToken` mechanism pays gas in TIP-20 tokens automatically. Settler wallets for the production permit flow do not need separate native gas — one token balance covers both settlement cost and fee.

Gas used: permit 784,906; transferFrom 549,444.

**Side-task: all 4 Tempo TIP-20 domains recovered.** See the probe results section below.

### Phase 1 — Core extraction (no behavior change)

1. Create `src/client/core/` with pure modules:
   - `x402.ts` — 402 parsing, requirements selection, header (de)serialization (including the new `scheme: "permit"` discriminator so later phases can hook in without touching this module again).
   - `eip3009.ts` — EIP-3009 TransferWithAuthorization typed-data builder.
   - **`eip2612.ts` — EIP-2612 Permit typed-data builder.** Included here in Phase 1 so all typed-data shapes live in one layer; used later by both Node (optional) and Web clients.
   - `bnb-intent.ts` — BNB PaymentIntent typed-data builder.
   - `solana-tx.ts` — SPL token transfer transaction builder.
   - `chain-map.ts`, `base64.ts`, `errors.ts`, `types.ts`.
2. Move current Node client into `src/client/node/index.ts`. Update the three internal import sites (`src/index.ts`, `src/cli/index.ts`, `src/mcp/server.ts`) to the new path, OR leave a one-line re-export stub at `src/client/index.ts`.
3. Unit tests for every core module (including `eip2612.test.ts` with a DOMAIN_SEPARATOR match against the probed on-chain value).
4. Verify every existing test passes with no changes.
5. Verify `moltspay` CLI still works end-to-end on Base Sepolia.

No new public API. No user-visible changes. This is the derisked step.

### Phase 2 — PaymentSigner abstraction

1. Add `src/client/signer.ts` with interface.
2. Add `src/client/node/signer.ts` (`NodeSigner`).
3. Refactor `MoltsPayClient.pay()` to delegate all signing to `this.signer` (constructed internally from file-based wallet — no API change).
4. Existing tests pass.

### Phase 3a — Server CORS

1. Add `cors` option to `MoltsPayServerOptions` (default `false`).
2. Implement OPTIONS preflight handling on `/services`, `/execute`, `/api/services`, `/registry/services`.
3. Mirror `Access-Control-Allow-Headers: X-Payment, Content-Type, Authorization`.
4. Expose `Access-Control-Expose-Headers: X-Payment-Required, WWW-Authenticate, X-Payment-Response, Payment-Receipt`. Critical — without this, browser fetch cannot read the 402 payment challenge or the 200 receipt.
5. Unit tests covering all three `cors` value shapes (`true`, `string[]`, `CorsOptions`) and the default-off behavior.

**Gate:** existing Node CLI behavior unchanged when `cors` is unset; a browser origin hitting the local server receives correct CORS headers when `cors` is enabled.

### Phase 3b — Tempo EIP-712 domain corrections

Landed as a standalone PR, can merge independently of Web Client work. Phase 0 already recovered the correct domain for all 4 Tempo TIP-20 tokens — this phase is a mechanical code fix.

1. Fix `src/server/index.ts:121-124` to match verified on-chain values:
   ```ts
   'eip155:42431': {
     USDC: { name: 'PathUSD',  version: '1' },   // was 'pathUSD'
     USDT: { name: 'AlphaUSD', version: '1' },   // was 'alphaUSD'
     // Optional: add BetaUSD / ThetaUSD entries if multi-token Tempo support is expanded
   }
   ```
2. Add a guardrail test under `test/server/tempo-domain.test.ts` that hardcodes the on-chain `DOMAIN_SEPARATOR` values for all 4 tokens and recomputes them locally using the `TOKEN_DOMAINS` config — fails fast if someone edits the domain name incorrectly. Fixture values (from Phase 0):

   | Token | Address | Expected `DOMAIN_SEPARATOR` |
   |-------|---------|-----------------------------|
   | pathUSD  | `0x20c0000000000000000000000000000000000000` | `0xc601a8a9918b2bf5076e4a47925ebe14407230ba77dc84e248c15218a46ad6b4` |
   | AlphaUSD | `0x20c0000000000000000000000000000000000001` | `0x32d762f61205377e7b402fe1ef8014637c3b3a18234a5629cfab1982efdc2630` |
   | BetaUSD  | `0x20c0000000000000000000000000000000000002` | `0x99a494a75ff574cc1ff179a3b4f4ec0aff55b51cdd0906994aa8e91bf95137d3` |
   | ThetaUSD | `0x20c0000000000000000000000000000000000003` | `0x657494dec20c65c40c636bb1781412e1dd3eb5aba55cd8dc8346a00753b9a782` |

**Gate:** computed `DOMAIN_SEPARATOR` matches the on-chain value for each configured token. Zero runtime behavior change in `1.5.x` because the stale value was unused, but unblocks Phase 3c.

### Phase 3c — TempoFacilitator permit settlement

1. Extend `src/facilitators/tempo.ts` with a dispatch on payload shape:
   - `{ txHash, chainId }` → existing tx-hash verification (preserved for Node CLI / MPP).
   - `{ permit: {...} }` → new permit settlement path.
2. Implement `verifyPermit(payload, requirements)`: structural validation (field presence, deadline not expired, value matches requirement).
3. Implement `settlePermit(payload, requirements)`: load settler wallet from `TEMPO_SETTLER_KEY` env var, call `pathUSD.permit(...)` then `pathUSD.transferFrom(owner, payTo, value)` via ethers, return tx hash.
4. Extend `buildPaymentRequirements()` in `src/server/index.ts` so Tempo entries emit `scheme: "permit"` and include `extra.tempoSpender` pointing at the configured settler address.
5. Route x402 payloads with `scheme: "permit"` through the new settlement path in `handleRequest()`.
6. Integration test: spin up a test MoltsPayServer, POST a real permit signature (generated by the Phase 0 script), observe two real transactions on Tempo testnet, assert the service result returns only after on-chain confirmation (pay-for-success).

**Gate:** end-to-end test passes on Tempo Moderato testnet. Existing MPP path still works (no regressions for CLI traffic).

### Phase 4 — Web client (COMPLETE — 2026-04-21)

1. ✓ `src/client/web/index.ts` — `MoltsPayWebClient`. Orchestrates `getServices`, `pay`, `getBalance`, `approveBnb`. Dispatches per-chain: EIP-3009 (Base / Polygon / Base Sepolia), EIP-2612 permit (Tempo), BNB intent, Solana SPL transfer. All signing goes through the injected `PaymentSigner`; the client holds no key material.
2. ✓ `src/client/web/signers/eip1193.ts` — `eip1193Signer(provider, options?)`. Wraps any EIP-1193 provider (MetaMask, Coinbase Wallet, Rainbow, …). Implements `getEvmAddress`, `signTypedData` (via `eth_signTypedData_v4` with inline `EIP712Domain` type injection), `sendEvmTransaction` with `wallet_switchEthereumChain` (EIP-3326) and `wallet_addEthereumChain` (EIP-3085) fallback for unknown chains. User-rejection (code 4001 / -32603) → `PaymentRejectedError`.
3. ✓ `src/client/web/signers/solana-adapter.ts` — `solanaSigner(adapter)`. Accepts any `Pick<WalletAdapter, 'publicKey' | 'signTransaction'>` (Phantom, Solflare, Backpack, …). Serializes / deserializes transactions via `base64ToUint8Array` / `uint8ArrayToBase64` (added to `core/base64.ts` in this phase). Partial-sign flag preserved so server fee-payer signature is not clobbered.
4. ✓ `src/client/web/signers/compose.ts` — `composeSigners(...signers)` routes each method (`getEvmAddress`, `signTypedData`, `sendEvmTransaction`, `getSolanaAddress`, `signSolanaTransaction`) to the first underlying signer that services it. Lets a dApp pay on EVM + Solana from one `MoltsPayWebClient`.
5. ✓ `src/client/web/storage.ts` — `SpendingLedger` with `maxPerTx` / `maxPerDay` caps, `localStorage`-backed, daily reset on calendar-day change. Throws `SpendingLimitExceededError` before the wallet prompt. Disabled by default per release design. Silently no-ops in non-browser runtimes.
6. ✓ Tempo chain branch in `pay()`: detects `network === 'eip155:42431'`, reads `req.extra.tempoSpender` / `req.extra.name` / `req.extra.version` (all from Phase 3c server), fetches `nonces(owner)` from `https://rpc.moderato.tempo.xyz` via `ethers.JsonRpcProvider`, builds Permit typed data via `core/eip2612.ts`, signs, splits signature with `ethers.Signature.from()`, emits `scheme: "permit"` x402 payload carrying `{ permit: { owner, spender, value, nonce, deadline, v, r, s } }`. Web Client always posts to `/execute` so `WWW-Authenticate` never appears — no MPP branch needed.
7. ✓ Error classes exposed at the web boundary: `NotInitializedError`, `UnsupportedChainError`, `NeedsApprovalError`, `PaymentRejectedError`, `InsufficientBalanceError`, `SpendingLimitExceededError`, `ServerError`, `MoltsPayError`. Re-exported from `moltspay/web`.
8. ✓ Unit + JSDOM-compatible integration tests under `test/client/web/` — 24 new tests total:
   - `eip1193.test.ts` (6): mocked provider, signTypedData envelope shape, user-rejection mapping, chain switch + add-chain fallback.
   - `compose.test.ts` (6): routing rules, error fall-through.
   - `storage.test.ts` (5): per-tx cap, daily cap, cross-instance persistence, day rollover, missing-storage degradation.
   - `client.test.ts` (7): Base EIP-3009 happy path (verifies X-Payment header shape + authorization fields), error paths (missing header, unsupported chain, Tempo without settler), non-402 result passthrough, `getServices` success + failure.

Phase 4 gate: ✓ `npx tsc --noEmit` clean, ✓ `npx vitest run test/client` all 59 tests pass (10 files), ✓ no new regressions — pre-existing 11 baseline-stale failures in `test/chains.test.ts` / `test/AuditLog.test.ts` unchanged.

Note: `core/eip2612.ts` itself was delivered in Phase 1 — Phase 4 wired it into the web dispatch logic.

Deferred from Phase 4 to Phase 6 (manual QA): live end-to-end chain validation. The web client is unit- and shape-tested but has not yet been exercised against a real MetaMask or Phantom in a browser.

### Phase 5 — Build & package (COMPLETE — 2026-04-21)

1. ✓ `tsup.config.ts` extended to dual-config (Node cjs+esm + Web esm-only). Web config uses `platform: 'browser'`, `target: 'es2020'`, conditions `['browser', 'import', 'default']`, and a conservative `external` list (`node:*`, `fs`, `os`, `path`, `crypto`, `stream`, `http`, `https`, `url`, `util`, `child_process`, `worker_threads`) so any accidental Node-only import at source level fails loudly.
2. ✓ `package.json` adds `"./web"` export (`browser`/`import`/`types`). Existing `./client`, `./server`, `./facilitators`, `./mcp` subpaths untouched. `./web` types pointed at `dist/client/web/index.d.mts` — tsup emits only `.d.mts` for esm-only formats, and npm / modern bundlers (TS 5+, Vite, Next) resolve it correctly.
3. ✓ `scripts/verify-web-bundle.mjs` scans `dist/client/web/index.mjs` for forbidden patterns: static imports of `fs`/`os`/`path`/`crypto`/`stream`/`http`/`https`/`node:*`, `require(` calls, `process.platform`, `__dirname`/`__filename`, `homedir()`, and `*Sync()` FS calls. Size budget: soft-warn at 150 KB, hard-fail at 250 KB. Exit 1 blocks publish.
4. ✓ `npm run verify:web` script added. `prepublishOnly` chained: `typecheck → build → verify:web`. A publish cannot succeed if the web bundle contains a Node-only API.

**Verified build (2026-04-21):**
- `dist/client/web/index.mjs` — 40.6 KB (well under 150 KB soft budget)
- `dist/client/web/index.d.mts` — 16.1 KB
- Smoke-load via `node -e "import('./dist/client/web/index.mjs')"` exports `{ InsufficientBalanceError, MoltsPayError, MoltsPayWebClient, NeedsApprovalError, PaymentRejectedError, ServerError, SpendingLedger, SpendingLimitExceededError, UnsupportedChainError, composeSigners, eip1193Signer, solanaSigner }`

**Non-obvious gotcha surfaced and fixed:** tsup 8.5.1 runs array configs in parallel. A per-config `clean: true` on the Node block was racing the Web config's DTS emit, wiping `dist/client/web/index.d.mts` after it was written (observed: dir mtime later than file mtimes; web `.d.mts` listed in build log but missing from disk). Fix: move the cleanup into a `prebuild: "rm -rf dist"` npm script; drop `clean` from both tsup blocks. This also matches the tsup-recommended pattern for multi-config builds.

### Phase 6 — React demo (COMPLETE — 2026-04-21)

1. ✓ `examples/web/` scaffold — `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`. Standalone (not a workspace member); deps include `react@^18`, `@solana/wallet-adapter-react`, `@solana/wallet-adapter-wallets`, `moltspay: file:../..`. Vite aliases `moltspay/web` → `../../src/client/web/index.ts` so source edits reflect instantly in HMR without a parent rebuild.
2. ✓ EVM panel (`src/EvmPanel.tsx`) — connects `window.ethereum` via `eip1193Signer` with `addChainMetadata` pre-seeded for Tempo Moderato (42431) and BNB Testnet (97) so `wallet_addEthereumChain` fallback works without user intervention. Chain dropdown auto-filtered to what the server advertises. Catches `NeedsApprovalError` and renders a one-click `approveBnb()` button.
3. ✓ Solana panel (`src/SolanaPanel.tsx`) — wraps `@solana/wallet-adapter-react`'s `useWallet` into a minimal `SolanaSignerAdapter` for `solanaSigner`. No wallet-adapter-ui dep (kept the bundle small — connect button is a plain HTML button). Auto-selects Phantom if the user hasn't picked a wallet.
4. ✓ Shared `Result.tsx` handles loading / signing / waiting / success / error states. Explorer link computed from `txExplorerUrl(chain, txHash)` covering all 8 chains (helper in `src/components/explorer.ts`).
5. ✓ `examples/web/README.md` explains how to run (`npm install && npm run dev`), the wallet matrix, security posture, and the intentional omissions (no WalletConnect / Wagmi / RainbowKit — users BYO connector).
6. ✓ Root `README.md` — added a short "For Web Apps (Browser)" subsection pointing at the demo. The full `moltspay/web` API doc lands in Phase 7.

**Deferred to live browser QA (Phase 8 pre-publish checklist):**
- MetaMask on Base mainnet ($0.10 real payment).
- MetaMask on Polygon mainnet.
- MetaMask on BNB testnet (approve → pay flow).
- MetaMask on Base Sepolia (EIP-3009 testnet).
- MetaMask on Tempo Moderato (EIP-2612 permit, verify no chain-switch prompt).
- Phantom on Solana mainnet + devnet (with server fee payer).
- Cross-browser: Chrome, Firefox, Safari.

The demo is the venue for all of the above — it's the first artifact that actually exercises `eth_signTypedData_v4`, the Phantom `signTransaction` path, and `wallet_switchEthereumChain` behavior in a real browser. Anything that breaks there but passed the 24 unit tests is a signer-adapter bug to fix before 1.6.0 ships.

### Phase 7 — Docs (COMPLETE — 2026-04-21)

1. ✓ `README.md` "For Web Apps (Browser)" section — expanded from the Phase 6 one-line pointer into a full reference: install, MetaMask + Phantom + `composeSigners` examples, chain-coverage table (all 8 chains with scheme / gas / notes), BNB approve-then-retry flow, Tempo permit explanation (pathUSD is a native precompile with EIP-2612 but not EIP-3009), error-class cheat sheet with `code` values, opt-in `spendingLimits`, provider CORS requirement, reference demo pointer.
2. ✓ `AGENTS.md` — new **Web (Browser)** subsection with import snippet, dual-signer composition, `NeedsApprovalError` retry pattern, CORS note. Common-errors table extended with `NEEDS_APPROVAL` / `PAYMENT_REJECTED` / CORS entries so LLM agents parsing `AGENTS.md` can recover from every web-only failure mode.
3. ✓ This design doc — Phases 4, 5, 6, 7 all marked complete with concrete file paths + validation results. Release Plan table updated.

### Phase 8 — Release

1. Changelog entry.
2. Version bump to `1.6.0`.
3. Manual QA checklist.
4. `npm publish`.

Estimated scope: roughly 1700–2400 LOC added + 300 LOC refactored, plus ~400 LOC demo. Phase 1 adds `core/eip2612.ts` (~60 LOC) alongside the other typed-data builders. Phases 3a+3b+3c together add ~250 server-side LOC (CORS ~50, domain fix + guardrail ~30, TempoFacilitator permit mode + `tempoSpender` advertisement ~170). Phase 4 adds ~150 client-side LOC (Tempo dispatch branch + web `pay()` glue). Tracked as a single milestone on GitHub with one PR per phase where practical.

## Open Questions

No blockers remain. The two prerequisites (pathUSD permit round-trip, alphaUSD domain recovery) have been promoted to **Phase 0** in the Implementation Phases above — they must complete before Phase 3c but do not gate the rest of the plan.

Deferred to future work:

- **MPP (Machine Payments Protocol) in browser**: not needed for Web Client since EIP-2612 permit covers Tempo gaslessly. MPP remains a server + Node CLI concern for legacy/interop reasons.
- **React hooks package** (`@moltspay/react` with `useMoltsPay`, `usePay`, `useServices`): wait for real-world usage feedback before designing.
- **Embedded wallet** (password-encrypted key in IndexedDB): would cover users without a Web3 wallet installed. Adds significant security surface; revisit only if external-wallet friction proves fatal.
- **WalletConnect v2 bundled connector**: currently BYO. Revisit if every demo user asks for it.

## Release Plan

| Step | Owner | Gate |
|------|-------|------|
| Phase 0 (Tempo probe validation) | **✓ Complete 2026-04-21** | Two successful on-chain transactions + all 4 TIP-20 domains recovered (`PathUSD`, `AlphaUSD`, `BetaUSD`, `ThetaUSD` — all version `"1"`) |
| Phases 1, 2, 3a, 3b, 3c, 4, 5, 6, 7 (**✓ Complete 2026-04-21**) | dev | Phase 4 → web client + 24 tests. Phase 5 → dual tsup build, `./web` subpath, bundle verifier (40.6 KB). Phase 6 → `examples/web/` React+Vite demo (EVM + Solana panels, Result component, shared explorer helper). Phase 7 → `README.md` "For Web Apps" section + `AGENTS.md` web subsection + extended error table. Only Phase 8 (release + manual QA) remains. |
| Manual QA across all 8 chains (MetaMask for EVM + Tempo, Phantom for Solana) | dev | Every chain completes an end-to-end payment end-to-end, including Tempo permit settlement |
| CHANGELOG + README updated | dev | Reviewer approval |
| `npm version 1.6.0` + `npm publish` | dev | Two-factor auth |
| GitHub release with highlights | dev | Links to docs + demo |
| Announce: update `moltspay.com/llms.txt` with web usage snippet | dev | Post-publish |

Backwards compatibility: no breaking changes. `moltspay@1.5.x` users upgrading to `1.6.0` see only additive exports.
