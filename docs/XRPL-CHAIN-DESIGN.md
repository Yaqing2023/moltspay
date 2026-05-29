# XRPL Chain Support Design

**Status:** Planned
**Priority:** Medium
**Target:** v1.2.0

---

## Overview

Add XRP Ledger (XRPL) support to MoltsPay, enabling payments with RLUSD (Ripple's USD stablecoin) on XRPL.

---

## Why XRPL?

| Feature | Value |
|---------|-------|
| **Speed** | 3-5 second finality |
| **Cost** | ~$0.0002 per transaction |
| **Stablecoin** | RLUSD (launched Dec 2024) |
| **Enterprise adoption** | Banks, payment providers |
| **Competitor use** | BlockRun.ai supports XRPL |

---

## Technical Analysis

### XRPL vs EVM Chains

| Aspect | XRPL | EVM Chains |
|--------|------|------------|
| **Smart Contracts** | No (uses Hooks, limited) | Yes (Solidity) |
| **Token Standard** | Trust Lines (IOU) | ERC-20 |
| **Signing** | ed25519 or secp256k1 | secp256k1 |
| **Address Format** | r... (Base58) | 0x... (Hex) |
| **SDK** | xrpl.js | ethers.js/viem |

### RLUSD Token

- **Issuer:** Ripple (rlusd.ripple.com)
- **Trust Line Required:** Yes (user must trust issuer)
- **Decimals:** 6 (same as USDC)
- **Networks:** XRPL Mainnet, XRPL Testnet

---

## Implementation Plan

### Phase 1: Chain Configuration

Add XRPL chain config:

```typescript
// src/config/chains.ts
{
  xrpl: {
    chainId: 0,  // XRPL doesn't use chainId
    name: 'XRP Ledger',
    network: 'xrpl:mainnet',
    rpcUrl: 'wss://xrplcluster.com',
    explorer: 'https://livenet.xrpl.org',
    token: {
      symbol: 'RLUSD',
      issuer: 'rlusd.ripple.com',  // Official RLUSD issuer
      decimals: 6
    },
    vm: 'xrpl'  // New VM type
  },
  xrpl_testnet: {
    chainId: 0,
    name: 'XRP Ledger Testnet',
    network: 'xrpl:testnet',
    rpcUrl: 'wss://s.altnet.rippletest.net:51233',
    explorer: 'https://testnet.xrpl.org',
    token: {
      symbol: 'RLUSD',
      issuer: 'rXXX...',  // Testnet issuer TBD
      decimals: 6
    },
    vm: 'xrpl'
  }
}
```

### Phase 2: Wallet Management

XRPL uses different key derivation:

```typescript
// src/wallet/xrpl.ts
import { Wallet } from 'xrpl';

export function createXRPLWallet(): { address: string; seed: string } {
  const wallet = Wallet.generate();
  return {
    address: wallet.address,  // r...
    seed: wallet.seed         // s... (secret)
  };
}

export function fromSeed(seed: string): Wallet {
  return Wallet.fromSeed(seed);
}
```

**CLI changes:**
```bash
moltspay init
# Creates both EVM wallet AND XRPL wallet
# Stores in ~/.moltspay/wallet.json:
# {
#   "evm": { "address": "0x...", "privateKey": "..." },
#   "xrpl": { "address": "r...", "seed": "s..." },
#   "solana": { "address": "...", "privateKey": "..." }
# }
```

### Phase 3: XRPLFacilitator

```typescript
// src/facilitators/xrpl.ts
import { Client, Payment, Wallet } from 'xrpl';

export class XRPLFacilitator implements Facilitator {
  name = 'xrpl';
  displayName = 'XRPL Self-Hosted';
  supportedNetworks = ['xrpl:mainnet', 'xrpl:testnet'];
  
  private client: Client;
  private serverWallet: Wallet;
  
  async settle(payload, requirements): Promise<SettleResult> {
    // 1. Verify payment intent signature
    // 2. Server submits Payment transaction
    // 3. Wait for validation
    // 4. Return tx hash
  }
}
```

### Phase 4: Payment Intent for XRPL

Since XRPL doesn't have EIP-712, we need a custom signing scheme:

```typescript
interface XRPLPaymentIntent {
  destination: string;      // Server wallet (r...)
  amount: string;           // RLUSD amount
  currency: 'RLUSD';
  issuer: string;           // RLUSD issuer
  invoiceId: string;        // Payment reference
  expiration: number;       // Unix timestamp
  clientSignature: string;  // Client signs this intent
}
```

**Flow:**
1. Client signs payment intent (off-chain)
2. Server receives signed intent
3. Server submits Payment tx (pays XRP gas)
4. Server returns result after validation

### Phase 5: CLI & SDK Updates

```bash
# Client pays on XRPL
moltspay pay https://service.com/api --chain xrpl

# Server status shows XRPL wallet
moltspay status
# XRPL: r9ABC... (100 RLUSD)

# Fund XRPL wallet
moltspay fund --chain xrpl
```

---

## Server Configuration

```json
// moltspay.services.json
{
  "provider": {
    "name": "My Service",
    "evm_wallet": "0x...",
    "solana_wallet": "...",
    "xrpl_wallet": "rABC..."
  },
  "services": [...]
}
```

---

## Trust Line Requirement

**Important:** RLUSD requires trust lines.

Before receiving RLUSD, both client and server wallets must set up trust lines to the RLUSD issuer:

```typescript
// One-time setup
const trustLine = {
  TransactionType: 'TrustSet',
  Account: wallet.address,
  LimitAmount: {
    currency: 'USD',
    issuer: RLUSD_ISSUER,
    value: '1000000'  // Max limit
  }
};
await client.submitAndWait(trustLine, { wallet });
```

**CLI helper:**
```bash
moltspay setup-trustline --chain xrpl
# Sets up RLUSD trust line for your wallet
```

---

## Gas/Reserve Requirements

XRPL has reserve requirements:

| Requirement | Amount |
|-------------|--------|
| **Base Reserve** | 10 XRP (account activation) |
| **Owner Reserve** | 2 XRP per trust line |
| **Transaction Fee** | ~0.00001 XRP |

**For servers:**
- Need 12 XRP minimum (10 base + 2 for RLUSD trust line)
- Need small XRP for tx fees

**For clients:**
- Same 12 XRP minimum
- Server can sponsor client transactions (similar to BNB gas sponsorship)

---

## Faucet Support

```bash
# Testnet faucet
moltspay faucet --chain xrpl_testnet
# Gets: 1000 XRP (testnet) + sets up RLUSD trust line + 100 test RLUSD
```

API:
```
POST https://moltspay.com/api/v1/faucet
{ "address": "rABC...", "chain": "xrpl_testnet" }
```

---

## Implementation Order

1. **Chain config** - Add xrpl/xrpl_testnet to chains.ts
2. **Wallet management** - XRPL key generation/storage
3. **XRPLFacilitator** - Settle payments on XRPL
4. **Client signing** - Payment intent signing for XRPL
5. **CLI commands** - init, status, pay, fund for XRPL
6. **Server support** - Accept xrpl_wallet in provider config
7. **Trust line helper** - CLI command to set up trust lines
8. **Faucet** - Testnet RLUSD faucet
9. **Documentation** - Update docs with XRPL support

---

## Dependencies

```json
{
  "xrpl": "^3.0.0"
}
```

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Trust line complexity | Provide CLI helper, auto-setup |
| XRP reserve cost | Document clearly, testnet faucet |
| RLUSD adoption | Monitor liquidity, fallback to XRP |
| Different signing | Custom intent format, clear docs |

---

## Success Criteria

- [ ] `moltspay init` creates XRPL wallet
- [ ] `moltspay pay --chain xrpl` works E2E
- [ ] `moltspay faucet --chain xrpl_testnet` works
- [ ] Server accepts RLUSD payments
- [ ] Trust line setup automated

---

## References

- [XRPL Documentation](https://xrpl.org/docs)
- [xrpl.js SDK](https://github.com/XRPLF/xrpl.js)
- [RLUSD Announcement](https://ripple.com/rlusd)
- [BlockRun XRPL Integration](https://blockrun.ai/docs)

---

*Created: 2026-03-29*
