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

## Future Releases

### v0.10.0 - Multi-Chain
- [ ] Polygon support
- [ ] Ethereum mainnet support
- [ ] Chain-specific facilitator selection

### v0.11.0 - Escrow
- [ ] Smart contract escrow for high-value transactions
- [ ] Dispute resolution
- [ ] Timeout refunds

### v1.0.0 - Production Ready
- [ ] On-chain service registry
- [ ] Reputation system
- [ ] Subscription payments
- [ ] Full audit

---

## Links

- [ChaosChain x402](https://github.com/ChaosChain/chaoschain-x402)
- [Questflow Facilitator](https://facilitator.questflow.ai/)
- [x402 Ecosystem](https://www.x402.org/ecosystem?category=facilitators)
- [Coinbase CDP Docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)

---

*Last updated: 2026-02-19*
