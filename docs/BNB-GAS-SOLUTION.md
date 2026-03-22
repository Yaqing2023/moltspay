# BNB Chain Gas Solution

## Problem

BNB Chain stablecoins (USDC, USDT) do NOT support gasless methods:
- ❌ EIP-2612 (permit)
- ❌ EIP-3009 (transferWithAuthorization)

This means users MUST call `approve()` themselves, which requires BNB for gas.

Unlike Base/Polygon (where CDP Facilitator handles everything gaslessly), BNB requires a one-time gas payment from the user.

## Solution

**Pragmatic approach:** User provides tiny amount of BNB for the one-time approval.

| Chain | USDC Source | BNB Gas Source |
|-------|-------------|----------------|
| BNB Testnet | Faucet | Faucet (bundled) |
| BNB Mainnet | User funds | User funds |

### Cost Analysis

| Action | Gas Used | BNB Cost | USD Cost |
|--------|----------|----------|----------|
| approve() | ~46,000 | ~0.00014 BNB | ~$0.00008 |
| Buffer (send) | - | 0.001 BNB | ~$0.0006 |

After approval, all subsequent payments are **gasless** (facilitator pays transferFrom gas).

## Implementation

### Part 1: BNB Testnet Faucet Update

**File:** `moltspay-creators/src/routes/faucet.ts`

**Current behavior:**
- Sends 1 USDC only

**New behavior:**
- Sends 1 USDC
- Sends 0.001 tBNB for gas

**Flow:**
```
POST /api/v1/faucet { address, chain: "bnb_testnet" }

1. Validate address and rate limit
2. Transfer 1 USDC to user
3. Transfer 0.001 tBNB to user (NEW)
4. Return: { usdc: "1", bnb: "0.001", txHash, bnbTxHash }
```

**Faucet wallet requirement:**
- Must have tBNB balance
- Get from: https://testnet.bnbchain.org/faucet-smart

### Part 2: CLI Fund Command Update

**File:** `src/cli/index.ts` (fund command)

**Current:** Opens Coinbase Onramp for USDC

**New for BNB chains:** Show clear instructions

```
📋 To use MoltsPay on BNB Chain, you need:

1. USDC for payments
   → Withdraw from Binance/exchange to: 0xYourAddress
   
2. Small amount of BNB for gas (~0.001 BNB / ~$0.60)
   → First approval transaction requires gas
   → After approval, all payments are gasless
   
💡 Tip: Most exchanges include BNB dust when you withdraw to BNB Chain
```

### Part 3: CLI Status Command Update

**File:** `src/cli/index.ts` (status command)

**Add BNB balance display:**

```
BNB Chain:
  USDC: 10.00
  USDT: 0.00
  BNB:  0.0001 ⚠️ Low - need ~0.001 for approval tx
  Approval: USDC ✗ USDT ✗
```

**Warning thresholds:**
- < 0.0005 BNB: Show warning
- 0 BNB + no approval: Show error

### Part 4: Client Approval Flow Update

**File:** `src/client/index.ts` (handleBNBPayment)

**Before attempting approve, check:**
1. Does user have approval already? → Skip
2. Does user have enough BNB? → If not, helpful error

**Error message:**
```
❌ Insufficient BNB for approval transaction

You need ~0.001 BNB (~$0.60) for the first approval.
After approval, all payments are gasless.

To get BNB:
• Testnet: npx moltspay faucet --chain bnb_testnet
• Mainnet: Withdraw from Binance/exchange
```

### Part 5: Faucet Wallet Setup

**Wallet:** 0x145E00f48b98E2829f803Be53418230e47943a8A

**Required balances:**
- tBNB: Get from https://testnet.bnbchain.org/faucet-smart
- Testnet USDC: Already have (or mint more)

**Monitoring:**
- Alert when tBNB < 0.1
- Alert when testnet USDC < 100

## File Changes Summary

| File | Changes |
|------|---------|
| `moltspay-creators/src/routes/faucet.ts` | Add tBNB transfer for bnb_testnet |
| `payment-agent/src/cli/index.ts` | Fund command: BNB instructions |
| `payment-agent/src/cli/index.ts` | Status command: Show BNB balance |
| `payment-agent/src/client/index.ts` | Check BNB before approve, helpful error |
| `payment-agent/src/chains/index.ts` | Add minGasBalance config |

## Testing Plan

### Testnet
1. `npx moltspay faucet --chain bnb_testnet`
   - Expect: Receive USDC + tBNB
2. `npx moltspay status`
   - Expect: See BNB balance
3. `npx moltspay pay --chain bnb_testnet ...`
   - Expect: Approval succeeds, payment completes

### Mainnet (manual)
1. Fund wallet with USDC + BNB from exchange
2. `npx moltspay status` shows balances
3. First payment triggers approval (uses BNB)
4. Subsequent payments are gasless

## Security Considerations

### Faucet Abuse Prevention
- Rate limit: 1 request per address per 24h (existing)
- Rate limit: 5 requests per IP per 24h (existing)
- tBNB amount is minimal (0.001 = ~$0.0006)

### Mainnet
- No free BNB given (user must fund)
- Clear messaging about requirements
- No abuse vector

## Alternatives Considered

### 1. Smart Contract Wallets
- User gets a smart contract wallet
- Relayer pays all gas
- **Rejected:** Different addresses per chain, complex, overkill for ~$0.0006 gas

### 2. Meta-transaction Relayer
- User signs, relayer submits
- **Rejected:** BNB tokens don't support EIP-2612/EIP-3009, would need custom contracts

### 3. Send BNB to Users on Mainnet
- Faucet sends BNB for mainnet too
- **Rejected:** Abuse potential, unsustainable

## Timeline

| Task | Estimate |
|------|----------|
| Faucet tBNB transfer | 30 min |
| CLI fund command | 30 min |
| CLI status command | 30 min |
| Client BNB check | 30 min |
| Testing | 30 min |
| **Total** | **~2.5 hours** |
