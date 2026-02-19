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

**Key benefit: Client agents need NO gas!** x402 uses EIP-3009 signatures - the client only signs, and Coinbase's facilitator executes on-chain (paying gas).

### Client Agent Setup (Simple, No Gas Needed)

```bash
# 1. Initialize wallet (generates local keypair)
npx moltspay init --chain base

# Output:
# ✅ Local wallet initialized
#    Address: 0xABC123...
#    Storage: ~/.moltspay
```

```bash
# 2. Tell your owner to send USDC to your address
#    Owner sends USDC via Coinbase/MetaMask - just a normal transfer
#    NO ETH/gas needed in your wallet!
```

```typescript
// 3. Make paid requests - payment handled automatically
import { createX402Client } from 'moltspay';

const client = await createX402Client({ chain: 'base' });

const response = await client.fetch('https://juai8.com/zen7/v1/video/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ prompt: 'a cat dancing' })
});

const result = await response.json();
```

### One-shot Request

```typescript
import { x402Fetch } from 'moltspay';

// Single paid request
const response = await x402Fetch('https://juai8.com/zen7/v1/video/generate', {
  method: 'POST',
  body: JSON.stringify({ prompt: 'a cat dancing' })
}, { chain: 'base' });
```

### How x402 Works (No Gas for Client)

```
Client Agent                    Server                     Facilitator (Coinbase)
     │                            │                              │
     │ POST /x402pay              │                              │
     │ ────────────────────────>  │                              │
     │                            │                              │
     │ 402 + payment requirements │                              │
     │ <────────────────────────  │                              │
     │                            │                              │
     │ [Sign EIP-3009]            │                              │
     │ (OFF-CHAIN, NO GAS!)       │                              │
     │                            │                              │
     │ POST + signature           │                              │
     │ ────────────────────────>  │ Forward signature            │
     │                            │ ─────────────────────────>   │
     │                            │                              │
     │                            │   Execute transfer on-chain  │
     │                            │   (FACILITATOR PAYS GAS)     │
     │                            │ <─────────────────────────   │
     │                            │                              │
     │ 200 OK + result            │                              │
     │ <────────────────────────  │                              │
```

**Client agent requirements:**
- ✅ Local wallet (just for signing)
- ✅ USDC balance (owner sends once)
- ❌ NO ETH/gas needed
- ❌ NO API credentials needed

## Server Setup (Selling Services)

To run a MoltsPay server that accepts x402 payments:

### 1. Configure CDP Credentials (Required for Mainnet)

```bash
# Copy the example config
cp .env.example ~/.moltspay/.env

# Edit with your CDP credentials (get from https://portal.cdp.coinbase.com/)
nano ~/.moltspay/.env
```

```env
# ~/.moltspay/.env
USE_MAINNET=true
CDP_API_KEY_ID=your-key-id
CDP_API_KEY_SECRET=your-secret
```

**Important:** Server does NOT need a private key! The x402 facilitator handles all on-chain settlement.

### 2. Create Services Manifest

```json
{
  "provider": {
    "name": "My AI Service",
    "wallet": "0xYOUR_WALLET_ADDRESS",
    "chain": "base"
  },
  "services": [
    {
      "id": "my-service",
      "name": "My Service",
      "price": 0.99,
      "currency": "USDC",
      "command": "./handlers/my-service.sh",
      "input": { "prompt": { "type": "string", "required": true } },
      "output": { "result": { "type": "string" } }
    }
  ]
}
```

### 3. Start Server

```bash
npx moltspay start ./moltspay.services.json --port 3000
```

The server will:
- Return 402 with payment requirements for unpaid requests
- Verify signatures with CDP facilitator
- Execute service only after payment verification
- Settle payment on-chain (facilitator pays gas)

## CDP Wallet Support (Optional, Advanced)

CDP wallet is an **optional alternative** for **client agents** who want Coinbase to host their wallet. Most users should use the simple local wallet above.

```bash
# Only if you have CDP credentials and want hosted wallet
export CDP_API_KEY_ID=your-key-id
export CDP_API_KEY_SECRET=your-key-secret
npx moltspay init --cdp --chain base
```

```typescript
// Use CDP wallet
const client = await createX402Client({ chain: 'base', useCDP: true });
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

# === Client Commands ===

# Initialize wallet (first time setup)
npx moltspay init --chain base

# Check wallet status and balance
npx moltspay status

# Update spending limits
npx moltspay config                              # Interactive
npx moltspay config --max-per-tx 50 --max-per-day 500  # Direct

# Pay for a service
npx moltspay pay http://server:3000 service-id --prompt "your prompt"

# List services from a provider
npx moltspay services http://server:3000

# === Server Commands ===

# Start server from services manifest
npx moltspay start ./moltspay.services.json --port 3000

# Stop running server
npx moltspay stop

# === Legacy Commands ===

# Generate invoice
moltspay invoice --order order_123 --amount 2.0 --service video

# Verify payment
moltspay verify --tx 0x... --amount 2.0

# Transfer USDC
moltspay transfer --to 0x... --amount 10 --secure

# List supported chains
moltspay chains
```

### x402 CLI Examples (Cross-Platform)

The x402 command sends JSON payloads. Quote handling differs by shell:

**Linux / Mac (bash/zsh):**
```bash
npx moltspay x402 https://example.com/api \
  -X POST \
  -d '{"prompt": "your text here"}' \
  -v
```

**Windows PowerShell:**
```powershell
# Option 1: Use a JSON file (recommended)
echo '{"prompt": "your text here"}' > request.json
npx moltspay x402 https://example.com/api -X POST -d "@request.json" -v

# Option 2: Escape with backtick
npx moltspay x402 https://example.com/api -X POST -d "{`"prompt`": `"your text`"}" -v

# Option 3: Use cmd /c wrapper
cmd /c "npx moltspay x402 https://example.com/api -X POST -d ""{\""prompt\"": \""your text\""}"" -v"
```

**Windows CMD:**
```cmd
npx moltspay x402 https://example.com/api -X POST -d "{\"prompt\": \"your text\"}" -v
```

**Cross-platform tip:** For complex JSON, save to a file and use `-d @filename.json` - works on all systems!

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
