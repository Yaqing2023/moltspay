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
    "chains": [
      { "network": "eip155:8453", "chain": "base" },
      { "network": "eip155:84532", "chain": "base_sepolia" }
    ]
  }
}
```

The 402 response will advertise both chains as accepted options.

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

- 10 USDC per request
- Max 1 request per address per 24 hours
- Total daily limit: 1000 USDC (100 requests)

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

## Implementation Steps

### Phase 1: Multi-Chain Provider Support ✅

Already implemented:
- [x] `payment.network` read from payment header
- [x] `getWalletForNetwork()` returns correct wallet
- [x] `getProviderChains()` reads from manifest
- [x] 402 response advertises all configured chains

### Phase 2: Faucet Backend

1. Create faucet wallet on Base Sepolia
2. Fund with testnet USDC (get from Circle faucet)
3. Implement `/faucet` endpoint with rate limiting
4. Store request history (SQLite or JSON file)

### Phase 3: CLI Command

1. Add `faucet` command to CLI
2. Auto-detect wallet address
3. Pretty print result with balance

### Phase 4: Documentation

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

## Code Changes Needed

### 1. Remove USE_MAINNET dependency

The server already reads chain from payment header. Just need to:
- Update docs to clarify no `USE_MAINNET` needed
- Ensure `chains` array in manifest is the canonical config

### 2. Add faucet endpoint

New file: `src/server/faucet.ts`
- Rate limiting logic
- Transfer testnet USDC
- Request history

### 3. CLI faucet command

New file: `src/cli/faucet.ts`
- Parse args
- Call faucet endpoint
- Show result

## Testnet USDC Sources

1. **Circle Faucet**: https://faucet.circle.com/ (requires account)
2. **Superbridge**: Bridge from Sepolia ETH
3. **Base Sepolia Faucet**: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet

## Timeline

- Week 1: Multi-chain manifest documentation
- Week 2: Faucet backend implementation
- Week 3: CLI integration + testing
- Week 4: Launch with docs
