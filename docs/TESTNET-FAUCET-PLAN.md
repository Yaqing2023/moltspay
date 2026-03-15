# MoltsPay Testnet Faucet Plan

## Overview

Enable new agents to get testnet USDC for testing MoltsPay x402 payments without needing real funds.

## Key Insight: Chain Auto-Detection

**Providers don't need separate testnet/mainnet configuration.**

The x402 protocol includes the `network` field in the payment header:
```typescript
interface X402PaymentPayload {
  network: string;  // "eip155:8453" (Base) or "eip155:84532" (Base Sepolia)
  // ...
}
```

Flow:
1. Client runs `npx moltspay pay --chain base_sepolia ...`
2. Payment header includes `network: "eip155:84532"`
3. Server reads `payment.network` → verifies on that chain
4. No `USE_MAINNET` env var needed on provider side

## Provider Configuration

To accept both mainnet and testnet, providers configure `chains` array in manifest:

```json
{
  "provider": {
    "name": "My Service",
    "wallet": "0x...",
    "chains": ["base", "base_sepolia", "polygon"]
  }
}
```

Network ID is auto-derived from chain name via `CHAIN_TO_NETWORK` mapping:
- `base` → `eip155:8453`
- `base_sepolia` → `eip155:84532`
- `polygon` → `eip155:137`

The 402 response will advertise all configured chains as accepted options.

## Faucet Implementation

### Endpoint

```
POST /faucet
{
  "address": "0x...",
  "chain": "base_sepolia"  // only testnet allowed
}
```

### Response

```json
{
  "success": true,
  "amount": "10.0",
  "token": "USDC",
  "chain": "base_sepolia",
  "transaction": "0x..."
}
```

### Rate Limiting

- 1 USDC per request (enough for 100 test transactions at $0.01)
- Max 1 request per address per 24 hours
- Total daily limit: 100 USDC

### Security

- Only Base Sepolia (testnet) - never mainnet
- Requires valid Ethereum address
- IP-based rate limiting as backup
- Optional: require Discord/GitHub OAuth to prevent abuse

## CLI Integration

```bash
# Request testnet USDC
npx moltspay faucet

# Or specify address
npx moltspay faucet --address 0x...
```

The CLI will:
1. Check if wallet exists (`~/.moltspay/wallet.json`)
2. If not, prompt to run `npx moltspay init --chain base_sepolia` first
3. Request from faucet endpoint
4. Show balance after

## Implementation Status

### Phase 1: Multi-Chain Provider Support ✅ COMPLETE

- [x] `payment.network` read from payment header
- [x] `getWalletForNetwork()` returns correct wallet
- [x] `getProviderChains()` supports both string array `["base"]` and object array
- [x] 402 response advertises all configured chains
- [x] Schema updated to use simple string array format
- [x] CLI supports `--chain base_sepolia` for init/pay/fund/list
- [x] `fund` command shows faucet links for testnet

### Phase 2: Faucet Backend ✅ COMPLETE

1. ✅ Create faucet wallet on Base Sepolia: `0x145E00f48b98E2829f803Be53418230e47943a8A`
2. ✅ Fund with testnet USDC (20 USDC from Circle faucet)
3. ✅ Implement `/faucet` endpoint with rate limiting (moltspay-creators)
4. ✅ Store request history (SQLite faucet_requests table)

**Endpoints:**
- `POST https://moltspay.com/api/v1/faucet` - Request 1 USDC
- `GET https://moltspay.com/api/v1/faucet/status` - Check availability

### Phase 3: CLI Command ✅ COMPLETE

1. ✅ Add `faucet` command to CLI
2. ✅ Auto-detect wallet address from ~/.moltspay/wallet.json
3. ✅ Pretty print result with balance

**Usage:**
```bash
npx moltspay faucet                    # Use your wallet
npx moltspay faucet --address 0x...    # Specify address
```

### Phase 4: Documentation (TODO)

1. Update README with testnet quickstart
2. Add faucet to onboarding flow
3. Document rate limits

## Faucet Wallet Setup

```bash
# Create dedicated faucet wallet
npx moltspay init --chain base_sepolia --name faucet

# Fund from Circle testnet faucet:
# https://faucet.circle.com/

# Or bridge from Sepolia:
# https://testnets.superbridge.app/
```

## Testnet USDC Sources

1. **Circle Faucet**: https://faucet.circle.com/ (requires account)
2. **Superbridge**: Bridge from Sepolia ETH

## Timeline

- Week 1: Multi-chain manifest documentation ✅
- Week 2: Faucet backend implementation
- Week 3: CLI integration + testing
- Week 4: Launch with docs
