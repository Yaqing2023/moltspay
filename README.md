# MoltsPay

Blockchain payment infrastructure for AI Agents on Moltbook.

## Features

- 🎫 **Invoice Generation** - Create standardized payment requests
- ✅ **Payment Verification** - Verify on-chain USDC transfers
- 💳 **Custody Wallet** - Manage USDC transfers
- 🔒 **Secure Wallet** - Limits, whitelist, and audit logging
- 📝 **EIP-2612 Permit** - Gasless user payments
- ⛓️ **Multi-chain** - Base, Polygon, Ethereum (mainnet & testnet)

## Installation

```bash
npm install moltspay@latest
```

## Quick Start

```typescript
import { PaymentAgent, SecureWallet } from 'moltspay';

// Initialize payment agent
const agent = new PaymentAgent({
  chain: 'base',
  walletAddress: '0x...',
});

// Generate invoice
const invoice = agent.createInvoice({
  orderId: 'order_123',
  amount: 2.0,
  service: 'video_generation',
});

// Verify payment
const result = await agent.verifyPayment(txHash);
if (result.verified) {
  console.log('Payment confirmed!');
}
```

## Usage with AI Agents

Payment Agent is designed to be called by AI Agents (like Clawdbot) to handle payment logic:

```
┌─────────────────────────────────────────────────────────┐
│                    Bot (Clawdbot)                       │
│  • Business logic                                       │
│  • User interaction                                     │
│  • Service delivery                                     │
└─────────────────────────────────────────────────────────┘
                          ↓ calls
┌─────────────────────────────────────────────────────────┐
│              Payment Agent (this package)               │
│  • Invoice generation                                   │
│  • Payment verification                                 │
│  • Wallet management                                    │
│  • Security controls                                    │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                    Blockchain                           │
│              (Base / Polygon / Ethereum)                │
└─────────────────────────────────────────────────────────┘
```

## API Reference

### PaymentAgent

```typescript
const agent = new PaymentAgent({
  chain: 'base',           // Chain name
  walletAddress: '0x...',  // Recipient address
  rpcUrl: '...',           // Optional custom RPC
});

// Create invoice
const invoice = agent.createInvoice({
  orderId: 'order_123',
  amount: 2.0,
  service: 'video_generation',
  expiresMinutes: 30,
});

// Verify payment
const result = await agent.verifyPayment(txHash, {
  expectedAmount: 2.0,
  tolerance: 0.01,  // 1% tolerance
});

// Get balance
const balance = await agent.getBalance();
```

### Wallet

```typescript
const wallet = new Wallet({
  chain: 'base',
  privateKey: '0x...',
});

// Get balance
const balance = await wallet.getBalance();

// Transfer USDC
const result = await wallet.transfer('0x...', 10.0);
```

### SecureWallet

```typescript
const wallet = new SecureWallet({
  chain: 'base',
  limits: {
    singleMax: 100,   // Max $100 per transfer
    dailyMax: 1000,   // Max $1000 per day
  },
  whitelist: ['0x...'],
});

// Transfer with security checks
const result = await wallet.transfer({
  to: '0x...',
  amount: 50,
  reason: 'Service payment',
});

// Approve pending transfer (when limit exceeded)
await wallet.approve(requestId, 'admin');

// Add to whitelist
await wallet.addToWhitelist('0x...', 'admin');
```

### PermitPayment (EIP-2612)

```typescript
const permit = new PermitPayment({
  chain: 'base',
  privateKey: '0x...',  // Service provider's key
});

// Create permit request for user to sign
const request = await permit.createPermitRequest(
  userAddress,
  amount,
  orderId
);

// After user signs, execute permit + transfer
const result = await permit.executePermitAndTransfer(
  userAddress,
  amount,
  { v, r, s, deadline }
);
```

## CLI

```bash
# Install globally
npm install -g moltspay

# Get balance
moltspay balance --chain base

# Generate invoice
moltspay invoice --order order_123 --amount 2.0 --service video

# Verify payment
moltspay verify --tx 0x... --amount 2.0

# Transfer USDC
moltspay transfer --to 0x... --amount 10 --secure

# List supported chains
moltspay chains
```

## Environment Variables

```bash
PAYMENT_AGENT_WALLET=0x...      # Wallet address
PAYMENT_AGENT_PRIVATE_KEY=0x... # Private key (for transfers)
```

## Supported Chains

| Chain | Chain ID | Type | Status |
|-------|----------|------|--------|
| base | 8453 | Mainnet | ✅ |
| polygon | 137 | Mainnet | ✅ |
| ethereum | 1 | Mainnet | ✅ |
| base_sepolia | 84532 | Testnet | ✅ |
| sepolia | 11155111 | Testnet | ✅ |

## Security

- **Limits**: Single and daily transfer limits
- **Whitelist**: Only transfer to approved addresses
- **Audit Log**: Immutable, hash-chained logs
- **Pending Approval**: Large transfers require manual approval

## License

MIT
