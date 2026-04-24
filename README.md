# MoltsPay

[![npm version](https://img.shields.io/npm/v/moltspay.svg)](https://www.npmjs.com/package/moltspay)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)

**Blockchain payment infrastructure for AI Agents.** Turn any skill into a paid service with one JSON file.

MoltsPay enables agent-to-agent commerce using the [x402 protocol](https://www.x402.org/) - HTTP-native payments where AI agents can pay each other for services without human intervention. Built on USDC stablecoins with gasless transactions powered by Coinbase CDP.

## Why MoltsPay?

| Problem | MoltsPay Solution |
|---------|-------------------|
| AI agents can't pay for services | x402 protocol - HTTP 402 Payment Required flow |
| Blockchain payments need gas | Gasless - CDP facilitator handles all gas fees |
| Complex wallet integration | One JSON file - add `moltspay.services.json` to any skill |
| Payment verification is hard | Automatic on-chain verification included |

## Features

- **Skill Integration** - Add `moltspay.services.json` to any existing skill
- **x402 Protocol** - HTTP-native payments (402 Payment Required)
- **Gasless** - Both client and server pay no gas (facilitators handle it)
- **Payment Verification** - Automatic on-chain verification
- **Secure Wallet** - Spending limits, whitelist, and audit logging
- **Multi-chain** - Base, Polygon, Solana, BNB, Tempo (mainnet & testnet)
- **Agent-to-Agent** - Complete A2A payment flow support
- **Multi-VM** - EVM chains + Solana (SVM) with unified API
- **MCP Server** - Expose wallet + payments to Claude Desktop, Cursor, and other MCP hosts

## Installation

```bash
npm install moltspay@latest
```

## Quick Start

### For Service Providers (Selling)

**1. Have an existing skill with exported functions:**
```javascript
// index.js (your existing skill)
export async function textToVideo({ prompt }) {
  // your implementation
  return { video_url: "https://..." };
}
```

**2. Add `moltspay.services.json`:**
```json
{
  "provider": {
    "name": "My Video Service",
    "wallet": "0xYOUR_EVM_WALLET_ADDRESS",
    "solana_wallet": "YOUR_SOLANA_ADDRESS",
    "chains": ["base", "polygon", "solana", "bnb"]
  },
  "services": [{
    "id": "text-to-video",
    "function": "textToVideo",
    "price": 0.99,
    "currency": "USDC"
  }]
}
```

**Note:** `solana_wallet` is optional - only needed if accepting Solana payments.

**3. Start server:**
```bash
npx moltspay start ./my-skill --port 3000
```

That's it! Your skill now accepts x402 payments.

### For Clients (Buying)

**1. Initialize wallet (one time):**
```bash
npx moltspay init                  # EVM wallet (Base, Polygon, BNB, etc.)
npx moltspay init --chain solana   # Solana wallet (mainnet & devnet)
```

**2. Fund your wallet (US users):**
```bash
npx moltspay fund 5
# Opens Coinbase Pay - use debit card or Apple Pay
# USDC arrives in < 1 minutes. No ETH needed!
```

Or send USDC directly to your wallet address from any exchange.

**3. Use paid services:**
```bash
# Pay on Base (default)
npx moltspay pay https://server.com text-to-video --prompt "a cat dancing"

# Pay on Polygon
npx moltspay pay https://server.com text-to-video --chain polygon --prompt "a cat dancing"
```

### Testnet Quick Start

Want to test before using real money? Use our testnet faucets:

```bash
# 1. Create wallet (if you don't have one)
npx moltspay init                  # EVM wallet (Base, Polygon, BNB, etc.)
npx moltspay init --chain solana   # Solana wallet (mainnet & devnet)

# 2. Get free testnet tokens (pick one or all!)
npx moltspay faucet                        # Base Sepolia (1 USDC, once per 24h)
npx moltspay faucet --chain solana_devnet  # Solana devnet (1 USDC)
npx moltspay faucet --chain bnb_testnet    # BNB testnet (1 USDC + 0.001 tBNB for gas)
npx moltspay faucet --chain tempo_moderato # Tempo testnet (1 pathUSD)

# 3. Test payments on different chains
# Base Sepolia (CDP, gasless)
npx moltspay pay https://moltspay.com/a/zen7 text-to-video \
  --chain base_sepolia --prompt "a robot dancing"

# Solana devnet (SPL transfer)
npx moltspay pay https://moltspay.com/a/zen7 text-to-video \
  --chain solana_devnet --prompt "a cat playing piano"

# BNB testnet (gas sponsored)
npx moltspay pay https://moltspay.com/a/zen7 text-to-video \
  --chain bnb_testnet --prompt "a sunset timelapse"

# Tempo Moderato (gas-free, MPP protocol)
npx moltspay pay https://server.com service-id \
  --chain tempo_moderato --prompt "test"
```

### For Web Apps (Browser)

`moltspay@1.6.0` adds a browser client. Connect any EIP-1193 wallet (MetaMask, Rainbow, Frame, …) for EVM or a `@solana/wallet-adapter` wallet (Phantom, Solflare, Backpack, …) for Solana and pay for x402 services directly from the page — no private key ever in browser memory, no CLI wrapper.

**Install:**

```bash
npm install moltspay
```

**Pay with MetaMask:**

```ts
import { MoltsPayWebClient, eip1193Signer } from 'moltspay/web';

const client = new MoltsPayWebClient({
  signer: eip1193Signer(window.ethereum),
});

// Discover what the provider accepts
const { provider, services } = await client.getServices('https://provider.example.com');

// Run a paid call — user sees one wallet signature prompt
const result = await client.pay(
  'https://provider.example.com',
  'text-to-video',
  { prompt: 'a cat dancing' },
  { chain: 'base' }
);
```

**Pay with Phantom (Solana):**

```ts
import { MoltsPayWebClient, solanaSigner } from 'moltspay/web';
import { useWallet } from '@solana/wallet-adapter-react';

const wallet = useWallet();
const client = new MoltsPayWebClient({ signer: solanaSigner(wallet) });

await client.pay(serverUrl, 'text-to-video', params, { chain: 'solana_devnet' });
```

**EVM + Solana in one client** — use `composeSigners` so the same `MoltsPayWebClient` instance routes to whichever signer matches the picked chain:

```ts
import { MoltsPayWebClient, composeSigners, eip1193Signer, solanaSigner } from 'moltspay/web';

const client = new MoltsPayWebClient({
  signer: composeSigners(
    eip1193Signer(window.ethereum),
    solanaSigner(phantomAdapter),
  ),
});
```

**Chain coverage.** All 8 chains the CLI supports work from the browser with one signature prompt each:

| Chain | Scheme | User gas? | Notes |
|---|---|---|---|
| `base` / `polygon` / `base_sepolia` | EIP-3009 `transferWithAuthorization` | No (gasless) | Provider submits on success |
| `tempo_moderato` | EIP-2612 `permit` | No (gasless) | Browser never switches to Tempo; server's settler submits permit + transferFrom |
| `bnb` / `bnb_testnet` | MoltsPay `PaymentIntent` | One-time approve | Call `client.approveBnb({ chain, spender, token })` once, then intent signatures are gasless |
| `solana` / `solana_devnet` | SPL transfer | No if provider sets a fee payer | `wallet.signTransaction` signs, provider submits |

**BNB approval flow.** The first payment on BNB throws `NeedsApprovalError` with the details needed to approve — catch it, call `approveBnb()`, and retry:

```ts
try {
  await client.pay(url, service, params, { chain: 'bnb' });
} catch (err) {
  if (err instanceof NeedsApprovalError) {
    await client.approveBnb({
      chain: 'bnb',
      spender: err.details.spender,
      token: err.details.token,
    });
    // User paid ~0.001 BNB gas for the approve. Retry now succeeds without further approve.
    await client.pay(url, service, params, { chain: 'bnb' });
  }
}
```

**Tempo note.** Tempo Moderato pathUSD is a native precompile that implements EIP-2612 permit but **not** EIP-3009. The web client dispatches to the permit path automatically when the server advertises `scheme: "permit"`. The user signs typed data; the provider's settler submits the `permit()` + `transferFrom()` transactions on-chain. MetaMask never prompts for a chain switch because the browser wallet doesn't touch Tempo at all.

**Solana mainnet RPC.** The public `api.mainnet-beta.solana.com` endpoint returns 403 to browser requests, so any Solana-mainnet traffic needs an authenticated RPC. Supply one via `solanaRpc`:

```ts
const client = new MoltsPayWebClient({
  signer: composeSigners(
    eip1193Signer(window.ethereum),
    solanaSigner(phantomAdapter),
  ),
  solanaRpc: {
    solana: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
    // solana_devnet falls back to `api.devnet.solana.com` automatically
  },
});
```

Accepts any Helius / QuickNode / Alchemy / Triton / self-hosted URL. Per-chain — override only `solana` if you only use mainnet. Devnet (`api.devnet.solana.com`) still serves browsers and does not need an override.

**Error classes** — every error exposes a `code` field so you can branch without string-matching:

```ts
import {
  NeedsApprovalError,        // code: 'NEEDS_APPROVAL'       — BNB, call approveBnb()
  UnsupportedChainError,     // code: 'UNSUPPORTED_CHAIN'    — user picked a chain the server doesn't accept
  PaymentRejectedError,      // code: 'PAYMENT_REJECTED'     — user cancelled in the wallet
  InsufficientBalanceError,  // code: 'INSUFFICIENT_BALANCE' — not enough native gas for BNB approve
  SpendingLimitExceededError,// code: 'SPENDING_LIMIT_EXCEEDED' — only when you opt in to SpendingLedger
  ServerError,               // code: 'SERVER_ERROR'         — provider returned non-2xx
  MoltsPayError,             // base class
} from 'moltspay/web';
```

**Spending limits (opt-in).** Off by default. External wallets already prompt per-signature; per-browser localStorage limits don't sync across devices. If you want a session-level cap anyway:

```ts
const client = new MoltsPayWebClient({
  signer: eip1193Signer(window.ethereum),
  spendingLimits: { maxPerTx: 5, maxPerDay: 50 },
});
```

**Provider CORS.** Providers must enable CORS on `MoltsPayServer` for browser callers — without it the 402 challenge header is invisible to the browser:

```ts
new MoltsPayServer({
  // ...
  cors: true,                              // allow all origins, or
  cors: ['https://myapp.example.com'],     // explicit allowlist, or
  cors: { origins: [...], maxAge: 86400 }, // fine-grained
});
```

Servers advertising for the web need `cors` enabled; CLI callers are unaffected either way.

**Security posture.** No private key ever enters browser memory. No filesystem access, no `~/.moltspay/` — the wallet is always external. The `signer` object the client receives only has permission to sign typed data and (for BNB) submit one `approve` transaction, which the user explicitly confirms in the wallet UI.

**Reference demo.** `examples/web/` is a runnable React + Vite app that exercises every path above. `cd examples/web && npm install && npm run dev` — it connects to `https://moltspay.com/a/zen7` by default. See [`examples/web/README.md`](examples/web/README.md) for the full matrix of tested wallets + chains.

## MCP Server (For AI Assistants)

MoltsPay ships an [MCP (Model Context Protocol)](https://modelcontextprotocol.io) stdio server that lets MCP-compatible hosts (Cursor, Windsurf, Claude Code, Zed, etc.) browse services, check wallet status, and pay for x402 services on your behalf.

It is a thin wrapper around `MoltsPayClient` — wallet custody, spending limits, and all payment protocols (x402, MPP, Solana, BNB) are reused from the SDK.

### Setup

**1. Create a wallet and set spending limits** (the MCP server refuses to start without a wallet):

```bash
npx moltspay init
npx moltspay config --max-per-tx 2 --max-per-day 10
npx moltspay fund 5    # or: npx moltspay faucet for testnet
```

**2. Point your MCP host at the `moltspay-mcp` binary over stdio:**

```bash
npx -y moltspay-mcp              # normal mode
npx -y moltspay-mcp --dry-run    # preview payments without signing
```

Each host has its own config file for registering stdio MCP servers — check your host's docs for the exact location. For a safer first run, use `--dry-run` so `moltspay_pay` returns a preview instead of spending real funds.

### Tools

| Tool | What it does | Destructive? |
|---|---|---|
| `moltspay_status` | Wallet address, balances across all supported chains, spending limits | No |
| `moltspay_services` | Fetch services manifest from a provider URL; optional `query`/`maxPrice` filter | No |
| `moltspay_pay` | Execute an x402/MPP/SOL/BNB payment and return the service result | **Yes** |
| `moltspay_config` | Read or update `maxPerTx` / `maxPerDay` limits | Updates config file |

### Safety Layers

`moltspay_pay` is the only tool that moves money. Three guards stack on top of the MCP host's own tool-approval prompt:

1. **SDK spending limits** — `maxPerTx` / `maxPerDay` enforced before signing.
2. **Dry-run mode** — launch with `--dry-run` and payments return a preview instead of signing.
3. **Confirmation gate** — set `MOLTSPAY_MCP_REQUIRE_CONFIRM=1` to require a second tool call (`confirmed: true`) for any payment exceeding `maxPerTx / 10`.

Private keys and mnemonics are never exposed over MCP — wallet creation stays on the CLI (`npx moltspay init`) by design. See [`docs/MCP-USAGE.md`](docs/MCP-USAGE.md) for full tool arguments and troubleshooting.

## Payment Protocols

MoltsPay supports multiple payment protocols, each optimized for different chains:

| Protocol | Chains | Gas | Description |
|----------|--------|-----|-------------|
| x402 + CDP | Base, Polygon | Gasless (CDP pays) | HTTP 402 + EIP-3009 signatures |
| x402 + SOL | Solana | Gasless (server pays) | HTTP 402 + SPL transfer |
| x402 + BNB | BNB | Gasless (server pays) | HTTP 402 + EIP-712 intent signing |
| MPP | Tempo | Gas-free native | HTTP 402 + WWW-Authenticate |

### How x402 Protocol Works

```
Client                         Server                      CDP Facilitator
  |                              |                              |
  | POST /execute                |                              |
  | -------------------------------------------------->   |                              |
  |                              |                              |
  | 402 + payment requirements   |                              |
  | <--------------------------------------------------   |                              |
  |                              |                              |
  | [Sign EIP-3009 - NO GAS]     |                              |
  |                              |                              |
  | POST + X-Payment header      |                              |
  | -------------------------------------------------->   | Verify signature             |
  |                              | -------------------------------------------------->   |
  |                              |                              |
  |                              | Execute transfer (pays gas)  |
  |                              | <--------------------------------------------------   |
  |                              |                              |
  | 200 OK + result              |                              |
  | <--------------------------------------------------   |                              |
```

**Key insight:** Client signs a payment authorization, server submits it. Neither party pays gas - the CDP facilitator handles settlement.

### How MPP Protocol Works (Tempo)

MPP (Machine Payments Protocol) is simpler - client executes the transfer directly:

```
Client                         Server
  |                              |
  | POST /service                |
  | -------------------------------------------------->   |
  |                              |
  | 402 + WWW-Authenticate       |
  | <--------------------------------------------------   |
  |                              |
  | [Execute TIP-20 transfer]    |
  | [No gas needed on Tempo]     |
  |                              |
  | POST + Authorization: Payment|
  | -------------------------------------------------->   |
  |                              |
  | [Server verifies on-chain]   |
  |                              |
  | 200 OK + Payment-Receipt     |
  | <--------------------------------------------------   |
```

**Key insight:** On Tempo, the client executes the transfer directly (gas-free), then retries with the transaction hash. No CDP facilitator needed.

### How Solana Protocol Works

```
Client                         Server (Fee Payer)          Solana Network
  |                              |                              |
  | POST /execute                |                              |
  | -------------------------------------------------->   |                              |
  |                              |                              |
  | 402 + payment requirements   |                              |
  | (includes solana_wallet)     |                              |
  | <--------------------------------------------------   |                              |
  |                              |                              |
  | [Sign SPL Transfer]          |                              |
  | [NO GAS - just signing]      |                              |
  |                              |                              |
  | POST + X-Payment (signature) |                              |
  | -------------------------------------------------->   | Execute transfer             |
  |                              | (server pays ~$0.001 SOL)    |
  |                              | -------------------------------------------------->   |
  |                              |                              |
  | 200 OK + result              |                              |
  | <--------------------------------------------------   |                              |
```

**Key insight:** Client only signs the SPL transfer (gasless). Server acts as fee payer and executes the transaction on-chain.

### How BNB Protocol Works

```
Client                         Server                      BNB Network
  |                              |                              |
  | POST /execute                |                              |
  | -------------------------------------------------->   |                              |
  |                              |                              |
  | 402 + payment requirements   |                              |
  | (includes bnbSpender)        |                              |
  | <--------------------------------------------------   |                              |
  |                              |                              |
  | [Sign EIP-712 intent]        |                              |
  | [NO GAS - just signing]      |                              |
  |                              |                              |
  | POST + X-Payment (signature) |                              |
  | -------------------------------------------------->   | Execute transferFrom         |
  |                              | (server pays ~$0.0001 gas)   |
  |                              | -------------------------------------------------->   |
  |                              |                              |
  | 200 OK + result              |                              |
  | <--------------------------------------------------   |                              |
```

**Key insight:** Client only signs an intent (gasless). Server executes the actual transfer and pays the minimal gas (~$0.0001). This is the "pay-for-success" model - payment only happens if service succeeds.

## Skill Structure

MoltsPay reads your skill's existing structure:

```
my-skill/
+------ package.json           # MoltsPay reads "main" field
+------ index.js               # Your existing exports
+------ moltspay.services.json # Only file you add!
```

**Your functions stay untouched.** Just add the JSON config.

## Services Manifest Schema

```json
{
  "$schema": "https://moltspay.com/schemas/services.json",
  "provider": {
    "name": "Service Name",
    "description": "Optional description",
    "wallet": "0x...",
    "chains": ["base", "polygon"]
  },
  "services": [{
    "id": "service-id",
    "name": "Human Readable Name",
    "description": "What it does",
    "function": "exportedFunctionName",
    "price": 0.99,
    "currency": "USDC",
    "input": {
      "prompt": { "type": "string", "required": true }
    },
    "output": {
      "result_url": { "type": "string" }
    }
  }]
}
```

### Multi-Chain Configuration

Accept payments on multiple chains by specifying a `chains` array:

```json
{
  "provider": {
    "wallet": "0x...",
    "chains": ["base", "polygon"]
  }
}
```

Clients can then choose which chain to pay on:
```bash
npx moltspay pay https://server.com service-id --chain polygon --prompt "..."
```

If no `--chain` is specified, the client uses the first chain in the provider's list.

### Validate Your Config

```bash
npx moltspay validate ./my-skill
```

## Server Setup

**1. Get CDP credentials** from https://portal.cdp.coinbase.com/

**2. Create `~/.moltspay/.env`:**
```env
CDP_API_KEY_ID=your-key-id
CDP_API_KEY_SECRET=your-secret
```

**3. Configure chains in your manifest:**
```json
{
  "provider": {
    "wallet": "0x...",
    "chains": [
      { "chain": "base", "network": "eip155:8453", "tokens": ["USDC"] },
      { "chain": "base_sepolia", "network": "eip155:84532", "tokens": ["USDC"] }
    ]
  }
}
```

**4. Start server:**
```bash
npx moltspay start ./my-skill --port 3000
```

Server does NOT need a private key - the x402 facilitator handles settlement.

### Chain Auto-Detection

The server automatically detects which chain to verify payments on based on the client's payment header:

- Client pays with `--chain base` -> Server verifies on Base mainnet
- Client pays with `--chain base_sepolia` -> Server verifies on Base Sepolia

**No `USE_MAINNET` env var needed!** Just configure your accepted chains in the manifest.

### Testnet Setup (Providers)

To accept testnet payments, add `base_sepolia` to your chains array:

```json
{
  "provider": {
    "wallet": "0x...",
    "chains": ["base", "base_sepolia"]
  }
}
```

Clients can then pay using `--chain base_sepolia` and get free testnet USDC via `npx moltspay faucet`.

## CLI Reference

```bash
# === Client Commands ===
npx moltspay init                    # Create wallet (EVM + Solana)
npx moltspay fund <amount>           # Fund wallet via Coinbase (US)
npx moltspay faucet                  # Get free testnet USDC (Base Sepolia)
npx moltspay faucet --chain solana_devnet   # Get Solana devnet USDC
npx moltspay faucet --chain bnb_testnet     # Get BNB testnet USDC + tBNB
npx moltspay faucet --chain tempo_moderato  # Get Tempo testnet tokens
npx moltspay status                  # Check balance (all chains)
npx moltspay config                  # Update limits
npx moltspay services <url>          # List provider's services
npx moltspay pay <url> <service>     # Pay and execute service

# === Service Discovery ===
npx moltspay services                           # List all from registry
npx moltspay services https://provider.com      # List from specific provider
npx moltspay services -q "video"                # Search by keyword
npx moltspay services --max-price 1.00          # Filter by max price
npx moltspay services --type api_service        # Filter by type
npx moltspay services --tag ai                  # Filter by tag
npx moltspay services --json                    # Output as JSON

# === Pay with Chain Selection ===
npx moltspay pay <url> <service> --chain base          # Pay on Base (default)
npx moltspay pay <url> <service> --chain polygon       # Pay on Polygon
npx moltspay pay <url> <service> --chain base_sepolia  # Pay on Base testnet
npx moltspay pay <url> <service> --chain solana        # Pay on Solana
npx moltspay pay <url> <service> --chain solana_devnet # Pay on Solana devnet
npx moltspay pay <url> <service> --chain bnb           # Pay on BNB
npx moltspay pay <url> <service> --chain bnb_testnet   # Pay on BNB testnet
npx moltspay pay <url> <service> --chain tempo_moderato # Pay on Tempo

# === Server Commands ===
npx moltspay start <skill-dir>       # Start server
npx moltspay stop                    # Stop server
npx moltspay validate <path>         # Validate manifest

# === Options ===
--port <port>                        # Server port (default 3000)
--chain <chain>                      # Chain: base, polygon, solana, bnb, tempo_moderato, + testnets
--token <token>                      # Token: USDC, USDT
--max-per-tx <amount>                # Spending limit per transaction
--max-per-day <amount>               # Daily spending limit
--config-dir <dir>                   # Custom wallet directory
```

## Programmatic Usage

### Client

```typescript
import { MoltsPayClient } from 'moltspay/client';

// Initialize client (uses wallet from ~/.moltspay/wallet.json)
const client = new MoltsPayClient();

// Standard service call (params wrapped in { params: {...} })
const result = await client.pay(
  'https://server.com',
  'text-to-video',
  { prompt: 'a cat dancing' },
  { chain: 'base' }
);

console.log(result.video_url);
```

#### Custom Input Formats (rawData)

Some services have custom input formats instead of the standard `{ params: { prompt } }`.
Use `rawData: true` to send your data at the top level:

```typescript
// Service expects: { text: "...", target_lang: "..." }
// NOT: { params: { text: "...", target_lang: "..." } }

const result = await client.pay(
  'https://server.com',
  'translate',
  { text: 'Hello world', target_lang: 'es' },
  { 
    chain: 'base_sepolia',
    rawData: true  // Send data at top level
  }
);

// Server receives: { service: "translate", text: "Hello world", target_lang: "es", chain: "base_sepolia" }
```

#### PayOptions Reference

```typescript
interface PayOptions {
  token?: 'USDC' | 'USDT';     // Token to pay with (default: USDC)
  autoSelect?: boolean;         // Auto-select token based on balance
  chain?: string;               // Chain: base, polygon, solana, bnb, tempo_moderato, + testnets
  rawData?: boolean;            // Send data at top level (for custom input formats)
}
```

#### CLI Equivalent

```bash
# Standard format (uses { params: { prompt } })
npx moltspay pay https://server.com text-to-video --prompt "a cat dancing"

# Custom format (uses rawData, sends at top level)
npx moltspay pay https://server.com translate --data '{"text": "Hello", "target_lang": "es"}'
```

### Server

```typescript
import { MoltsPayServer } from 'moltspay/server';

const server = new MoltsPayServer('./moltspay.services.json');

// Register custom handler (optional - usually loaded from skill)
server.skill('text-to-video', async (params) => {
  // implementation
  return { video_url: '...' };
});

server.listen(3000);
```

## Supported Chains

| Chain | ID | Type | Facilitator | Gas Model |
|-------|-----|------|-------------|-----------|
| Base | 8453 | Mainnet | CDP | Gasless (CDP pays) |
| Polygon | 137 | Mainnet | CDP | Gasless (CDP pays) |
| Base Sepolia | 84532 | Testnet | CDP | Gasless (CDP pays) |
| Solana | - | Mainnet | SOL | Gasless (server pays) |
| Solana Devnet | - | Testnet | SOL | Gasless (server pays) |
| BNB | 56 | Mainnet | BNB | Gasless (server pays) |
| BNB Testnet | 97 | Testnet | BNB | Gasless (server pays) |
| Tempo Moderato | 42431 | Testnet | Tempo | Gas-free native |

**Notes:**
- Ethereum mainnet NOT recommended (gas too expensive)
- Each chain uses a specialized facilitator for optimal UX

### Facilitator Architecture

A **facilitator** is the entity that executes the on-chain payment and pays the gas fees. MoltsPay supports two types:

| Type | Facilitator | Who Pays Gas? | Trust Model |
|------|-------------|---------------|-------------|
| **External** | CDP (Coinbase) | Coinbase | Trust Coinbase infrastructure |
| **Self-hosted** | SOL, BNB, Tempo | Your server | Trust your own server |

**External Facilitator (CDP):**
- Uses Coinbase Developer Platform as a third-party settlement service
- Coinbase handles all on-chain execution and gas fees
- Requires CDP API credentials
- Supported chains: Base, Polygon

**Self-hosted Facilitator (SOL, BNB, Tempo):**
- Your MoltsPay server acts as the facilitator
- Server pays gas fees (~$0.001 per tx)
- No external dependency - fully self-sovereign
- You control the entire payment flow

**Why Self-hosted is More Decentralized:**

| Aspect | CDP (External) | Self-hosted |
|--------|----------------|-------------|
| Single point of failure | Coinbase down = everyone stuck | Each provider independent |
| Censorship risk | Coinbase can block accounts | Cannot be censored |
| Dependency | Relies on third-party | Fully autonomous |

This self-hosted approach is a key innovation: **any service provider can become their own facilitator** without relying on third-party infrastructure. Unlike CDP where all users depend on Coinbase, self-hosted facilitators create a truly decentralized network with no single point of failure.

**Note:** Clients never need to know the facilitator's private keys. They only sign their own payments - the facilitator handles settlement transparently.

### Facilitators Explained

| Facilitator | Chains | How It Works |
|-------------|--------|--------------|
| **CDP** | Base, Polygon | Client signs EIP-3009, Coinbase executes transfer |
| **SOL** | Solana | Client signs SPL transfer, server executes as fee payer |
| **BNB** | BNB | Client signs EIP-712 intent, server executes transfer |
| **Tempo** | Tempo Moderato | Client executes TIP-20 transfer (native gas-free) |

### Solana Support

Solana uses the **SolanaFacilitator** with SPL token transfers. Key differences:

- **Gasless for users** - Server acts as fee payer (~$0.001 SOL per tx)
- **Separate wallet** - Solana uses ed25519 keys (different from EVM's secp256k1)
- **Wallet stored at** `~/.moltspay/wallet-solana.json`
- **Token** - Official Circle USDC SPL token

```bash
# Initialize includes Solana wallet automatically
npx moltspay init

# Check Solana balance
npx moltspay status

# Get free devnet USDC
npx moltspay faucet --chain solana_devnet

# Pay on Solana
npx moltspay pay https://server.com service-id --chain solana --prompt "test"
```

**USDC Addresses:**
| Network | Mint Address |
|---------|--------------|
| Mainnet | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Devnet | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

### BNB Chain Support

BNB uses the **BNBFacilitator** with a pre-approval flow. Since CDP doesn't support BNB, we use a different approach:

1. Client signs an EIP-712 payment intent (no gas needed)
2. Server validates and executes the transfer
3. Server sponsors gas (~$0.0001 per tx)

```bash
# Get free testnet USDC + tBNB for gas
npx moltspay faucet --chain bnb_testnet

# Pay on BNB (client pays no gas!)
npx moltspay pay https://server.com service-id --chain bnb_testnet --prompt "test"

# Check BNB balance
npx moltspay status
```

**Important:** BNB tokens use 18 decimals (not 6 like Base/Polygon).

**Token Addresses (BNB Mainnet):**
| Token | Address |
|-------|---------|
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| USDT | `0x55d398326f99059fF775485246999027B3197955` |

### Tempo Testnet

Tempo Moderato is a gas-free testnet that supports the **MPP (Machine Payments Protocol)**. Perfect for testing agent-to-agent payments without any gas fees.

**Tempo Stablecoins:**
- pathUSD (USDC equivalent): `0x20c0000000000000000000000000000000000000`
- alphaUSD (USDT equivalent): `0x20c0000000000000000000000000000000000001`

```bash
# Get free Tempo testnet tokens
npx moltspay faucet --chain tempo_moderato

# Pay on Tempo (gas-free!)
npx moltspay pay https://server.com service-id --chain tempo_moderato --prompt "test"

# Check Tempo balance
npx moltspay status
```

**Explorer:** https://explore.testnet.tempo.xyz

## Live Example: Zen7 Video Generation

Live service at `https://moltspay.com/a/zen7`

**Services:**
- `text-to-video` - $0.01 USDC - Generate video from text prompt
- `image-to-video` - $0.01 USDC - Animate a static image

**Supported Chains:** Base, Polygon, Solana, BNB, Tempo (mainnet & testnet)

**Try it:**
```bash
# List services
npx moltspay services https://moltspay.com/a/zen7

# Pay on Base (default)
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --prompt "a happy cat"

# Pay on different chains
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --chain polygon --prompt "a happy cat"
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --chain bnb_testnet --prompt "a happy cat"
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --chain solana_devnet --prompt "a happy cat"
```

## Use Cases

- **AI Video Generation** - Pay per video generated
- **Image Processing** - Pay for AI image editing/enhancement
- **Data APIs** - Monetize proprietary datasets
- **Compute Services** - Sell GPU time to other agents
- **Content Generation** - AI writing, music, code generation

## Related Projects

- [moltspay-python](https://github.com/Yaqing2023/moltspay-python) - Python SDK with LangChain integration
- [x402 Protocol](https://www.x402.org/) - The HTTP payment standard

## Community & Support

Join our Discord for help, feedback, and updates:

--> **[MoltsPay Discord](https://discord.gg/QwCJgVBxVK)** 

Or visit the [#moltspay-support](https://discord.com/channels/1472602423267819734/1480968496346304522) channel directly.

## Links

- **Website:** https://moltspay.com
- **Discord:** https://discord.gg/QwCJgVBxVK
- **npm:** https://www.npmjs.com/package/moltspay
- **PyPI:** https://pypi.org/project/moltspay/
- **x402 Protocol:** https://www.x402.org/
- **Coinbase CDP:** https://portal.cdp.coinbase.com/

## License

MIT
