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

- 🔌 **Skill Integration** - Add `moltspay.services.json` to any existing skill
- 🎫 **x402 Protocol** - HTTP-native payments (402 Payment Required)
- 💨 **Gasless** - Both client and server pay no gas (CDP facilitator handles it)
- ✅ **Payment Verification** - Automatic on-chain verification
- 🔒 **Secure Wallet** - Spending limits, whitelist, and audit logging
- ⛓️ **Multi-chain** - Base, Polygon, Ethereum (mainnet & testnet)
- 🤖 **Agent-to-Agent** - Complete A2A payment flow support

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
    "wallet": "0xYOUR_WALLET_ADDRESS",
    "chains": ["base", "polygon"]
  },
  "services": [{
    "id": "text-to-video",
    "function": "textToVideo",
    "price": 0.99,
    "currency": "USDC"
  }]
}
```

**3. Start server:**
```bash
npx moltspay start ./my-skill --port 3000
```

That's it! Your skill now accepts x402 payments.

### For Clients (Buying)

**1. Initialize wallet (one time):**
```bash
npx moltspay init --chain base
# Output: Wallet address 0xABC123...
```

**2. Fund your wallet (US users):**
```bash
npx moltspay fund 50
# Opens Coinbase Pay - use debit card or Apple Pay
# USDC arrives in ~2 minutes. No ETH needed!
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
npx moltspay init

# 2. Get free testnet tokens
npx moltspay faucet                        # Base Sepolia (1 USDC, once per 24h)
npx moltspay faucet --chain tempo_moderato # Tempo testnet (pathUSD)

# 3. Test payments
# Option A: Base Sepolia
npx moltspay pay https://moltspay.com/a/yaqing text-to-video \
  --chain base_sepolia --prompt "a robot dancing"

# Option B: Tempo Moderato (gas-free, MPP protocol)
npx moltspay pay https://server.com service-id \
  --chain tempo_moderato --prompt "test"
```

## Payment Protocols

MoltsPay supports two payment protocols:

| Protocol | Chains | Gas | Description |
|----------|--------|-----|-------------|
| x402 | Base, Polygon, Ethereum | Gasless (CDP pays) | HTTP 402 + EIP-3009 signatures |
| MPP | Tempo Moderato | Gas-free native | HTTP 402 + WWW-Authenticate |

### How x402 Protocol Works

```
Client                         Server                      CDP Facilitator
  │                              │                              │
  │ POST /execute                │                              │
  │ ─────────────────────────>   │                              │
  │                              │                              │
  │ 402 + payment requirements   │                              │
  │ <─────────────────────────   │                              │
  │                              │                              │
  │ [Sign EIP-3009 - NO GAS]     │                              │
  │                              │                              │
  │ POST + X-Payment header      │                              │
  │ ─────────────────────────>   │ Verify signature             │
  │                              │ ─────────────────────────>   │
  │                              │                              │
  │                              │ Execute transfer (pays gas)  │
  │                              │ <─────────────────────────   │
  │                              │                              │
  │ 200 OK + result              │                              │
  │ <─────────────────────────   │                              │
```

**Key insight:** Client signs a payment authorization, server submits it. Neither party pays gas - the CDP facilitator handles settlement.

### How MPP Protocol Works (Tempo)

MPP (Machine Payments Protocol) is simpler - client executes the transfer directly:

```
Client                         Server
  │                              │
  │ POST /service                │
  │ ─────────────────────────>   │
  │                              │
  │ 402 + WWW-Authenticate       │
  │ <─────────────────────────   │
  │                              │
  │ [Execute TIP-20 transfer]    │
  │ [No gas needed on Tempo]     │
  │                              │
  │ POST + Authorization: Payment│
  │ ─────────────────────────>   │
  │                              │
  │ [Server verifies on-chain]   │
  │                              │
  │ 200 OK + Payment-Receipt     │
  │ <─────────────────────────   │
```

**Key insight:** On Tempo, the client executes the transfer directly (gas-free), then retries with the transaction hash. No CDP facilitator needed.

## Skill Structure

MoltsPay reads your skill's existing structure:

```
my-skill/
├── package.json           # MoltsPay reads "main" field
├── index.js               # Your existing exports
└── moltspay.services.json # Only file you add!
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

- Client pays with `--chain base` → Server verifies on Base mainnet
- Client pays with `--chain base_sepolia` → Server verifies on Base Sepolia

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
npx moltspay init                    # Create wallet
npx moltspay fund <amount>           # Fund wallet via Coinbase (US)
npx moltspay faucet                  # Get free testnet USDC
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
npx moltspay pay <url> <service> --chain base_sepolia  # Pay on testnet

# === Server Commands ===
npx moltspay start <skill-dir>       # Start server
npx moltspay stop                    # Stop server
npx moltspay validate <path>         # Validate manifest

# === Options ===
--port <port>                        # Server port (default 3000)
--chain <chain>                      # Chain: base, polygon, base_sepolia, tempo_moderato
--token <token>                      # Token: USDC, USDT
--max-per-tx <amount>                # Spending limit per transaction
--max-per-day <amount>               # Daily spending limit
--config-dir <dir>                   # Custom wallet directory
```

## Programmatic Usage

### Client

```typescript
import { MoltsPayClient } from 'moltspay/client';

const client = new MoltsPayClient({ chain: 'base' });

// Pay for a service
const result = await client.execute('https://server.com', 'text-to-video', {
  prompt: 'a cat dancing'
});

console.log(result.video_url);
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

| Chain | ID | Type | Notes |
|-------|-----|------|-------|
| Base | 8453 | Mainnet | Primary chain |
| Polygon | 137 | Mainnet | |
| Ethereum | 1 | Mainnet | |
| Base Sepolia | 84532 | Testnet | For testing |
| Tempo Moderato | 42431 | Testnet | MPP protocol, gas-free |

### Tempo Testnet (New!)

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

Live service at `https://juai8.com/zen7/`

**Services:**
- `text-to-video` - $0.99 USDC - Generate video from text prompt
- `image-to-video` - $1.49 USDC - Animate a static image

**Supported Chains:** Base, Polygon

**Try it:**
```bash
# List services
npx moltspay services https://juai8.com/zen7

# Pay on Base (default)
npx moltspay pay https://juai8.com/zen7 text-to-video --prompt "a happy cat"

# Pay on Polygon
npx moltspay pay https://juai8.com/zen7 text-to-video --chain polygon --prompt "a happy cat"
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

👉 **[MoltsPay Discord](https://discord.gg/QwCJgVBxVK)** 

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
