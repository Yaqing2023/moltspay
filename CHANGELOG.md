# Changelog

## [0.2.0] - 2026-02-15

### Added - Agent-to-Agent Payment Flow

完整实现了 Agent 间纯对话支付流程所需的全部功能。

#### P0: 核心功能

**createWallet()** - 买方 Agent 创建钱包
```typescript
import { createWallet, loadWallet } from 'moltspay';

// 创建新钱包（自动存储到 ~/.moltspay/wallet.json）
const result = createWallet();
console.log('钱包地址:', result.address);

// 加密存储
const result = createWallet({ password: 'secure123' });

// 加载已有钱包
const wallet = loadWallet({ password: 'secure123' });
```

**PermitWallet** - 使用 Boss 授权的 Permit 支付
```typescript
import { PermitWallet } from 'moltspay';

const wallet = new PermitWallet({ chain: 'base' });

// 使用 Boss 签署的 Permit 支付
const result = await wallet.transferWithPermit({
  to: '0xSELLER...',
  amount: 3.99,
  permit: {
    owner: '0xBOSS...',
    spender: wallet.address,
    value: '10000000',
    deadline: 1234567890,
    v: 27,
    r: '0x...',
    s: '0x...'
  }
});
```

#### P1: 收据生成

**generateReceipt()** - 生成交易收据
```typescript
import { generateReceipt, formatReceiptText } from 'moltspay';

const receipt = generateReceipt({
  orderId: 'vo_abc123',
  service: '视频生成 5秒 720p',
  amount: 3.99,
  chain: 'base',
  txHash: '0x...',
  payerAddress: '0xBUYER...',
  recipientAddress: '0xSELLER...',
  delivery: {
    url: 'https://...',
    fileHash: 'sha256:...'
  }
});

// 格式化为纯文本（适合飞书/WhatsApp）
console.log(formatReceiptText(receipt));
```

#### P2: 对话模板

**SellerTemplates / BuyerTemplates** - 标准化对话模板
```typescript
import { SellerTemplates, BuyerTemplates, parseStatusMarker } from 'moltspay';

// 卖方模板
SellerTemplates.askPaymentCapability();
SellerTemplates.guideInstall();
SellerTemplates.quote({ service: '视频生成', price: 3.99, recipientAddress: '0x...' });

// 买方模板
BuyerTemplates.requestService('视频生成');
BuyerTemplates.walletCreated('0x...');
BuyerTemplates.paymentSent('0xtx...', 3.99);

// 解析状态标记
const status = parseStatusMarker('[状态：已发起支付 tx=0xabc amount=3.99 USDC]');
// { type: 'payment_sent', data: { txHash: '0xabc', amount: '3.99' } }
```

### New Exports

```typescript
// 钱包创建
export { createWallet, loadWallet, getWalletAddress, walletExists } from 'moltspay';

// Permit 钱包
export { PermitWallet, formatPermitRequest } from 'moltspay';

// 收据
export { generateReceipt, generateReceiptFromInvoice, formatReceiptMessage, formatReceiptText, formatReceiptJson } from 'moltspay';

// 对话模板
export { SellerTemplates, BuyerTemplates, StatusMarkers, parseStatusMarker } from 'moltspay';
```

---

## [0.1.3] - 2026-02-10

### Added
- OrderManager 订单管理
- 支付引导消息生成

## [0.1.2] - 2026-02-08

### Added
- SecureWallet 安全钱包（限额/白名单/审计）
- AuditLog 审计日志

## [0.1.1] - 2026-02-06

### Added
- PaymentAgent 核心类
- Invoice 生成
- 链上支付验证
- 多链支持 (Base, Polygon, Ethereum)

## [0.1.0] - 2026-02-05

### Added
- 初始版本
- 基础 Wallet 类
- EIP-2612 Permit 支持
