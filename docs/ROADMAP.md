# MoltsPay Roadmap

## Current Version: v0.9.4

### v0.9.x Summary - Multi-Facilitator Foundation ✅

**Goal:** Pluggable facilitator architecture for future decentralization

| Version | Release | Features |
|---------|---------|----------|
| v0.9.0 | 2026-02-20 | Facilitator abstraction layer, CDPFacilitator, FacilitatorRegistry, selection strategies |
| v0.9.1 | 2026-02-20 | Env var configuration (`FACILITATOR_PRIMARY`, `FACILITATOR_FALLBACK`, `FACILITATOR_STRATEGY`) |
| v0.9.2 | 2026-02-21 | Proxy execute mode (`/proxy` with `execute: true` for marketplace integration) |
| v0.9.3 | 2026-02-23 | Include buyer address in proxy response |
| v0.9.4 | 2026-03-04 | Skill execution timeout (`SKILL_TIMEOUT_SECONDS`, default 1200s) |

### What's Implemented ✅

- [x] `Facilitator` interface for pluggable payment facilitators
- [x] `CDPFacilitator` class (Coinbase Developer Platform)
- [x] `FacilitatorRegistry` with selection strategies
- [x] Selection strategies: failover, cheapest, fastest, random, roundrobin
- [x] Env var configuration (no code changes to switch facilitators)
- [x] `/health` endpoint showing facilitator status
- [x] Proxy execute mode for marketplace integration

### Facilitator Ecosystem

| Facilitator | Type | Pricing | Mainnet | Status |
|-------------|------|---------|---------|--------|
| **Coinbase CDP** | Centralized | 1000/mo free, then $0.001/tx | ✅ Base | ✅ Production |
| **ChaosChain** | Decentralized (Chainlink CRE) | 1% per tx | ❌ Testnet only | ⏸️ Deferred |
| **Questflow** | Centralized | TBD | ❓ Unverified | ⏸️ Deferred |
| **PayAI** | Centralized | $0.0028/tx (bulk) | ❓ Unknown | 🔜 Future |

**Note:** ChaosChain and Questflow integration deferred until they have production mainnet support.
- ChaosChain: Only Base Sepolia (testnet), mainnet "coming soon"
- Questflow: Requires API key application, mainnet status unverified

### Configuration

#### Environment Variables

```env
# ~/.moltspay/.env

# Coinbase CDP (production-ready)
CDP_API_KEY_ID=xxx
CDP_API_KEY_SECRET=xxx
USE_MAINNET=true

# Facilitator selection
FACILITATOR_PRIMARY=cdp
FACILITATOR_FALLBACK=              # Empty until alternatives have mainnet
FACILITATOR_STRATEGY=failover
```

#### SDK Usage

```typescript
import { MoltsPayServer } from 'moltspay';

// Current recommended setup (CDP only)
const server = new MoltsPayServer('./services.json');

// Future: when alternatives have mainnet support
const server = new MoltsPayServer('./services.json', {
  facilitators: {
    primary: 'cdp',
    fallback: ['chaoschain'],  // When available
    strategy: 'failover'
  }
});
```

### Selection Strategies (Implemented)

| Strategy | Behavior |
|----------|----------|
| `failover` | Use primary, switch to fallback on failure |
| `cheapest` | Query all, use lowest fee |
| `fastest` | Query all, use first response |
| `random` | Random selection (load balancing) |
| `roundrobin` | Rotate through facilitators |

### Facilitator Interface

```typescript
interface Facilitator {
  name: string;
  displayName: string;
  supportedNetworks: string[];
  
  healthCheck(): Promise<HealthCheckResult>;
  verify(payload: X402PaymentPayload, requirements: X402PaymentRequirements): Promise<VerifyResult>;
  settle(payload: X402PaymentPayload, requirements: X402PaymentRequirements): Promise<SettleResult>;
  getFee?(): Promise<FacilitatorFee>;
  supportsNetwork(network: string): boolean;
}
```

---

## Future: v0.10.0 - Async Jobs (Deferred)

**Status:** Deferred - current sync model works for most use cases

**Goal:** Handle long-running skills with async job queue

### Original Issues - Status

| Issue | Status | Notes |
|-------|--------|-------|
| Synchronous execution | Acceptable | Video gen ~60-120s wait is tolerable |
| No skill timeout | ✅ **Fixed in v0.9.4** | `SKILL_TIMEOUT_SECONDS` env var |
| Settle after execution | ✅ Working correctly | Pay-for-success model |
| No rate limiting | Low priority | Client spending limits exist |

### Deferred Features

If async becomes necessary in the future:

- [ ] Job queue (Redis or in-memory)
- [ ] `GET /jobs/:id` endpoint for polling
- [ ] Webhook notifications for job completion
- [ ] Pre-pay + auto-refund for long tasks

---

## v1.0.0 - Hosted Skill Marketplace ✅

**Status:** Complete (simplified approach)

**Goal:** Enable skill developers to monetize their hosted skills via x402 payments.

### What We Built

Instead of a complex platform-hosted execution model, we implemented a simpler **"Hosted Skill"** approach:

1. **Developer hosts their own skill** (on their server, Railway, etc.)
2. **Developer adds `moltspay.services.json`** to configure pricing
3. **Users pay per use** via x402 protocol
4. **Payment goes directly to developer wallet** (P2P, non-custodial)

### Implementation ✅

| Component | Status | Location |
|-----------|--------|----------|
| Skills Directory | ✅ | MoltsPay Creators - 16k+ skills indexed |
| Skill Discovery | ✅ | GitHub + ClawHub auto-discovery |
| Pricing Schema | ✅ | `moltspay.services.json` |
| Products (Hosted Skill) | ✅ | MoltsPay Creators - Add Product |
| x402 Payment | ✅ | MoltsPay SDK |
| Developer Wallet | ✅ | Creator wallet in MoltsPay Creators |

### How It Works

```
Developer:
1. Hosts skill on their infrastructure
2. Adds moltspay.services.json with pricing
3. Runs: npx moltspay start ./skill --port 3000

User:
1. Discovers skill in MoltsPay Creators marketplace
2. Calls skill API with x402 payment header
3. Payment settles directly to developer wallet
```

### moltspay.services.json Schema

```json
{
  "provider": {
    "name": "Developer Name",
    "wallet": "0x...",
    "chain": "base"
  },
  "services": [{
    "id": "my-service",
    "function": "myFunction",
    "price": 0.99,
    "currency": "USDC"
  }]
}
```

### Why This Approach

- **Simpler:** No complex platform-hosted execution
- **Decentralized:** Developers control their own infrastructure
- **Non-custodial:** Platform never holds funds
- **Scalable:** Each developer scales their own service

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

### Future: Additional Facilitators

When these facilitators have mainnet support, implementation is straightforward:

1. Create `src/facilitators/<name>.ts` implementing `Facilitator` interface
2. Register in `FacilitatorRegistry`
3. Add env var support

**ChaosChain** (waiting for mainnet):
- Endpoint: `https://facilitator.chaoscha.in`
- No API key needed
- 1% fee
- Decentralized (BFT consensus)

**Questflow** (waiting for verification):
- Endpoint: `https://facilitator.questflow.ai`
- Requires API key
- Fee TBD

---

## Links

- [ChaosChain x402](https://github.com/ChaosChain/chaoschain-x402)
- [Questflow Facilitator](https://facilitator.questflow.ai/)
- [x402 Ecosystem](https://www.x402.org/ecosystem?category=facilitators)
- [Coinbase CDP Docs](https://docs.cdp.coinbase.com/x402/core-concepts/facilitator)

---

*Last updated: 2026-03-04*
