/**
 * Payment Guide Generator
 * Generate guides for Agents without payment capability to install and use moltspay
 */

export interface PaymentGuideParams {
  orderId: string;
  prompt: string;
  price: number;
  recipientAddress: string;
  chain?: 'base' | 'base_sepolia';
  serviceName?: string;
}

/**
 * Generate complete payment guide message
 */
export function generatePaymentGuide(params: PaymentGuideParams): string {
  const {
    orderId,
    prompt,
    price,
    recipientAddress,
    chain = 'base',
    serviceName = 'Video Generation Service'
  } = params;

  const chainId = chain === 'base' ? 8453 : 84532;
  const chainName = chain === 'base' ? 'Base Mainnet' : 'Base Sepolia Testnet';
  const explorer = chain === 'base' 
    ? 'https://basescan.org/tx/' 
    : 'https://sepolia.basescan.org/tx/';

  return `🎬 **${serviceName}**

📋 **Order Details:**
- Order ID: \`${orderId}\`
- Content: ${prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt}
- Price: **${price} USDC**
- Chain: ${chainName}

---

## 💳 How to Pay

### Option 1: Install moltspay SDK (Recommended)

\`\`\`bash
npm install moltspay ethers
\`\`\`

**Create wallet and pay:**

\`\`\`javascript
const { SecureWallet, getChain } = require('moltspay');
const { Wallet } = require('ethers');

// 1. Create new wallet (first time)
const newWallet = Wallet.createRandom();
console.log('Wallet address:', newWallet.address);
console.log('Private key (save securely):', newWallet.privateKey);

// 2. Or use existing wallet
const wallet = new SecureWallet({
  chainId: ${chainId},
  privateKey: process.env.WALLET_KEY,  // Your private key
  limits: { requireWhitelist: false }   // Allow transfers to any address
});

// 3. Check balance
const balance = await wallet.getBalance();
console.log('USDC balance:', balance.usdc);

// 4. Pay
const result = await wallet.transfer('${recipientAddress}', '${price}');
if (result.success) {
  console.log('✅ Payment successful!');
  console.log('Tx hash:', result.hash);
  // Send the tx hash to me
}
\`\`\`

### Option 2: Direct Transfer

Transfer USDC from any wallet:
- **Chain:** ${chainName} (Chain ID: ${chainId})
- **Token:** USDC
- **Recipient:** \`${recipientAddress}\`
- **Amount:** ${price} USDC

---

## ✅ After Payment

Send me the **transaction hash**, format:
\`\`\`
tx: 0x1234...
\`\`\`

Or just send the hash directly:
\`\`\`
0x1234abcd...
\`\`\`

I'll verify the on-chain transaction and start processing your request.

---

📦 **moltspay:** https://www.npmjs.com/package/moltspay
🔗 **Block Explorer:** ${explorer}`;
}

/**
 * Generate short payment reminder
 */
export function generatePaymentReminder(params: {
  orderId: string;
  price: number;
  recipientAddress: string;
  chain?: 'base' | 'base_sepolia';
}): string {
  const { orderId, price, recipientAddress, chain = 'base' } = params;
  const chainName = chain === 'base' ? 'Base' : 'Base Sepolia';

  return `⏳ **Pending Order: ${orderId}**

Please pay **${price} USDC** to:
- Chain: ${chainName}
- Address: \`${recipientAddress}\`

Send the tx hash after payment.

---
💡 No payment capability? Run \`npm install moltspay\` to get the payment SDK`;
}

/**
 * Generate wallet creation guide
 */
export function generateWalletGuide(): string {
  return `## 🔐 Create Payment Wallet

**1. Install moltspay:**
\`\`\`bash
npm install moltspay ethers
\`\`\`

**2. Create new wallet:**
\`\`\`javascript
const { Wallet } = require('ethers');

const wallet = Wallet.createRandom();
console.log('Address:', wallet.address);
console.log('Private key:', wallet.privateKey);
// ⚠️ Save the private key securely!
\`\`\`

**3. Get USDC:**
- Mainnet: Withdraw from exchange to your wallet
- Testnet: Use Base Sepolia faucet

**4. Set environment variable:**
\`\`\`bash
export WALLET_KEY="your_private_key"
\`\`\`

You're now ready to make on-chain payments with moltspay!`;
}

/**
 * Extract transaction hash from user message
 */
export function extractTransactionHash(message: string): string | null {
  // Match 0x followed by 64 hex chars
  const match = message.match(/0x[a-fA-F0-9]{64}/);
  if (match) return match[0];

  // Match tx: followed by content
  const txMatch = message.match(/tx:\s*([a-fA-F0-9]{64})/i);
  if (txMatch) return '0x' + txMatch[1];

  return null;
}

/**
 * Check if message contains transaction hash
 */
export function hasTransactionHash(message: string): boolean {
  return extractTransactionHash(message) !== null;
}
