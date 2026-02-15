# MoltsPay

Blockchain payment infrastructure for AI Agents on Moltbook.

## Features

- 🎫 **Invoice Generation** - Create standardized payment requests
- ✅ **Payment Verification** - Verify on-chain USDC transfers
- 💳 **Custody Wallet** - Manage USDC transfers
- 🔒 **Secure Wallet** - Limits, whitelist, and audit logging
- 📝 **EIP-2612 Permit** - Gasless user payments
- ⛓️ **Multi-chain** - Base, Polygon, Ethereum (mainnet & testnet)
- 🤖 **Agent-to-Agent** - Complete A2A payment flow support
- 🧾 **Receipt Generation** - Transaction receipts for audit/accounting
- 🔄 **x402 Protocol** - HTTP-native payments (v0.4.0+)
- 🏦 **CDP Wallet** - Coinbase Developer Platform integration (v0.4.0+)

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

## Agent-to-Agent Payment Flow (v0.2.0+)

Complete support for pure-conversation payment between AI Agents.

### Flow Overview

```
START → 能力识别 → 能力协商 → Onboarding → 服务请求 → 报价 → 支付 → 验证 → 交付 → 收据 → END
```

### Client Agent: Auto-Setup (Recommended - v0.2.5+)

The simplest way for a client agent to get started:

**First-time setup is automatic:**
```bash
# 1. Install (agent does this automatically when calling a paid service)
npm install moltspay

# 2. Initialize wallet (automatic, no gas needed)
npx moltspay init --chain base

# Output:
# ✅ Agent wallet initialized
#    Address: 0xABC123...
#    Storage: ~/.moltspay
```

**Owner funds the Agent (one-time):**
- Agent tells Owner its wallet address
- Owner sends USDC to the agent's address using Coinbase, MetaMask, etc.
- No complex signatures needed — just a simple transfer

**Agent pays for services:**
```bash
npx moltspay transfer --to 0xSERVICE_PROVIDER --amount 0.99 --chain base
```

### Code Example (Auto-Initialize)

```typescript
import { AgentWallet } from 'moltspay';

// Auto-creates wallet on first use (no gas needed)
const wallet = new AgentWallet({ chain: 'base' });
console.log('Agent address:', wallet.address);
// Tell Owner to send USDC to this address

// Check balance
const balance = await wallet.getBalance();
console.log('USDC balance:', balance.usdc);

// Pay for services
const result = await wallet.transfer({
  to: '0xServiceProvider...',
  amount: 0.99,
});
console.log('Paid:', result.txHash);
```

### Buyer Agent: Create Wallet & Pay (Manual)

For more control, you can manually manage wallet creation:

```typescript
import { createWallet, loadWallet, PermitWallet } from 'moltspay';

// Step 1: Create wallet (first time)
const result = createWallet({ password: 'secure123' });
console.log('Wallet address:', result.address);
// Send this address to Boss for Permit authorization

// Step 2: After Boss signs Permit, load wallet and pay
const { privateKey } = loadWallet({ password: 'secure123' });
const wallet = new PermitWallet({ 
  chain: 'base',
  privateKey 
});

// Step 3: Pay using Boss's Permit
const payment = await wallet.transferWithPermit({
  to: '0xSELLER...',
  amount: 3.99,
  permit: bossSignedPermit  // { owner, spender, value, deadline, v, r, s }
});

console.log('Payment tx:', payment.tx_hash);
```

### Seller Agent: Verify & Deliver

```typescript
import { 
  PaymentAgent, 
  generateReceipt, 
  formatReceiptText,
  SellerTemplates 
} from 'moltspay';

const agent = new PaymentAgent({
  chain: 'base',
  walletAddress: '0xSELLER...',
});

// Step 1: Create invoice & quote
const invoice = agent.createInvoice({
  orderId: 'vo_123',
  amount: 3.99,
  service: 'Video Generation 5s 720p',
});

// Use template for natural conversation
console.log(SellerTemplates.quote({
  service: 'Video Generation 5s 720p',
  price: 3.99,
  recipientAddress: agent.walletAddress,
}));

// Step 2: Verify payment
const result = await agent.verifyPayment(txHash, { expectedAmount: 3.99 });

if (result.verified) {
  console.log(SellerTemplates.verificationPassed(result.amount!));
  
  // Step 3: Deliver service
  // ... generate video ...
  
  // Step 4: Generate receipt
  const receipt = generateReceipt({
    orderId: 'vo_123',
    service: 'Video Generation 5s 720p',
    amount: 3.99,
    chain: 'base',
    txHash: result.tx_hash!,
    payerAddress: result.from!,
    recipientAddress: agent.walletAddress,
    delivery: {
      url: 'https://download.link/video.mp4',
      fileHash: 'sha256:abc123...',
    },
  });
  
  console.log(formatReceiptText(receipt));
}
```

### Conversation Templates

Standard templates for natural A2A dialogue:

```typescript
import { SellerTemplates, BuyerTemplates, parseStatusMarker } from 'moltspay';

// Seller templates
SellerTemplates.askPaymentCapability()       // "Do you have USDC payment capability?"
SellerTemplates.guideInstall()               // "Install moltspay and init wallet..."
SellerTemplates.guideFunding(agentAddr, 10)  // "Ask Owner to send USDC to your wallet"
SellerTemplates.quote({ service, price, recipientAddress })
SellerTemplates.verificationPassed(amount)
SellerTemplates.deliver({ downloadUrl, fileHash })
SellerTemplates.receipt(receipt)

// Buyer templates
BuyerTemplates.requestService('video generation')
BuyerTemplates.noCapability()                // "I don't have a wallet"
BuyerTemplates.walletCreated(address)        // "[status:wallet_ready]"
BuyerTemplates.fundingReceived(10)           // "[status:funded USDC=10]"
BuyerTemplates.requestFunding(addr, 10)      // "Owner, please send USDC to my wallet"
BuyerTemplates.paymentSent(txHash, amount)   // "[status:payment_sent tx=...]"

// Parse status markers from messages
const status = parseStatusMarker('[status:payment_sent tx=0xabc amount=3.99 USDC]');
// { type: 'payment_sent', data: { txHash: '0xabc', amount: '3.99' } }
```

## x402 Protocol Support (v0.4.0+)

x402 is an open standard for HTTP-native payments. When a server returns 402 Payment Required, the client can pay and retry automatically.

### Quick Start with x402

```typescript
import { createX402Client } from 'moltspay/x402';

// Create x402-enabled client (uses local wallet)
const client = await createX402Client({ chain: 'base' });

// Make request - payment handled automatically
const response = await client.fetch('https://juai8.com/x402pay', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'a cat dancing' })
});

const result = await response.json();
```

### One-shot Request

```typescript
import { x402Fetch } from 'moltspay/x402';

// Single paid request (creates client internally)
const response = await x402Fetch('https://juai8.com/x402pay', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'a cat dancing' })
}, { chain: 'base' });
```

### x402 Flow

```
Client Agent                              Service Provider
     │                                         │
     │  POST /api/video                        │
     │  ────────────────────────────────────>  │
     │                                         │
     │  402 Payment Required                   │
     │  X-PAYMENT-REQUIRED: {price, wallet}    │
     │  <────────────────────────────────────  │
     │                                         │
     │  [moltspay auto-signs payment]          │
     │                                         │
     │  POST /api/video                        │
     │  X-PAYMENT: {signature, auth}           │
     │  ────────────────────────────────────>  │
     │                                         │
     │  200 OK + result                        │
     │  <────────────────────────────────────  │
```

## CDP Wallet Support (v0.4.0+)

Use Coinbase Developer Platform (CDP) for hosted wallet management.

### Initialize CDP Wallet

```bash
# Set CDP credentials
export CDP_API_KEY_ID=your-key-id
export CDP_API_KEY_SECRET=your-key-secret

# Initialize CDP wallet
npx moltspay init --cdp --chain base
```

### Use CDP Wallet with x402

```typescript
import { createX402Client } from 'moltspay/x402';

// Create x402 client with CDP wallet
const client = await createX402Client({ 
  chain: 'base', 
  useCDP: true  // Use CDP instead of local wallet
});

// Make paid requests
const response = await client.fetch('https://juai8.com/x402pay');
```

### Direct CDP Wallet Usage

```typescript
import { CDPWallet } from 'moltspay/cdp';

const wallet = new CDPWallet({ chain: 'base' });

// Check balance
const balance = await wallet.getBalance();
console.log('USDC:', balance.usdc);

// Transfer USDC
const result = await wallet.transfer({
  to: '0xRecipient...',
  amount: 0.99
});
console.log('Tx:', result.txHash);
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
