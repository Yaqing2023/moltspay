# MoltsPay Multi-Chain Support Design

## Design Decisions

| Decision | Choice |
|----------|--------|
| Who picks chain? | **Client (payer)** |
| Cross-chain payments? | **No** - same chain in, same chain out |
| Wallet addresses | **Same address** across EVM chains |

## Architecture

```
+--------------------------------------------------------------------------------------------------------------------------------------+
|                         Client Wallet                            |
|  Address: 0xABC123...                                           |
|  +------------------------------+  +------------------------------+  +------------------------------+             |
|  |    Base     |  |   Polygon   |  |  Arbitrum   |             |
|  |  50.0 USDC  |  |  25.0 USDC  |  |  10.0 USDC  |             |
|  |  10.0 USDT  |  |  15.0 USDT  |  |   0.0 USDT  |             |
|  +------------------------------+  +------------------------------+  +------------------------------+             |
+--------------------------------------------------------------------------------------------------------------------------------------+
                              |
                              | Client chooses: Polygon + USDC
                              v
+--------------------------------------------------------------------------------------------------------------------------------------+
|                      Service Provider                            |
|  Wallet: 0xDEF456...                                            |
|  Accepts: Base, Polygon, Arbitrum                               |
|                                                                  |
|  Payment arrives on Polygon -> Provider receives on Polygon      |
+--------------------------------------------------------------------------------------------------------------------------------------+
```

## Supported Chains (Phase 1)

| Chain | Chain ID | USDC Address | USDT Address | Priority |
|-------|----------|--------------|--------------|----------|
| Base | 8453 | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2 | Current |
| Polygon | 137 | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | 0xc2132D05D31c914a87C6611C10748AEb04B58e8F | Next |
| Arbitrum | 42161 | 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 | 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9 | Future |
| Optimism | 10 | 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85 | 0x94b008aA00579c1307B0EF2c499aD98a8ce58e58 | Future |

## Provider Config

**No schema changes needed.** Existing config works:

```json
{
  "provider": {
    "name": "My Service",
    "wallet": "0xDEF456...",
    "chain": "base"
  },
  "services": [{
    "id": "text-to-video",
    "price": 0.99,
    "currency": "USDC"
  }]
}
```

- `chain`: Optional hint/preference (default: base)
- Client can pay on any supported chain regardless of this setting
- Provider receives on whatever chain client pays (same wallet address)

## Client Flow

### CLI

```bash
# Check balances across chains
npx moltspay status
# Output:
# Wallet: 0xABC123...
# Balances:
#   Base:     50.00 USDC, 10.00 USDT
#   Polygon:  25.00 USDC, 15.00 USDT

# Pay with specific chain
npx moltspay pay https://example.com service-id \
  --chain polygon \
  --token USDC \
  --prompt "hello"

# Auto-select cheapest chain with sufficient balance
npx moltspay pay https://example.com service-id \
  --auto-chain \
  --prompt "hello"
```

### SDK

```typescript
const client = new MoltsPayClient();

// Check all balances
const balances = await client.balances();
// { base: { USDC: 50, USDT: 10 }, polygon: { USDC: 25, USDT: 15 } }

// Pay on specific chain
const result = await client.execute(
  'https://example.com',
  'service-id',
  { prompt: 'hello' },
  { chain: 'polygon', token: 'USDC' }
);

// Auto-select chain
const result = await client.execute(
  'https://example.com',
  'service-id',
  { prompt: 'hello' },
  { autoChain: true }
);
```

## Server Flow

### Service Discovery Response

```json
{
  "services": [...],
  "provider": {
    "wallet": "0xDEF456...",
    "chain": "base"
  }
}
```

### 402 Response

```json
{
  "price": 0.99,
  "currency": "USDC",
  "payTo": "0xDEF456..."
}
```

### Payment Header

```
X-Payment: base64({
  "chain": "polygon",
  "token": "USDC",
  "signature": "0x...",
  ...
})
```

Server validates:
1. Chain is supported by MoltsPay
2. Payment verified on the specified chain

## Wallet Storage

```json
{
  "address": "0xABC123...",
  "privateKey": "encrypted:...",
  "chains": {
    "base": {
      "enabled": true,
      "rpc": "https://mainnet.base.org"
    },
    "polygon": {
      "enabled": true,
      "rpc": "https://polygon-rpc.com"
    }
  },
  "limits": {
    "maxPerTx": 10,
    "maxPerDay": 100
  }
}
```

## Implementation Phases

### Phase 1: Polygon Support
- [ ] Add Polygon chain config (RPC, token addresses)
- [ ] Update `balances()` to check multiple chains
- [ ] Add `--chain` flag to CLI
- [ ] Update x402 flow to include chain
- [ ] Server-side chain validation
- [ ] Test on Polygon mainnet

### Phase 2: Auto-Chain Selection
- [ ] Implement cheapest-chain algorithm
- [ ] Consider gas costs per chain
- [ ] Add `--auto-chain` flag

### Phase 3: Additional Chains
- [ ] Arbitrum
- [ ] Optimism
- [ ] (Solana - requires different approach)

## Gas Comparison

| Chain | Avg Gas (USDC transfer) | Cost |
|-------|------------------------|------|
| Base | ~0.001 USD | Lowest |
| Polygon | ~0.01 USD | Very Low |
| Arbitrum | ~0.05 USD | Low |
| Optimism | ~0.05 USD | Low |
| Ethereum | ~2-10 USD | High |

## Open Questions

1. ~~Who picks the chain?~~ -> Client
2. ~~Cross-chain payments?~~ -> No
3. ~~Same or different wallet addresses?~~ -> Same
4. ~~Schema changes needed?~~ -> No, existing `chain` field is enough
5. Should we show gas estimates before payment?
6. Minimum balance to enable a chain?
