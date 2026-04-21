# Tempo Web Client Support

How MoltsPay's Web Client pays for services on Tempo Moderato, and why this approach was chosen over alternatives.

**Status:** Design complete; Phase 0 validation passed on live Tempo Moderato 2026-04-21. Ready for implementation in `moltspay@1.6.0`.

**Relationship to other docs:**
- Parent: [`WEB-CLIENT-DESIGN.md`](./WEB-CLIENT-DESIGN.md) — overall Web Client architecture (EVM / BNB / Solana / Tempo). This doc drills into Tempo specifically.
- Legacy: [`ROADMAP.md`](./ROADMAP.md) and the Node CLI's `handleMPPPayment` implement the older MPP pay-first flow; that path is preserved for backwards compatibility but is not used by Web Client.

## TL;DR

Web Client pays for Tempo services by:
1. Browser wallet signs an **EIP-2612 Permit** typed message.
2. Provider Server receives the signature and calls `pathUSD.permit(...)` followed by `pathUSD.transferFrom(...)` on Tempo.
3. Skill executes only after on-chain settlement succeeds (pay-for-success).

User experience is identical to any other chain: one `signTypedData_v4` prompt, zero gas, no chain switching, no Tempo native assets required. Provider Server carries the Tempo gas cost via a dedicated **settler** wallet.

## 1. Why Tempo Needs a Special Path

Three properties of Tempo Moderato make the browser path non-trivial:

### 1.1 pathUSD is a native precompile, not an EVM-bytecode contract

The pathUSD token lives at `0x20c0000000000000000000000000000000000000`, but `eth_getCode` returns only `0xef` (a 1-byte placeholder). All TIP-20 operations are handled by Tempo's node-level implementation. Bytecode inspection cannot enumerate supported functions — every capability must be probed by calling it.

### 1.2 Non-standard gas model (`feeToken`)

Tempo lets an ERC-20 token (e.g. pathUSD) pay for its own gas. The viem Tempo package exposes this via `{ ...tempoModerato, feeToken }` chain config. The EIP-3085 `wallet_addEthereumChain` specification, used by MetaMask / Coinbase Wallet / Rainbow, has no field for `feeToken` — it only understands a single `nativeCurrency`. A browser wallet added Tempo via EIP-3085 will demand the user hold some native currency to transact, contradicting Tempo's actual fee model.

**Consequence:** browser wallets cannot submit transactions on Tempo correctly. Any design that has the user's wallet originate a Tempo transaction fails in practice.

### 1.3 Existing MoltsPay Tempo flow is MPP pay-first

The Node CLI's current Tempo path:
1. Client uses `viem/tempo` Actions to submit the TIP-20 transfer on-chain.
2. Client packages the transaction hash into an MPP credential: `{ challenge, payload: { hash, type: 'hash' }, source: 'did:pkh:eip155:42431:...' }`.
3. Client retries the service request with `Authorization: Payment <base64>`.
4. Server's `TempoFacilitator.verify()` fetches the transaction receipt via RPC and validates the Transfer event's `to` / `amount` / `token`.

This is "pay-first": if the skill execution subsequently fails, the client loses the payment. It also depends on `viem/tempo`, which is Node-only in practice. Neither property is acceptable for Web Client.

## 2. Probe Results: What pathUSD Actually Supports

Before the probe results, one piece of context worth calling out explicitly: **the server's 402 response for Tempo in `1.5.x` includes an x402 entry with `scheme: "exact"` (EIP-3009), but no one can satisfy it.** pathUSD does not implement `transferWithAuthorization` (confirmed below), so any client that reads the x402 Tempo entry and tries to build an EIP-3009 authorization for it will fail — either at the signing step (wrong domain) or at server-side `ecrecover`. The CLI's pay-on-Tempo flow today sidesteps this by going through MPP on a service-specific endpoint entirely. The x402 advertisement for Tempo in `1.5.x` is effectively dead code. Part of the Phase 3 work for `1.6.0` is to replace it with a live `scheme: "permit"` entry that pathUSD can actually satisfy.

Executed against `https://rpc.moderato.tempo.xyz` on 2026-04-21. Every row is a direct observation from `eth_call`.

### Supported selectors

| Function | Selector | Evidence |
|----------|----------|----------|
| `name()` | `0x06fdde03` | Returns `"pathUSD"` |
| `symbol()` | `0x95d89b41` | Returns `"pathUSD"` |
| `decimals()` | `0x313ce567` | Returns `6` |
| `approve(address,uint256)` | `0x095ea7b3` | Returns `true` |
| `allowance(address,address)` | `0xdd62ed3e` | Returns `uint256` |
| `DOMAIN_SEPARATOR()` | `0x3644e515` | Returns `0xc601a8a9918b2bf5076e4a47925ebe14407230ba77dc84e248c15218a46ad6b4` |
| `nonces(address)` | `0x7ecebe00` | Returns `uint256` (EIP-2612 getter) |
| **`permit(...)`** | **`0xd505accf`** | Zero-argument call reverts with semantic error `"TIP20 token error: PermitExpired"`. The function dispatches to real logic and rejects the zero-deadline signature as expired. |

### Unsupported selectors

| Function | Selector | Evidence |
|----------|----------|----------|
| `transferWithAuthorization(...)` (EIP-3009) | `0xe3ee160e` | Reverts with `UnknownSelector(bytes4)` custom error — byte-for-byte identical to `0xdeadbeef` nonsense-selector baseline |
| `authorizationState(address,bytes32)` (EIP-3009) | `0xe94a0102` | Same `UnknownSelector` shape |
| `eip712Domain()` (EIP-5267) | `0x84b0196e` | Same |
| `version()` | `0x54fd4d50` | Same |

### EIP-712 Domains — all 4 TIP-20 tokens verified

The initial probe run identified pathUSD. A follow-up run on 2026-04-21 (`scripts/probe-tempo-permit.mjs`) recovered the domains for all 4 Tempo TIP-20 tokens in one shot. The pattern is uniform: `name` equals the symbol with capitalized first letter, `version` is always `"1"`.

| Token | Address | `domain.name` | `version` | On-chain `DOMAIN_SEPARATOR` |
|-------|---------|---------------|-----------|-----------------------------|
| pathUSD  | `0x20c0000000000000000000000000000000000000` | `"PathUSD"`  | `"1"` | `0xc601a8a9918b2bf5076e4a47925ebe14407230ba77dc84e248c15218a46ad6b4` |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` | `"AlphaUSD"` | `"1"` | `0x32d762f61205377e7b402fe1ef8014637c3b3a18234a5629cfab1982efdc2630` |
| BetaUSD  | `0x20c0000000000000000000000000000000000002` | `"BetaUSD"`  | `"1"` | `0x99a494a75ff574cc1ff179a3b4f4ec0aff55b51cdd0906994aa8e91bf95137d3` |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` | `"ThetaUSD"` | `"1"` | `0x657494dec20c65c40c636bb1781412e1dd3eb5aba55cd8dc8346a00753b9a782` |

USDT-on-Tempo (AlphaUSD) is therefore no longer blocked — it ships alongside USDC in `1.6.0`.

### Server-side bugs surfaced by the probe

`src/server/index.ts:121-124` currently hardcodes:

```ts
'eip155:42431': {
  USDC: { name: 'pathUSD',  version: '1' },   // ❌ must be 'PathUSD'
  USDT: { name: 'alphaUSD', version: '1' },   // ❌ must be 'AlphaUSD'
}
```

Both entries are wrong: the correct on-chain names are `PathUSD` and `AlphaUSD` (capitalized). These bugs are inert in `1.5.x` (MPP flow does not use EIP-712 signing) but **must be fixed before Web Client permit settlement can work** — a mismatched domain makes EIP-712 hashes diverge and `ecrecover` inside `permit()` recovers the wrong address, reverting the call.

Fix scheduled as Phase 3b in `WEB-CLIENT-DESIGN.md` with a guardrail test that locks all 4 DOMAIN_SEPARATOR values against the config.

## 3. Scheme Selection

Five alternatives evaluated:

| Scheme | Viable? | Reason |
|--------|---------|--------|
| A. EIP-3009 `transferWithAuthorization` | No | pathUSD does not implement it (probe confirmed) |
| B. Browser sends TIP-20 transfer itself | No | Wallets don't support Tempo's `feeToken` model; user would need native Tempo gas token |
| C. Relayer + forwarder contract | Possible but over-engineered | Delivers same capabilities as EIP-2612 at 5x the implementation cost |
| D. Server reroutes to Base/Polygon settlement | Possible but wrong semantics | User selected "Tempo" but pays on Base. "Tempo payment" becomes a fiction. |
| **E. EIP-2612 permit + server `transferFrom`** | **Selected** | Native contract support, zero new infrastructure, UX parity with other chains |

**Selected:** E (EIP-2612 permit).

Compared to EIP-3009, the only difference is settlement cost — server does two on-chain calls (`permit` + `transferFrom`) instead of one (`transferWithAuthorization`). On Tempo this cost is negligible.

## 4. End-to-End Flow

### Actors

| Role | Identity | Address |
|------|----------|---------|
| User Wallet (A) | Browser wallet (MetaMask / Coinbase Wallet / Rainbow / WalletConnect-bridged wallet) | `0xUSER...` — the pathUSD owner |
| Web Client | `MoltsPayWebClient` running in the browser | No independent identity; speaks on behalf of the user |
| Provider Server | `MoltsPayServer` instance deployed by a provider | No independent identity; delegates settlement |
| Tempo Settler (B) | Provider-operated EOA or contract that submits `permit` + `transferFrom` | `0xSETTLER...` — the spender in the Permit |
| Tempo Moderato | Blockchain node with pathUSD precompile | RPC `https://rpc.moderato.tempo.xyz` |
| pathUSD | Native TIP-20 token | `0x20c0000000000000000000000000000000000000` |

### Timing diagram

```
User Wallet (A)   Web Client      Provider Server   Tempo Settler (B)   pathUSD (chain)
     │                │                  │                 │                 │
 [1] │ connect        │                  │                 │                 │
     │◄───────────────┤                  │                 │                 │
     │ eth_accounts   │                  │                 │                 │
     ├───────────────►│                  │                 │                 │
     │                │                  │                 │                 │
 [2] │                │ POST /execute    │                 │                 │
     │                ├─────────────────►│                 │                 │
     │                │                  │                 │                 │
 [3] │                │ 402 + X-Payment-Required           │                 │
     │                │◄─────────────────┤                 │                 │
     │                │ (Tempo entry + extra.tempoSpender=B)                 │
     │                │                  │                 │                 │
 [4] │                │ eth_call nonces(A)                 │                 │
     │                ├────────────────────────────────────────────────────► │
     │                │ nonce = 7                          │                 │
     │                │◄────────────────────────────────────────────────────┤│
     │                │                  │                 │                 │
 [5] │ signTypedData  │                  │                 │                 │
     │◄───────────────┤                  │                 │                 │
     │ (EIP-2612 Permit)                 │                 │                 │
     │ signature      │                  │                 │                 │
     ├───────────────►│                  │                 │                 │
     │                │                  │                 │                 │
 [6] │                │ POST /execute + X-Payment          │                 │
     │                ├─────────────────►│                 │                 │
     │                │                  │                 │                 │
 [7] │                │                  │ TempoFacilitator.settlePermit()   │
     │                │                  ├────────────────►│                 │
     │                │                  │                 │ permit(...)     │
     │                │                  │                 ├───────────────► │
     │                │                  │                 │                 │
 [8] │                │                  │                 │ transferFrom(A,payTo,value) │
     │                │                  │                 ├───────────────► │
     │                │                  │                 │                 │
 [9] │                │                  │ tx hash + status │                │
     │                │                  │◄────────────────┤                 │
     │                │                  │                 │                 │
[10] │                │                  │ execute skill   │                 │
     │                │                  │ (only if [9] ok)│                 │
     │                │                  │                 │                 │
[11] │                │ 200 + result     │                 │                 │
     │                │◄─────────────────┤                 │                 │
```

### Per-step detail

**[1] Connect wallet.** Web Client calls `provider.request({ method: 'eth_requestAccounts' })`. No `wallet_switchEthereumChain` — the wallet's current chain is irrelevant. MetaMask on Ethereum mainnet can still sign a Tempo permit; `signTypedData_v4` is a pure offline operation that does not validate chain reachability.

**[2] Initial POST.**

```http
POST /execute HTTP/1.1
Content-Type: application/json

{"service":"text-to-video","params":{"prompt":"..."},"chain":"tempo_moderato"}
```

**[3] 402 response.** Web Client always POSTs to `/execute`, which is handled by `handleExecute` + `sendPaymentRequired`. This path emits only the x402 header — `WWW-Authenticate: Payment` is never attached here. (MPP challenge headers only appear on service-specific endpoints like `/text-to-video`, which Web Client does not hit.)

```http
HTTP/1.1 402 Payment Required
X-Payment-Required: <base64(x402-v2-json)>
```

Decoded `X-Payment-Required` for Tempo:

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "permit",
    "network": "eip155:42431",
    "amount": "990000",
    "asset": "0x20c0000000000000000000000000000000000000",
    "payTo": "0xPROVIDER_WALLET...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "PathUSD",
      "version": "1",
      "tempoSpender": "0xSETTLER..."
    }
  }]
}
```

Three fields are **new** to support Tempo Web Client:
- `scheme: "permit"` — disambiguates from the existing `scheme: "exact"` (EIP-3009) flow.
- `extra.name` and `extra.version` — already present for other chains, now with the corrected `"PathUSD"` casing.
- `extra.tempoSpender` — the settler address the client should nominate as the permit spender.

**[4] Read nonce.** Web Client opens a transient JSON-RPC connection to `https://rpc.moderato.tempo.xyz` and calls `pathUSD.nonces(owner)`. Read-only, no signer involvement. Returns the next expected nonce for that account.

**[5] Sign EIP-2612 Permit.** Web Client constructs:

```js
{
  domain: {
    name: 'PathUSD',
    version: '1',
    chainId: 42431,
    verifyingContract: '0x20c0000000000000000000000000000000000000'
  },
  types: {
    Permit: [
      { name: 'owner',    type: 'address' },
      { name: 'spender',  type: 'address' },
      { name: 'value',    type: 'uint256' },
      { name: 'nonce',    type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  },
  primaryType: 'Permit',
  message: {
    owner:    ownerAddress,
    spender:  requirement.extra.tempoSpender,
    value:    requirement.amount,
    nonce:    nonceFromStep4,
    deadline: Math.floor(Date.now() / 1000) + 3600
  }
}
```

Then calls `provider.request({ method: 'eth_signTypedData_v4', params: [owner, JSON.stringify(typedData)] })`.

MetaMask renders a typed-data prompt showing domain `PathUSD`, spender, value, and deadline. One user click confirms. **No gas. No transaction. No chain switch.**

The returned signature is a 65-byte hex string. Split into `(v, r, s)` for the server.

**[6] POST with X-Payment.**

```http
POST /execute HTTP/1.1
Content-Type: application/json
X-Payment: <base64(payload)>

{"service":"text-to-video","params":{"prompt":"..."},"chain":"tempo_moderato"}
```

Decoded `X-Payment`:

```json
{
  "x402Version": 2,
  "scheme": "permit",
  "network": "eip155:42431",
  "payload": {
    "permit": {
      "owner": "0xUSER...",
      "spender": "0xSETTLER...",
      "value": "990000",
      "nonce": "7",
      "deadline": "1745251200",
      "v": 27,
      "r": "0x...",
      "s": "0x..."
    }
  },
  "accepted": { /* mirror of accepts[0] from step 3 */ }
}
```

**[7][8] Settle on Tempo.** `TempoFacilitator.settlePermit()` runs:

```ts
const provider = new ethers.JsonRpcProvider(TEMPO_RPC);
const settlerWallet = new ethers.Wallet(process.env.TEMPO_SETTLER_KEY, provider);

const pathUSD = new ethers.Contract(PATHUSD_ADDR, [
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)'
], settlerWallet);

// [7] Consume signature, set allowance
const permitTx = await pathUSD.permit(
  p.owner, p.spender, p.value, p.deadline, p.v, p.r, p.s
);
await permitTx.wait();

// [8] Move tokens
const transferTx = await pathUSD.transferFrom(p.owner, requirements.payTo, p.value);
await transferTx.wait();
```

pathUSD's internal behavior:
- `permit`: rebuild EIP-712 digest → `ecrecover(digest, v, r, s)` → compare recovered address to `owner` → set `allowance[owner][spender] = value`, increment `nonces[owner]`.
- `transferFrom`: assert `allowance[owner][spender] >= value` → debit `owner`, credit `payTo` → decrement allowance.

**[9] Return to server logic.** Settler returns tx hash + success. Server does not execute the skill until this confirms (pay-for-success).

**[10] Execute skill.** Provider runs the actual business logic (text-to-video, etc.). If the skill fails here, the user is out the payment — same as all other chains. Providers can choose to refund via a separate return tx, but that is out of scope for this design.

**[11] Return to client.**

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "result": {"video_url": "https://..."},
  "payment": {
    "txHash": "0xabcd...",
    "explorer": "https://explorer.tempo.xyz/tx/0xabcd...",
    "status": "settled"
  }
}
```

Web Client returns `result.result` to the app code.

## 5. Component Responsibilities

| Component | Does | Does not |
|-----------|------|----------|
| User Wallet | Sign EIP-712 typed data | Send transactions, pay gas, hold Tempo native currency |
| Web Client | Read nonce, build typed data, (de)serialize x402 headers | Hold keys, send transactions |
| Provider Server | Parse x402 payload, dispatch to `TempoFacilitator`, execute skill, enforce pay-for-success | Submit transactions with user keys (it has none) |
| Tempo Settler (B) | Pay Tempo gas, submit `permit` + `transferFrom` | Custody user's pathUSD — funds flow user → payTo atomically |
| pathUSD contract | Validate signature, update allowance, move balances | — |

**Settler funding.** Settler wallet must hold enough tTEMPO (or Tempo `feeToken` equivalent) to pay gas for the two-call sequence. This is a new operational requirement for providers accepting Tempo Web Client payments, but gas on Tempo is cheap enough that a small standing balance covers many transactions.

## 6. Implementation Locations

### Client-side changes

```
src/client/
  core/
    x402.ts          +  parse and build "scheme: permit" payloads
    eip2612.ts       NEW
                         buildPermitTypedData({
                           ownerAddress, spenderAddress, value, nonce, deadline,
                           chainId, tokenAddress, tokenName, tokenVersion
                         }): { domain, types, primaryType, message }
    chain-map.ts     (already handles 'eip155:42431' ↔ 'tempo_moderato')
  web/
    index.ts         +  pay() dispatches to Tempo branch when network === 'eip155:42431':
                         1. read nonces via new ethers.JsonRpcProvider(TEMPO_RPC)
                         2. build permit typed data from requirements + nonce
                         3. signer.signTypedData(typedData)
                         4. assemble x402 payload with scheme: "permit"
                         5. POST with X-Payment header
  node/
    index.ts         +  same Tempo branch (shares core/eip2612.ts)
                         legacy MPP branch retained as fallback path
```

### Server-side changes

```
src/server/index.ts
  L122                 ✏  'pathUSD' → 'PathUSD' (EIP-712 domain name fix)
  L123                 ✏  'alphaUSD' → verified value (pending alphaUSD probe)
  buildPaymentRequirements
                       +  Tempo entries emit scheme: "permit", extra.tempoSpender
  handleRequest
                       +  route X-Payment with scheme: "permit" to TempoFacilitator.settlePermit()

src/facilitators/tempo.ts
  verify               +  discriminate on payload shape:
                            { txHash, chainId }   → legacy tx-hash verification (Node CLI / MPP)
                            { permit: {...} }     → structural validation only (actual settlement happens in settlePermit)
  settlePermit         NEW  two-call sequence: pathUSD.permit(...) then pathUSD.transferFrom(...)
  settle               +  discriminate on payload shape, route accordingly
```

Estimated increment: ~150 LOC client, ~200 LOC server, ~100 LOC tests.

### Configuration

Providers accepting Tempo Web Client payments must set one new env var:

```
TEMPO_SETTLER_KEY=0x...    # private key of the settler EOA
TEMPO_SETTLER_ADDRESS=0x.. # (optional; derivable from key)
```

Advertised to clients via the x402 `req.extra.tempoSpender` field.

## 7. Why Not Other Options (Detail)

### MPP in the browser

**Not done.** Three reasons, in order from most fundamental to most practical:

1. **Web Client never hits an MPP-serving endpoint.** MPP challenge headers come from `handleMPPRequest`, which is only mounted on service-specific endpoints (`/text-to-video`, `/ping`, etc.). Web Client always POSTs to `/execute`, which runs `handleExecute` + `sendPaymentRequired` — that handler emits x402 only. So Web Client would never even see a `WWW-Authenticate: Payment` challenge to respond to.
2. **MPP requires the client to submit the TIP-20 transfer itself**, which conflicts with Tempo's `feeToken` model vs. browser-wallet capabilities (see Section 1.2). Wallets cannot correctly express pathUSD-as-gas to MetaMask.
3. **MPP is pay-first.** Even if we shimmed around (1) and (2), the user would lose their payment on skill failure. EIP-2612 permit preserves pay-for-success semantics natively.

Server-side MPP handling is **retained** for Node CLI backwards compatibility. Web Client simply does not speak MPP.

### Server rerouting to Base/Polygon

**Not done.** The product semantic is "the user paid on Tempo." Bait-and-switching the chain under the hood is confusing, forces providers to maintain cross-chain balance, and introduces FX risk. EIP-2612 permit delivers true Tempo settlement with no user compromise.

### Relayer + forwarder contract

**Not done.** A dedicated forwarder contract on Tempo plus a relayer service offers the same "gasless from the user" property as EIP-2612 permit but at substantially higher infrastructure cost: smart contract deployment and audit, relayer uptime, replay protection logic we'd need to implement ourselves. EIP-2612 gets all of this for free from the existing pathUSD precompile.

### Browser-add-Tempo-via-EIP-3085

**Not done.** `wallet_addEthereumChain` does not express `feeToken`. MetaMask / Coinbase Wallet / Rainbow would list Tempo's `nativeCurrency` as a real asset the user must hold, which is not how Tempo works. Transactions submitted via `eth_sendTransaction` would either fail gas estimation or demand native currency that doesn't exist in the user's wallet. Operationally untenable.

## 8. Validation Results

Three of four validation items completed on 2026-04-21 via `scripts/probe-tempo-permit.mjs`. Evidence recorded in `scripts/.probe-tempo-output/results.json`.

| Item | How | Status |
|------|-----|--------|
| End-to-end `permit()` + `transferFrom()` on live Tempo Moderato | Generated two Tempo wallets (A=owner, B=settler), funded via faucet, A signed Permit, B submitted both transactions | **✓ Verified** — permit tx `0x4a112847...`, transferFrom tx `0xfe85b890...`, balance deltas and nonce increment all matched expectations |
| AlphaUSD (USDT on Tempo) EIP-712 domain name | `DOMAIN_SEPARATOR` match against computed candidates | **✓ Verified** — `name = "AlphaUSD"`, `version = "1"`. Also recovered BetaUSD and ThetaUSD in the same pass |
| Tempo gas model (tTEMPO vs `feeToken`) | Observed that settler wallet B held only TIP-20 tokens (no native tTEMPO) and still successfully submitted both transactions | **✓ Verified** — `feeToken` model is active; settler wallets need no separate native gas token, only TIP-20 balance |
| MetaMask / Coinbase Wallet / Rainbow behavior on `signTypedData_v4` with chainId 42431 | Manual test with all three wallets | Pending Phase 4 QA (Manual QA checklist in `WEB-CLIENT-DESIGN.md`) |

**Gas consumption observed:** `permit` = 784,906 gas, `transferFrom` = 549,444 gas. Settlement paid in pathUSD via Tempo's `feeToken` mechanism.

**Explorer links:**
- permit: https://explore.testnet.tempo.xyz/tx/0x4a112847a45b3d251b9b1dbe5254603eecb6595c13cfc3e4d16a48e55981cc01
- transferFrom: https://explore.testnet.tempo.xyz/tx/0xfe85b8908c8a0d91054d819bc04c1fcb953ae10b71900cd7feb87f3a32bf5b2f

## 9. Summary

The EIP-2612 permit path turns Tempo from "the chain Web Client can't support" into a regular x402-style gasless chain, equivalent in UX to Base/Polygon but implemented via `permit` + `transferFrom` instead of `transferWithAuthorization`. The entire mechanism fits inside the existing x402 protocol by introducing one new scheme value (`"permit"`) and one new `extra` field (`tempoSpender`). No new contracts, no new infrastructure, no custom relayer — just a capability we verified is already live on Tempo Moderato as of 2026-04-21.
