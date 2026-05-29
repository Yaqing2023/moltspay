# MoltsPay MCP Server Design Document

**Status:** Draft  
**Author:** Zen7  
**Created:** 2026-03-28  
**Target:** v1.0.0  

---

## 1. Overview

### 1.1 What is MCP?

Model Context Protocol (MCP) is Anthropic's open standard for connecting AI assistants to external tools, data sources, and services. It provides a unified way for AI agents to:
- Discover available tools
- Call tools with structured inputs
- Receive structured outputs

MCP is being adopted by Claude, ChatGPT, and other AI platforms as the standard for agent tooling.

### 1.2 Problem Statement

AI agents need payment capabilities to participate in the agentic economy. Currently:
- Each agent framework requires custom integration (ElizaOS plugin, LangChain tool, etc.)
- No standard way for any AI to access payment tools
- Agents can't easily pay for services autonomously

### 1.3 Solution

Build a **MoltsPay MCP Server** that:
- Exposes payment tools via MCP protocol
- Deploys on Cloudflare Workers (edge, serverless, global)
- Works with ANY MCP-compatible AI agent
- Handles wallet management, UPP payments, and service discovery

---

## 2. Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI Agent Layer                           │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐   │
│  │  Claude   │  │  ChatGPT  │  │ Workers AI│  │  Custom   │   │
│  │  Desktop  │  │  Actions  │  │  Agent    │  │  Agent    │   │
│  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘   │
│        │              │              │              │          │
│        └──────────────┴──────────────┴──────────────┘          │
│                              │                                  │
│                        MCP Protocol                             │
│                     (JSON-RPC over HTTP)                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                   MoltsPay MCP Server                            │
│                  (Cloudflare Worker)                             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                     MCP Handler                             │ │
│  │  • tools/list - enumerate available tools                   │ │
│  │  • tools/call - execute tool with arguments                 │ │
│  │  • resources/list - list wallet resources                   │ │
│  └────────────────────────────────────────────────────────────┘ │
│                              │                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Wallet       │  │ Payment      │  │ Service      │          │
│  │ Manager      │  │ Executor     │  │ Discovery    │          │
│  │              │  │              │  │              │          │
│  │ • init       │  │ • UPP flow   │  │ • browse     │          │
│  │ • status     │  │ • sign tx    │  │ • search     │          │
│  │ • config     │  │ • verify     │  │ • details    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                 │                 │                   │
│  ┌──────┴─────────────────┴─────────────────┴───────┐          │
│  │              Durable Object (State)               │          │
│  │  • Wallet keypair (encrypted)                     │          │
│  │  • Spending limits & daily tracker                │          │
│  │  • Transaction history                            │          │
│  └───────────────────────────────────────────────────┘          │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                      Blockchain Layer                            │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │  Base   │  │ Polygon │  │   BNB   │  │ Solana  │            │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘            │
│                      USDC Payments                               │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Details

#### MCP Handler
- Implements MCP JSON-RPC protocol
- Routes tool calls to appropriate handlers
- Handles authentication (API key or wallet signature)

#### Wallet Manager
- Creates/imports HD wallets
- Encrypts private keys with user-provided password or KV encryption
- Tracks spending limits (per-tx, daily)

#### Payment Executor
- Implements UPP (Universal Payment Protocol) flow
- Auto-selects protocol: x402 (Base/Polygon), MPP (Tempo), Solana PFS, BNB Pre-Approval
- Signs appropriate format per chain
- Verifies payment success before returning

#### Service Discovery
- Fetches services from MoltsPay marketplace API
- Caches results in KV for performance
- Supports search and filtering

#### Durable Object (State)
- Per-agent persistent storage
- Wallet credentials (encrypted)
- Spending tracker (resets daily)
- Transaction history

---

## 3. MCP Tools Specification

### 3.1 Tool: `moltspay_init`

Initialize or import a wallet for the agent.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "action": {
      "type": "string",
      "enum": ["create", "import"],
      "description": "Create new wallet or import existing"
    },
    "privateKey": {
      "type": "string",
      "description": "Private key to import (only for action=import)"
    },
    "chain": {
      "type": "string",
      "enum": ["base", "base_sepolia", "tempo_moderato","polygon", "bnb", "solana", "solana_devnet", "bnb_testnet"],
      "default": "base"
    },
    "maxPerTx": {
      "type": "number",
      "default": 10,
      "description": "Maximum USD per transaction"
    },
    "maxPerDay": {
      "type": "number",
      "default": 100,
      "description": "Maximum USD per day"
    }
  },
  "required": ["action"]
}
```

**Output:**
```json
{
  "success": true,
  "address": "0x1234...5678",
  "chain": "base",
  "limits": {
    "maxPerTx": 10,
    "maxPerDay": 100
  }
}
```

---

### 3.2 Tool: `moltspay_status`

Check wallet balance and spending status.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "chain": {
      "type": "string",
      "description": "Optional: check specific chain"
    }
  }
}
```

**Output:**
```json
{
  "address": "0x1234...5678",
  "balances": {
    "base": { "usdc": "25.50", "native": "0.001" },
    "polygon": { "usdc": "10.00", "native": "0.5" }
  },
  "limits": {
    "maxPerTx": 10,
    "maxPerDay": 100,
    "spentToday": 15.50,
    "remainingToday": 84.50
  }
}
```

---

### 3.3 Tool: `moltspay_services`

Browse available paid services.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query (e.g., 'video generation')"
    },
    "category": {
      "type": "string",
      "description": "Filter by category"
    },
    "maxPrice": {
      "type": "number",
      "description": "Maximum price in USD"
    },
    "limit": {
      "type": "number",
      "default": 10
    }
  }
}
```

**Output:**
```json
{
  "services": [
    {
      "id": "zen7-text-to-video",
      "name": "Text to Video",
      "provider": "Zen7",
      "price": 0.99,
      "currency": "USDC",
      "description": "Generate video from text prompt",
      "endpoint": "https://juai8.com/zen7/"
    }
  ],
  "total": 45
}
```

---

### 3.4 Tool: `moltspay_pay`

Execute a payment and call a service.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "service": {
      "type": "string",
      "description": "Service ID or endpoint URL"
    },
    "params": {
      "type": "object",
      "description": "Service-specific parameters",
      "additionalProperties": true
    },
    "chain": {
      "type": "string",
      "default": "base"
    }
  },
  "required": ["service", "params"]
}
```

**Output:**
```json
{
  "success": true,
  "payment": {
    "amount": 0.99,
    "currency": "USDC",
    "chain": "base",
    "txHash": "0xabc...123"
  },
  "result": {
    "videoUrl": "https://..."
  }
}
```

---

### 3.5 Tool: `moltspay_history`

View transaction history.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "limit": {
      "type": "number",
      "default": 10
    },
    "chain": {
      "type": "string"
    }
  }
}
```

**Output:**
```json
{
  "transactions": [
    {
      "id": "tx_123",
      "timestamp": "2026-03-28T15:30:00Z",
      "service": "Text to Video",
      "provider": "Zen7",
      "amount": 0.99,
      "chain": "base",
      "txHash": "0x...",
      "status": "success"
    }
  ]
}
```

---

### 3.6 Tool: `moltspay_config`

Update wallet configuration.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "maxPerTx": {
      "type": "number"
    },
    "maxPerDay": {
      "type": "number"
    },
    "defaultChain": {
      "type": "string"
    }
  }
}
```

---

## 4. Authentication & Security

### 4.1 Authentication Options

| Method | Use Case | Security Level |
|--------|----------|----------------|
| API Key | Server-to-server | Medium |
| Wallet Signature | User-controlled agents | High |
| OAuth (future) | Multi-tenant platforms | High |

### 4.2 API Key Auth
```
Authorization: Bearer mcp_xxx...
```
- Generated per deployment
- Stored in Cloudflare secrets
- Rate limited

### 4.3 Wallet Security

**Private Key Storage:**
- Encrypted with AES-256-GCM
- Stored in Durable Object (isolated per agent)
- Never leaves the Worker (signs inside Cloudflare edge)

**Spending Limits:**
- Enforced server-side (can't be bypassed)
- Per-transaction limit
- Daily aggregate limit
- Configurable by wallet owner

### 4.4 Threat Model & Mitigations

**Who can access wallet data?**

| Actor | Can Access? | Mitigation |
|-------|-------------|------------|
| Random internet user | ❌ No | No direct path to Durable Objects |
| User with valid API key | ⚠️ Own wallet only | API key → specific DO instance |
| Worker code bugs | ⚠️ Risk | Code review, no key logging |
| Cloudflare account owner | ✅ Yes | Encryption at rest |
| Cloudflare employees | ⚠️ Theoretically | Encrypted, audit logs |

**Attack vectors & defenses:**

| Attack | Risk | Defense |
|--------|------|---------|
| Enumerate all wallets | Low | DO IDs are UUIDs, no listing API |
| Steal encrypted data | Medium | AES-256-GCM, key separation |
| Compromise encryption key | High | See key management options below |
| Worker code injection | Low | Wrangler deploy from trusted source |
| Account takeover | High | 2FA, least privilege |

### 4.5 Encryption Key Management (Critical)

**⚠️ The encryption key is the crown jewel. How it's managed determines security.**

#### Option A: User-Derived Key (Most Secure)

```
User provides password → PBKDF2 → encryption key
- Password never stored
- Each session requires password
- Server cannot decrypt without user
```

**Pros:** Even account owner can't access wallets
**Cons:** User must provide password each session (UX friction)

#### Option B: Per-Wallet Keys in Secrets

```
Each wallet gets unique encryption key
Keys stored in Cloudflare Secrets (separate binding)
Durable Object stores only encrypted data
```

**Pros:** Compromise of DO doesn't expose keys
**Cons:** Account owner can still access secrets

#### Option C: External KMS (Enterprise)

```
Encryption keys in AWS KMS / GCP Cloud KMS / HashiCorp Vault
Worker calls KMS to encrypt/decrypt
Keys never in Cloudflare
```

**Pros:** Hardware security, audit logs, key rotation
**Cons:** Added latency, external dependency, cost

#### Recommendation by Use Case

| Use Case | Recommended Option |
|----------|-------------------|
| Personal/hobby | Option B (per-wallet secrets) |
| Startup/production | Option B + audit logging |
| Enterprise/regulated | Option C (external KMS) |
| Maximum security | Option A (user-derived) |

### 4.6 Security Checklist

**Pre-deployment:**
- [ ] Encryption key not hardcoded in source
- [ ] No private key logging in code
- [ ] API keys are high-entropy random
- [ ] Rate limiting configured
- [ ] Spending limits have sane defaults

**Operational:**
- [ ] 2FA enabled on Cloudflare account
- [ ] Wrangler deploys from CI/CD only
- [ ] Monitor for anomalous spending
- [ ] Regular dependency updates
- [ ] Incident response plan documented

---

## 5. Cloudflare Integration

### 5.1 Worker Structure

```
moltspay-mcp/
├── src/
│   ├── index.ts           # Main entry, MCP router
│   ├── mcp/
│   │   ├── handler.ts     # MCP protocol handler
│   │   ├── tools.ts       # Tool definitions
│   │   └── types.ts       # MCP types
│   ├── wallet/
│   │   ├── manager.ts     # Wallet operations
│   │   ├── signer.ts      # Transaction signing
│   │   └── storage.ts     # Durable Object
│   ├── payment/
│   │   ├── upp.ts         # UPP protocol handler
│   │   ├── facilitators/  # Chain-specific: x402, mpp, solana, bnb
│   │   └── executor.ts    # Payment flow
│   └── services/
│       └── discovery.ts   # Marketplace API
├── wrangler.toml
└── package.json
```

### 5.2 Wrangler Config

```toml
name = "moltspay-mcp"
main = "src/index.ts"
compatibility_date = "2026-03-01"

[durable_objects]
bindings = [
  { name = "WALLET_STATE", class_name = "WalletState" }
]

[[migrations]]
tag = "v1"
new_classes = ["WalletState"]

[vars]
MOLTSPAY_API = "https://moltspay.com/api/v1"

# Secrets (set via wrangler secret put):
# - API_KEY_SALT
# - ENCRYPTION_KEY
```

### 5.3 Durable Object: WalletState

```typescript
interface WalletState {
  // Wallet
  encryptedPrivateKey: string;
  address: string;
  chain: string;
  
  // Limits
  maxPerTx: number;
  maxPerDay: number;
  
  // Spending tracker
  spentToday: number;
  lastResetDate: string;
  
  // History
  transactions: Transaction[];
}
```

---

## 6. Deployment Options

### 6.1 One-Click Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/moltspay/mcp-server)

### 6.2 Manual Deploy

```bash
# Clone
git clone https://github.com/moltspay/mcp-server
cd mcp-server

# Install
npm install

# Configure
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml with your settings

# Set secrets
wrangler secret put API_KEY_SALT
wrangler secret put ENCRYPTION_KEY

# Deploy
wrangler deploy
```

### 6.3 Connect to AI Agent

**Claude Desktop:**
```json
// ~/.config/claude/config.json
{
  "mcpServers": {
    "moltspay": {
      "url": "https://your-worker.workers.dev/mcp",
      "apiKey": "mcp_xxx..."
    }
  }
}
```

**ChatGPT Actions:**
- Import OpenAPI spec from `/openapi.json`
- Set authentication header

**Workers AI:**
```typescript
const response = await ai.run("@cf/meta/llama-3-8b-instruct", {
  tools: [{
    type: "mcp",
    server: "https://your-worker.workers.dev/mcp"
  }],
  messages: [...]
});
```

---

## 7. API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP JSON-RPC endpoint |
| `/health` | GET | Health check |
| `/openapi.json` | GET | OpenAPI spec for ChatGPT |
| `/.well-known/mcp.json` | GET | MCP server metadata |

---

## 8. Example Flows

### 8.1 Agent Pays for Video Generation

```
User: "Generate a video of a cat dancing in the rain"

Agent thinks: I need to pay for video generation service.

Agent → MCP: tools/call moltspay_services { query: "video" }
MCP → Agent: { services: [{ id: "zen7-text-to-video", price: 0.99 }] }

Agent → MCP: tools/call moltspay_pay { 
  service: "zen7-text-to-video",
  params: { prompt: "a cat dancing in the rain" }
}
MCP → UPP → Zen7: [payment + request]
Zen7 → MCP: { videoUrl: "https://..." }
MCP → Agent: { success: true, result: { videoUrl: "..." } }

Agent: "Here's your video! [link]"
```

### 8.2 Agent Checks Balance Before Purchase

```
User: "What's my balance?"

Agent → MCP: tools/call moltspay_status {}
MCP → Agent: { balances: { base: { usdc: "25.50" } }, spentToday: 5.00 }

Agent: "You have $25.50 USDC on Base. You've spent $5 today with $95 remaining in your daily limit."
```

---

## 9. Pricing & Limits

### 9.1 Free Tier
- 100 tool calls/day
- 1 wallet per deployment
- Community support

### 9.2 Pro Tier ($29/mo)
- Unlimited tool calls
- 10 wallets
- Priority support
- Custom branding

### 9.3 Enterprise
- Unlimited everything
- SLA
- Dedicated support
- On-prem option

---

## 10. Deployment Guide

### 10.1 Quick Deploy (2 minutes)

```
┌─────────────────────────────────────────────────────────────┐
│                    Developer Flow                           │
│                                                             │
│  1. Clone repo                                              │
│     git clone https://github.com/moltspay/mcp-server        │
│                                                             │
│  2. Configure                                               │
│     - Set wallet encryption key (secret)                    │
│     - Set API key for auth                                  │
│                                                             │
│  3. Deploy                                                  │
│     wrangler deploy                                         │
│     → https://moltspay-mcp.YOUR-ACCOUNT.workers.dev         │
│                                                             │
│  4. Connect to AI                                           │
│     - Add MCP server URL to Claude Desktop config           │
│     - Or add as ChatGPT Action                              │
│     - Or call from Workers AI                               │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 One-Click Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/moltspay/mcp-server)

Click → Authorize Cloudflare → Set secrets → Done.

### 10.3 Why Cloudflare?

| Feature | Benefit |
|---------|---------|
| **Edge deployment** | Low latency globally (300+ cities) |
| **Durable Objects** | Per-wallet state, strong consistency |
| **No cold starts** | Instant response for AI tool calls |
| **Scales to zero** | Pay nothing when idle |
| **Workers AI** | Native integration for Cloudflare AI agents |

---

## 11. Use Cases

### 11.1 Claude Desktop with Payments

```
User: "Generate me a video of a sunset, pay whatever it costs"

Claude → MCP Server → checks balance → finds Zen7 service → 
pays $0.99 via UPP → gets video → returns to user

User sees: "Here's your video! Cost $0.99 from your wallet."
```

**Target:** Anyone using Claude Desktop who wants their AI to autonomously pay for services.

### 11.2 ChatGPT Actions with Wallet

```
User in ChatGPT: "Search for the cheapest image generation and buy one"

ChatGPT → MCP Action → moltspay_services → finds options →
moltspay_pay → UPP → returns result

User sees: comparison + purchased result
```

**Target:** ChatGPT Plus users who want payment capabilities.

### 11.3 Workers AI Agent with Commerce

```javascript
// Your Cloudflare Worker
const response = await ai.run("llama-3", {
  tools: [{ type: "mcp", server: "https://moltspay-mcp.workers.dev" }],
  messages: [{ role: "user", content: "Buy me a research report on AI trends" }]
});
```

**Target:** Developers building AI agents on Cloudflare who need payments.

### 11.4 Multi-Agent Commerce

```
Agent A (researcher): "I need market data, willing to pay $2"
     ↓
Agent A → MCP → moltspay_services → finds Agent B's data service
     ↓
Agent A → MCP → moltspay_pay → UPP → Agent B
     ↓
Agent B delivers data → Agent A continues work
```

**Target:** Anyone building autonomous agent systems (CrewAI, AutoGPT, etc.)

### 11.5 SaaS with AI Spending Limits

```
SaaS Platform deploys MCP Server with:
- Per-user wallets (Durable Objects)
- Spending limits ($10/day per user)
- Audit logs

Users' AI agents can spend within limits without manual approval.
```

**Target:** Platforms offering AI assistants to customers with controlled spending.

### 11.6 Target Customer Segments

| Segment | Need | Value Prop |
|---------|------|------------|
| **Individual developers** | "I want my Claude to pay for stuff" | Simple setup, low cost |
| **AI startups** | "Our agents need payment capabilities" | API-first, multi-chain |
| **Enterprises** | "Controlled AI spending with audit trails" | Limits, compliance, logs |
| **Cloudflare customers** | "Already here, easy to add payments" | Native integration |

---

## 12. Roadmap

### Phase 1: MVP (Week 1-2)
- [ ] MCP protocol handler
- [ ] Basic tools (init, status, pay)
- [ ] Single-chain support (Base)
- [ ] Cloudflare Worker deployment

### Phase 2: Full Features (Week 3-4)
- [ ] All tools implemented
- [ ] Multi-chain support
- [ ] Service discovery
- [ ] Transaction history

### Phase 3: Polish (Week 5-6)
- [ ] One-click deploy button
- [ ] Claude Desktop integration guide
- [ ] ChatGPT Actions guide
- [ ] Workers AI example

### Phase 4: Launch
- [ ] Documentation site
- [ ] Blog post announcement
- [ ] Discord/community promotion
- [ ] Submit to MCP directory

---

## 13. Success Metrics

| Metric | Target (3 months) |
|--------|-------------------|
| Deployments | 100+ |
| Monthly tool calls | 10,000+ |
| Payment volume | $1,000+ |
| GitHub stars | 50+ |

---

## 14. Open Questions

1. **State management:** Durable Objects vs KV vs D1?
   - Recommendation: Durable Objects for wallet state (strong consistency)

2. **Multi-tenant:** One deployment per user or shared?
   - Recommendation: Start with one-per-user, add multi-tenant later

3. **Testnet:** Include testnet support from day 1?
   - Recommendation: Yes, essential for developer onboarding

4. **Pricing:** Free tier limits?
   - Recommendation: 100 calls/day free, paid for more

---

## 15. References

- [MCP Specification](https://modelcontextprotocol.io/docs)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [MoltsPay UPP Protocol](https://moltspay.com/docs)
- [UPP Whitepaper](~/clawd/projects/payment-agent/docs/WHITEPAPER.md)
- [Existing Cloudflare Plugin](https://github.com/Yaqing2023/cloudflare-plugin)

---

*Document version: 1.2*  
*Last updated: 2026-03-29*  
*Changes: v1.1 deployment/use cases, v1.2 enhanced security model (§4.4-4.6)*
