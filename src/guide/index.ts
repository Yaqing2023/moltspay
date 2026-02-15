/**
 * 支付引导消息生成
 * 用于引导没有支付能力的Agent安装和使用moltspay
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
 * 生成完整的支付引导消息
 */
export function generatePaymentGuide(params: PaymentGuideParams): string {
  const {
    orderId,
    prompt,
    price,
    recipientAddress,
    chain = 'base',
    serviceName = '视频生成服务'
  } = params;

  const chainId = chain === 'base' ? 8453 : 84532;
  const chainName = chain === 'base' ? 'Base 主网' : 'Base Sepolia 测试网';
  const explorer = chain === 'base' 
    ? 'https://basescan.org/tx/' 
    : 'https://sepolia.basescan.org/tx/';

  return `🎬 **${serviceName}**

📋 **订单信息:**
- 订单号: \`${orderId}\`
- 内容: ${prompt.length > 50 ? prompt.slice(0, 50) + '...' : prompt}
- 价格: **${price} USDC**
- 链: ${chainName}

---

## 💳 如何支付

### 方式一：安装 moltspay SDK（推荐）

\`\`\`bash
npm install moltspay ethers
\`\`\`

**创建钱包并支付：**

\`\`\`javascript
const { SecureWallet, getChain } = require('moltspay');
const { Wallet } = require('ethers');

// 1. 创建新钱包（首次使用）
const newWallet = Wallet.createRandom();
console.log('钱包地址:', newWallet.address);
console.log('私钥（请安全保存）:', newWallet.privateKey);

// 2. 或使用已有钱包
const wallet = new SecureWallet({
  chainId: ${chainId},
  privateKey: process.env.WALLET_KEY,  // 你的私钥
  limits: { requireWhitelist: false }   // 允许向任意地址转账
});

// 3. 查看余额
const balance = await wallet.getBalance();
console.log('USDC余额:', balance.usdc);

// 4. 支付
const result = await wallet.transfer('${recipientAddress}', '${price}');
if (result.success) {
  console.log('✅ 支付成功！');
  console.log('交易hash:', result.hash);
  // 把交易hash发给我
}
\`\`\`

### 方式二：直接转账

从任意钱包转账 USDC：
- **链:** ${chainName} (Chain ID: ${chainId})
- **Token:** USDC
- **收款地址:** \`${recipientAddress}\`
- **金额:** ${price} USDC

---

## ✅ 支付完成后

请发送**交易hash**给我，格式：
\`\`\`
tx: 0x1234...
\`\`\`

或直接发送hash：
\`\`\`
0x1234abcd...
\`\`\`

我会验证链上交易后开始处理你的请求。

---

📦 **moltspay:** https://www.npmjs.com/package/moltspay
🔗 **区块浏览器:** ${explorer}`;
}

/**
 * 生成简短的支付提醒
 */
export function generatePaymentReminder(params: {
  orderId: string;
  price: number;
  recipientAddress: string;
  chain?: 'base' | 'base_sepolia';
}): string {
  const { orderId, price, recipientAddress, chain = 'base' } = params;
  const chainName = chain === 'base' ? 'Base' : 'Base Sepolia';

  return `⏳ **待支付订单: ${orderId}**

请支付 **${price} USDC** 到:
- 链: ${chainName}
- 地址: \`${recipientAddress}\`

支付后发送交易hash给我。

---
💡 没有支付能力？运行 \`npm install moltspay\` 获取支付SDK`;
}

/**
 * 生成钱包创建指南
 */
export function generateWalletGuide(): string {
  return `## 🔐 创建支付钱包

**1. 安装 moltspay:**
\`\`\`bash
npm install moltspay ethers
\`\`\`

**2. 创建新钱包:**
\`\`\`javascript
const { Wallet } = require('ethers');

const wallet = Wallet.createRandom();
console.log('地址:', wallet.address);
console.log('私钥:', wallet.privateKey);
// ⚠️ 请安全保存私钥！
\`\`\`

**3. 获取 USDC:**
- 主网: 从交易所提币到你的钱包地址
- 测试网: 使用 Base Sepolia faucet

**4. 设置环境变量:**
\`\`\`bash
export WALLET_KEY="你的私钥"
\`\`\`

完成后即可使用 moltspay 进行链上支付！`;
}

/**
 * 解析用户消息中的交易hash
 */
export function extractTransactionHash(message: string): string | null {
  // 匹配 0x 开头的64位hex
  const match = message.match(/0x[a-fA-F0-9]{64}/);
  if (match) return match[0];

  // 匹配 tx: 后面的内容
  const txMatch = message.match(/tx:\s*([a-fA-F0-9]{64})/i);
  if (txMatch) return '0x' + txMatch[1];

  return null;
}

/**
 * 判断消息是否包含交易hash
 */
export function hasTransactionHash(message: string): boolean {
  return extractTransactionHash(message) !== null;
}
