# USDT Support Plan

Add USDT as a second supported stablecoin alongside USDC.

## Why USDT?

- Largest stablecoin by volume
- Dominant in Asian markets
- Many users already hold it
- Available on Base chain

## Implementation

### 1. Token Configuration

**File: `src/types/index.ts`** - Add token types:

```typescript
// Add new types
export type TokenSymbol = 'USDC' | 'USDT';

export interface TokenConfig {
  address: string;
  decimals: number;
  symbol: TokenSymbol;
}

// Update ChainConfig - change single usdc to tokens object
export interface ChainConfig {
  name: string;
  chainId: number;
  rpc: string;
  tokens: Record<TokenSymbol, TokenConfig>;  // NEW (replaces usdc field)
  explorer: string;
  explorerTx: string;
  avgBlockTime: number;
}
```

**File: `src/chains/index.ts`** - Add USDT addresses:

```typescript
base: {
  name: 'Base',
  chainId: 8453,
  rpc: 'https://mainnet.base.org',
  tokens: {
    USDC: {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      decimals: 6,
      symbol: 'USDC'
    },
    USDT: {
      address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
      decimals: 6,
      symbol: 'USDT'
    }
  },
  explorer: 'https://basescan.org/address/',
  explorerTx: 'https://basescan.org/tx/',
  avgBlockTime: 2,
},
// ... repeat for polygon, ethereum, testnets
```

**USDT Contract Addresses:**
| Chain | Address |
|-------|---------|
| Base | `0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2` |
| Polygon | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` |
| Ethereum | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |

### 2. SDK Changes (moltspay package)

**File: `src/wallet/Wallet.ts`** (or SecureWallet.ts)
- Update `transfer()` to accept `token` parameter (default: "USDC")
- Update `getBalance()` to return balances for all tokens
- Example: `agent.transfer({ to, amount, token: "USDT" })`

**File: `src/verify/index.ts`**
- Update `verifyPayment()` to detect token from tx data
- Return `token` field in verification result

**File: `src/cli/index.ts`**
- Add `--token` flag to pay command
- Update status command to show all balances
```bash
npx moltspay pay https://example.com service-id --token usdt --prompt "..."
npx moltspay status  # shows: USDC: $50.00 | USDT: $25.00
```

**File: `src/types/index.ts`**
- Update `TransferParams` to include `token?: TokenSymbol`
- Update `WalletBalance` to include `usdt: string`

### 3. Service Provider Config

Extend `moltspay.services.json` schema:

```json
{
  "provider": {
    "name": "Zen7 Video",
    "wallet": "0x..."
  },
  "services": [
    {
      "id": "text-to-video",
      "function": "textToVideo",
      "price": 0.99,
      "currency": "USDC",
      "acceptedCurrencies": ["USDC", "USDT"]
    }
  ]
}
```

- `currency` - display/primary currency (required)
- `acceptedCurrencies` - tokens accepted for payment (optional, defaults to `[currency]`)

Backward compatible: services without `acceptedCurrencies` only accept the primary currency.

### 3.1 Schema Backward Compatibility

**Old config (still works):**
```json
{
  "services": [{
    "id": "text-to-video",
    "price": 0.99,
    "currency": "USDC"
  }]
}
```
→ Automatically accepts only USDC

**New config (multi-token):**
```json
{
  "services": [{
    "id": "text-to-video",
    "price": 0.99,
    "currency": "USDC",
    "acceptedCurrencies": ["USDC", "USDT"]
  }]
}
```
→ Accepts both USDC and USDT

**Implementation in `src/server/index.ts`:**
```typescript
// When loading service config
function parseService(service: ServiceConfig) {
  return {
    ...service,
    // Default to [currency] if acceptedCurrencies not specified
    acceptedCurrencies: service.acceptedCurrencies ?? [service.currency]
  };
}
```

**Rules:**
- `currency` (required) - Primary/display currency, used for pricing display
- `acceptedCurrencies` (optional) - Array of tokens accepted for payment
- If omitted, defaults to `[currency]` - no breaking change for existing providers
- Price is always denominated in `currency`, other tokens accepted at 1:1 (both are USD stablecoins)

### 4. Payment Flow Update

**Discovery:**
1. Client calls `GET /services`
2. Response includes `acceptedCurrencies` for each service
3. Client checks own balances

**Payment:**
1. Client picks token based on balance/preference
2. Client sends payment in chosen token
3. Server verifies payment, detects token from tx
4. Server confirms regardless of which accepted token was used

**Auto-selection logic (optional):**
```typescript
// Pick token with sufficient balance, prefer USDC
const token = balances.usdc >= price ? "usdc" 
            : balances.usdt >= price ? "usdt" 
            : null;
```

### 5. Testing

- [ ] Unit tests for multi-token transfers
- [ ] Unit tests for token detection in verification
- [ ] Integration test on Base Sepolia testnet
- [ ] Update Zen7 service to accept both tokens
- [ ] End-to-end test: pay with USDT, verify, deliver

## Estimate

~2-3 days of work

## File Checklist

| File | Changes |
|------|---------|
| `src/types/index.ts` | Add `TokenSymbol`, `TokenConfig`, update `ChainConfig`, `TransferParams`, `WalletBalance` |
| `src/chains/index.ts` | Replace `usdc` field with `tokens` object for all chains |
| `src/wallet/Wallet.ts` | Add `token` param to transfer, multi-token balance |
| `src/wallet/SecureWallet.ts` | Same as above |
| `src/verify/index.ts` | Detect token from tx, return in result |
| `src/cli/index.ts` | Add `--token` flag, update status output |
| `src/server/index.ts` | Parse `acceptedCurrencies` from services.json |
| `src/client/index.ts` | Auto-select token based on balance |

## Future Considerations

- **EURC** - Euro stablecoin for European users
- **DAI** - Decentralized option for DeFi users
- **Dynamic pricing** - Same USD price, different token amounts
- **Token conversion** - Auto-swap on receipt (via DEX)
