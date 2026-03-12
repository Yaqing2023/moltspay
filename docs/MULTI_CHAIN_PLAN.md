# MoltsPay Multi-Chain Wallet Support

## Goal

Support Base and Polygon with a single wallet.

## Design Principles

1. **Explicit chain selection** - No auto-detection
2. **Default always Base** - For backward compatibility, no config needed
3. **Fail fast on mismatch** - If client chain ≠ server chain, error immediately
4. **One wallet, multiple chains** - Same private key works on all EVM chains
5. **No config migration** - Old configs work as-is

---

## Supported Chains

| Chain | Chain ID | USDC Contract | CDP Support |
|-------|----------|---------------|-------------|
| Base | 8453 | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | ✅ |
| Polygon | 137 | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | ✅ |

Note: Ethereum mainnet not supported by CDP x402 facilitator. Solana supported but out of scope (not EVM).

---

## Current State (v0.9.7)

```
~/.moltspay/
├── wallet.json    # { address, privateKey }
└── config.json    # { chain: "base", limits: {...} }
```

- Wallet tied to one chain
- No way to pay on different chain

---

## Proposed Changes

### Config

**No changes to config structure.** 

Old configs work as-is. The `chain` field in config is ignored for payment - we always default to Base unless `--chain` is specified.

```json
// ~/.moltspay/config.json (unchanged)
{
  "chain": "base",
  "limits": {
    "maxPerTx": 100,
    "maxPerDay": 1000
  }
}
```

### CLI Changes

#### `moltspay init`

**No changes.** Creates wallet as before.

```bash
moltspay init
```

#### `moltspay config`

**No changes.** Sets limits as before.

```bash
moltspay config --max-per-tx 50 --max-per-day 500
```

#### `moltspay status`

**Changed:** Shows balances on ALL supported chains.

```bash
moltspay status

MoltsPay Wallet Status
━━━━━━━━━━━━━━━━━━━━━━━
Address: 0x1234...5678

Balances:
  Base:      12.50 USDC
  Polygon:    5.00 USDC

Spending Limits:
  Per Transaction: $100.00
  Daily:           $1000.00
  Today's Spending: $2.50
```

Note: Queries 2 RPC endpoints, may be slightly slower.

#### `moltspay pay`

**Changed:** Add optional `--chain` flag.

```bash
# Default: uses Base
moltspay pay https://provider.com service --prompt "test"

# Explicit: uses Polygon
moltspay pay https://provider.com service --prompt "test" --chain polygon
```

**Validation:**
1. If `--chain` specified, validate it's supported (base/polygon/ethereum)
2. Check if server accepts this chain (from 402 response)
3. If mismatch, fail with clear error

### SDK Changes

#### PayOptions

```typescript
interface PayOptions {
  token?: 'USDC' | 'USDT';
  autoSelect?: boolean;
  chain?: 'base' | 'polygon';  // NEW - optional
}
```

#### MoltsPayClient.pay()

```typescript
// Default: uses Base
const result = await client.pay(serverUrl, 'service', params);

// Explicit: uses Polygon  
const result = await client.pay(serverUrl, 'service', params, { 
  chain: 'polygon' 
});
```

#### MoltsPayClient.getAllBalances()

```typescript
// NEW method - get balances on all chains
const balances = await client.getAllBalances();
// Returns: { 
//   base: { usdc: 12.5, usdt: 0, native: 0.001 },
//   polygon: { usdc: 5.0, usdt: 0, native: 0 }
// }
```

### CDP Facilitator

Update `supportedNetworks` to include Polygon:

```typescript
this.supportedNetworks = this.useMainnet 
  ? ['eip155:8453', 'eip155:137']  // Base + Polygon
  : ['eip155:8453', 'eip155:84532', 'eip155:137'];
```

---

## Error Handling

| Scenario | Error Message |
|----------|---------------|
| Unknown chain | `Error: Unknown chain: xyz. Supported: base, polygon` |
| Chain mismatch | `Error: Chain mismatch. Server requires: polygon (eip155:137). You specified: base (eip155:8453). Use --chain polygon` |
| Insufficient balance | `Error: Insufficient USDC on polygon. Have: $2.00, Need: $5.00` |

---

## Implementation Phases

### Phase 1: Status multi-chain
- Add `getAllBalances()` method to client
- Update `status` command to show all chains
- No breaking changes

### Phase 2: Pay with --chain  
- Add `--chain` option to CLI pay command
- Add `chain` option to SDK PayOptions
- Validate chain is supported
- Check server accepts chain, fail with clear error if mismatch
- Default to Base when not specified

### Phase 3: CDP Facilitator
- Add Polygon to supportedNetworks
- Test with CDP mainnet on Polygon

---

## Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| Old config with `chain: "base"` | Works, ignored for payment, Base used by default |
| `moltspay pay` without --chain | Uses Base (always) |
| Old SDK code without chain option | Uses Base (always) |

**No migration needed. No breaking changes.**

---

## Testing Checklist

- [ ] `status` shows balances on Base and Polygon
- [ ] `pay` without --chain uses Base
- [ ] `pay --chain polygon` uses Polygon
- [ ] `pay --chain xyz` fails with "unknown chain"
- [ ] `pay --chain polygon` to Base-only server fails with clear mismatch error
- [ ] Insufficient balance shows correct error with amount needed
- [ ] Old configs work without changes
- [ ] Old SDK code works without changes

---

*Status: DRAFT - Awaiting approval*
