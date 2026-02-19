# MoltsPay

Blockchain payment infrastructure for AI Agents. Turn any skill into a paid service with one JSON file.

## Features

- 🔌 **Skill Integration** - Add `moltspay.services.json` to any existing skill
- 🎫 **x402 Protocol** - HTTP-native payments (402 Payment Required)
- 💨 **Gasless** - Both client and server pay no gas (CDP facilitator handles it)
- ✅ **Payment Verification** - Automatic on-chain verification
- 🔒 **Secure Wallet** - Limits, whitelist, and audit logging
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
    "wallet": "0xYOUR_WALLET_ADDRESS"
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

**2. Fund your wallet:**
Ask your owner to send USDC to your wallet address. No ETH needed!

**3. Use paid services:**
```bash
npx moltspay pay https://server.com text-to-video --prompt "a cat dancing"
```

## Skill Structure

MoltsPay reads your skill's existing structure:

```
my-skill/
├── package.json           # MoltsPay reads "main" field
├── index.js               # Your existing exports
└── moltspay.services.json # Only file you add!
```

**Entry point discovery:**
1. If `package.json` exists → uses `main` field
2. Otherwise → defaults to `index.js`

**Your functions stay untouched.** Just add the JSON config.

## Services Manifest Schema

```json
{
  "$schema": "https://moltspay.com/schemas/services.json",
  "provider": {
    "name": "Service Name",
    "description": "Optional description",
    "wallet": "0x...",
    "chain": "base"
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

### Validate Your Config

```bash
npx moltspay validate ./my-skill
# or
npx moltspay validate ./moltspay.services.json
```

## Server Setup (Mainnet)

**1. Get CDP credentials** from https://portal.cdp.coinbase.com/

**2. Create `~/.moltspay/.env`:**
```env
USE_MAINNET=true
CDP_API_KEY_ID=your-key-id
CDP_API_KEY_SECRET=your-secret
```

**3. Start server:**
```bash
npx moltspay start ./my-skill --port 3000
```

Server does NOT need a private key - the x402 facilitator handles settlement.

## How x402 Works

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

**Client needs:** USDC balance only (no ETH/gas)
**Server needs:** CDP credentials only (no private key)

## CLI Reference

```bash
# === Client Commands ===
npx moltspay init                    # Create wallet
npx moltspay status                  # Check balance
npx moltspay config                  # Update limits
npx moltspay services <url>          # List provider's services
npx moltspay pay <url> <service>     # Pay and execute service

# === Server Commands ===
npx moltspay start <skill-dir>       # Start server
npx moltspay stop                    # Stop server
npx moltspay validate <path>         # Validate manifest

# === Options ===
--port <port>                        # Server port (default 3000)
--chain <chain>                      # Chain: base, polygon, ethereum
--max-per-tx <amount>                # Spending limit per transaction
--max-per-day <amount>               # Daily spending limit
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

| Chain | ID | Type |
|-------|-----|------|
| base | 8453 | Mainnet |
| polygon | 137 | Mainnet |
| ethereum | 1 | Mainnet |
| base_sepolia | 84532 | Testnet |

## Example: Zen7 Video Generation

Live service at `https://juai8.com/zen7/`

**Services:**
- `text-to-video` - $0.99 USDC
- `image-to-video` - $1.49 USDC

**Test it:**
```bash
npx moltspay services https://juai8.com/zen7
npx moltspay pay https://juai8.com/zen7 text-to-video --prompt "a happy cat"
```

## Links

- **npm:** https://www.npmjs.com/package/moltspay
- **GitHub:** https://github.com/Yaqing2023/moltspay
- **x402 Protocol:** https://www.x402.org/

## License

MIT
