# MoltsPay Roadmap

## Next Release: v0.9.0 - Multi-Facilitator Support

**Goal:** True decentralization - no single point of failure

### Why Multi-Facilitator?

Currently MoltsPay depends on Coinbase CDP facilitator:
- If Coinbase goes down → payments stop
- Single entity controls execution
- Not truly decentralized

With multi-facilitator:
- One facilitator down → auto-switch to another
- Competition drives down costs
- True decentralized agent economy

### Facilitator Ecosystem

| Facilitator | Type | Pricing | Status |
|-------------|------|---------|--------|
| **Coinbase CDP** | Centralized | 1000/mo free, then $0.001/tx | ✅ Supported |
| **ChaosChain** | Decentralized (Chainlink CRE) | Open source / TBD | 🔜 v0.9.0 |
| **Questflow** | Centralized | TBD | 🔜 v0.9.0 |
| **PayAI** | Centralized | $0.0028/tx (bulk) | 🔜 Future |

### Proposed API

#### Server Configuration

```typescript
// moltspay.services.json
{
  "provider": {
    "name": "My Service",
    "wallet": "0x...",
    "chain": "base"
  },
  "facilitators": {
    "primary": "cdp",
    "fallback": ["chaoschain", "questflow"],
    "strategy": "failover"  // or "cheapest", "fastest", "random"
  },
  "services": [...]
}
```

#### Environment Variables

```env
# ~/.moltspay/.env

# Coinbase CDP (current)
CDP_API_KEY_ID=xxx
CDP_API_KEY_SECRET=xxx

# ChaosChain (new)
CHAOSCHAIN_ENDPOINT=https://x402.chaoschain.io
CHAOSCHAIN_API_KEY=xxx  # optional, for managed service

# Questflow (new)  
QUESTFLOW_ENDPOINT=https://facilitator.questflow.ai
QUESTFLOW_API_KEY=xxx
```

#### SDK Usage

```typescript
import { MoltsPayServer } from 'moltspay';

const server = new MoltsPayServer('./services.json', {
  facilitators: {
    primary: 'cdp',
    fallback: ['chaoschain'],
    strategy: 'failover',
    
    // Optional: custom config per facilitator
    config: {
      cdp: {
        apiKeyId: process.env.CDP_API_KEY_ID,
        apiKeySecret: process.env.CDP_API_KEY_SECRET,
      },
      chaoschain: {
        endpoint: 'https://x402.chaoschain.io',
      }
    }
  }
});
```

### Selection Strategies

| Strategy | Behavior |
|----------|----------|
| `failover` | Use primary, switch to fallback on failure |
| `cheapest` | Query all, use lowest fee |
| `fastest` | Query all, use first response |
| `random` | Random selection (load balancing) |
| `roundrobin` | Rotate through facilitators |

### Implementation Plan

#### Phase 1: Abstraction Layer
- [ ] Create `Facilitator` interface
- [ ] Refactor CDP into `CDPFacilitator` class
- [ ] Add facilitator registry

#### Phase 2: ChaosChain Integration
- [ ] Implement `ChaosChainFacilitator`
- [ ] Test with ChaosChain testnet
- [ ] Add to facilitator registry

#### Phase 3: Questflow Integration
- [ ] Implement `QuestflowFacilitator`
- [ ] Test integration
- [ ] Add to registry

#### Phase 4: Selection Strategies
- [ ] Implement failover strategy
- [ ] Implement cheapest strategy
- [ ] Implement fastest strategy
- [ ] Add health checking / circuit breaker

#### Phase 5: CLI Updates
- [ ] `npx moltspay facilitators` - list available
- [ ] `npx moltspay facilitator add <name>` - configure new
- [ ] `npx moltspay facilitator test` - test all configured

### Facilitator Interface

```typescript
interface Facilitator {
  name: string;
  
  // Check if facilitator is available
  healthCheck(): Promise<boolean>;
  
  // Verify payment signature
  verify(
    paymentPayload: X402PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<VerifyResult>;
  
  // Settle payment on-chain
  settle(
    paymentPayload: X402PaymentPayload,
    requirements: PaymentRequirements
  ): Promise<SettleResult>;
  
  // Get current fee (for cheapest strategy)
  getFee?(): Promise<{ perTx: number; currency: string }>;
}
```

### Migration Path

**v0.8.x → v0.9.0:**
- Fully backward compatible
- If no `facilitators` config, defaults to CDP (current behavior)
- New config is opt-in

```typescript
// Old (still works)
const server = new MoltsPayServer('./services.json');

// New (opt-in multi-facilitator)
const server = new MoltsPayServer('./services.json', {
  facilitators: { primary: 'cdp', fallback: ['chaoschain'] }
});
```

---

## v1.0.0 - Hosted Skill Marketplace

**Goal:** Zero-setup monetization for skill developers

### The Vision

Any developer can monetize their skill without running a server:

```
Developer: Upload skill + set wallet + set prices
Platform: Hosts, scales, handles payments
Users: Pay developer directly (P2P on-chain)
```

### Why This Matters

**For Developers:**
- No server to maintain
- No CDP credentials needed
- No DevOps knowledge required
- Just upload and earn

**For Users:**
- One marketplace to discover skills
- Consistent UX across all skills
- Trust through transparency (on-chain payments)

**Regulatory Advantage:**
- Payments are P2P (buyer → seller wallet directly)
- Platform never holds funds (non-custodial)
- No money transmission = no MSB license
- We're just infrastructure (like AWS/Vercel)

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│           MoltsPay Skill Marketplace                    │
│                  (moltspay.com)                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │
│  │ Skill A │  │ Skill B │  │ Skill C │  │ Skill D │    │
│  │ @dev1   │  │ @dev2   │  │ @dev3   │  │ @dev4   │    │
│  │ 0x111   │  │ 0x222   │  │ 0x333   │  │ 0x444   │    │
│  │ $0.50   │  │ $1.00   │  │ $2.00   │  │ $0.25   │    │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘    │
│                                                         │
│  Payment flow: Client → Developer wallet (direct)       │
│  Platform fee: 0% or minimal (sustainability)          │
└─────────────────────────────────────────────────────────┘
```

### Developer Experience

```bash
# Upload skill to marketplace
npx moltspay publish ./my-skill --wallet 0xMyWallet

# Update pricing
npx moltspay pricing my-skill --price 1.99

# View earnings dashboard
npx moltspay dashboard
```

### User Experience

```bash
# Discover skills
npx moltspay search "video generation"

# Use skill (pays developer directly)
npx moltspay pay moltspay.com/skills/video-gen text-to-video --prompt "..."

# Or via web UI at moltspay.com/marketplace
```

### Implementation Plan

#### Phase 1: Skill Registry
- [ ] Skill upload endpoint
- [ ] Skill validation (runs, exports correct functions)
- [ ] Skill storage (S3/GCS)
- [ ] Developer dashboard (earnings, usage)

#### Phase 2: Execution Runtime
- [ ] Isolated skill execution (Docker/Firecracker)
- [ ] Auto-scaling
- [ ] Timeout handling
- [ ] Output storage

#### Phase 3: Marketplace UI
- [ ] Browse/search skills
- [ ] Skill detail pages
- [ ] Developer profiles
- [ ] Usage analytics

#### Phase 4: Monetization
- [ ] Optional platform fee (e.g., 5%)
- [ ] Featured listings
- [ ] Enterprise tier

### Business Model Options

| Model | Platform Cut | Developer Cut | Notes |
|-------|-------------|---------------|-------|
| **Free** | 0% | 100% | Growth phase |
| **Sustainable** | 5% | 95% | Cover infra costs |
| **Premium** | 10% | 90% | + featured listings |

Platform fee is transparent and on-chain - developers always know exactly what they earn.

---

## Future Releases

### v1.1.0 - Multi-Chain
- [ ] Polygon support
- [ ] Ethereum mainnet support
- [ ] Chain-specific facilitator selection

### v1.2.0 - Escrow & Trust
- [ ] Smart contract escrow for high-value transactions
- [ ] Dispute resolution
- [ ] Timeout refunds
- [ ] On-chain reputation system

### v1.3.0 - Advanced Features
- [ ] Subscription payments
- [ ] Usage-based pricing (per-token, per-minute)
- [ ] Team wallets (multi-sig)
- [ ] API key management

---

## Links

- [ChaosChain x402](https://github.com/ChaosChain/chaoschain-x402)
- [Questflow Facilitator](https://facilitator.questflow.ai/)
- [x402 Ecosystem](https://www.x402.org/ecosystem?category=facilitators)
- [Coinbase CDP Docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)

---

*Last updated: 2026-02-19*
