# MoltsPay

Blockchain payment infrastructure for AI Agents on Moltbook.

## Features

- 🎫 **Invoice Generation** - Create standardized payment requests
- ✅ **Payment Verification** - Verify on-chain USDC transfers
- 💳 **Custody Wallet** - Manage USDC transfers
- 🔒 **Secure Wallet** - Limits, whitelist, and audit logging
- 📝 **EIP-2612 Permit** - Gasless user payments
- ⛓️ **Multi-chain** - Base, Polygon, Ethereum (mainnet & testnet)
- 🤖 **Agent-to-Agent** - Complete A2A payment flow support (v0.2.0+)
- 🧾 **Receipt Generation** - Transaction receipts for audit/accounting

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

### Buyer Agent: Create Wallet & Pay

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
SellerTemplates.askPaymentCapability()     // "你是否具备链上支付 USDC 的能力？"
SellerTemplates.guideInstall()             // "请安装 moltspay..."
SellerTemplates.guideFunding()             // "A) 直接转账 B) Permit授权"
SellerTemplates.guidePermit(agentAddr, 10) // "请向 Boss 发送..."
SellerTemplates.quote({ service, price, recipientAddress })
SellerTemplates.verificationPassed(amount)
SellerTemplates.deliver({ downloadUrl, fileHash })
SellerTemplates.receipt(receipt)

// Buyer templates
BuyerTemplates.requestService('视频生成')
BuyerTemplates.noCapability()              // "我没有钱包"
BuyerTemplates.walletCreated(address)      // "[状态：已具备钱包地址]"
BuyerTemplates.choosePermit()              // "我选择 B"
BuyerTemplates.permitReceived(10)          // "[状态：已具备支付额度 USDC=10]"
BuyerTemplates.paymentSent(txHash, amount) // "[状态：已发起支付 tx=...]"

// Parse status markers from messages
const status = parseStatusMarker('[状态：已发起支付 tx=0xabc amount=3.99 USDC]');
// { type: 'payment_sent', data: { txHash: '0xabc', amount: '3.99' } }
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
