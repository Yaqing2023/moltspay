# Payment Agent 架构设计文档

## 第一部分：系统定位

**Payment Agent** 是 AI Agent 之间的区块链支付基础设施，作为独立的 npm 包发布，供 Bot（如 Clawdbot）调用。

### 架构分层

```
┌─────────────────────────────────────────────────────────┐
│                    Bot (Clawdbot)                       │
│  • 业务逻辑（视频生成、订单管理等）                      │
│  • 用户交互（WhatsApp/飞书/Moltbook）                   │
│  • 服务交付                                             │
└─────────────────────────────────────────────────────────┘
                          ↓ 调用
┌─────────────────────────────────────────────────────────┐
│              Payment Agent (npm 包)                      │
│  • Invoice 生成/解析                                     │
│  • 链上支付验证                                          │
│  • 托管钱包转账                                          │
│  • 安全控制（限额/白名单/审计）                          │
│  • EIP-2612 Permit                                      │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│                    Blockchain                           │
│              (Base / Polygon / Ethereum)                │
└─────────────────────────────────────────────────────────┘
```

### 职责边界

| ✅ Payment Agent 负责 | ❌ Bot 负责 |
|----------------------|-------------|
| Invoice 生成 | 订单创建/管理 |
| 支付验证 | 视频生成等业务 |
| 钱包余额查询 | 文件存储/推送 |
| USDC 转账 | 用户交互 |
| 限额/白名单控制 | 业务流程编排 |
| 审计日志 | 通知推送 |
| EIP-2612 Permit | 平台集成 |

---

## 第二部分：模块设计

### 1. PaymentAgent（核心支付代理）

**文件**: `src/agent/PaymentAgent.ts`

**职责**:
- 生成 Invoice（支付请求）
- 验证链上支付
- 生成钱包深度链接

**主要方法**:

| 方法 | 说明 |
|------|------|
| createInvoice(params) | 生成符合协议的支付请求 |
| verifyPayment(txHash, options) | 验证交易哈希 |
| scanRecentTransfers(amount, timeout) | 扫描最近转账（按金额匹配） |
| getBalance(address?) | 获取钱包余额 |
| formatInvoiceMessage(invoice) | 格式化为人类可读消息 |

### 2. Wallet（基础钱包）

**文件**: `src/wallet/Wallet.ts`

**职责**:
- 查询余额
- 发送 USDC 转账

**主要方法**:

| 方法 | 说明 |
|------|------|
| getBalance() | 获取 ETH + USDC 余额 |
| transfer(to, amount) | 发送 USDC |

### 3. SecureWallet（安全钱包）

**文件**: `src/wallet/SecureWallet.ts`

**职责**:
- 在基础 Wallet 之上增加安全控制
- 单笔/日限额
- 白名单机制
- 审计日志
- 超限审批队列

**主要方法**:

| 方法 | 说明 |
|------|------|
| transfer(params) | 带安全检查的转账 |
| approve(requestId, approver) | 审批超限转账 |
| reject(requestId, rejecter) | 拒绝超限转账 |
| addToWhitelist(address, addedBy) | 添加白名单 |
| getPendingTransfers() | 获取待审批列表 |

**安全控制流程**:

```
转账请求
    ↓
白名单检查 ──否──> 拒绝
    ↓是
单笔限额检查 ──超限──> 审批队列
    ↓限额内
日限额检查 ──超限──> 审批队列
    ↓限额内
余额检查 ──不足──> 拒绝
    ↓充足
执行转账 + 写入审计日志
```

### 4. PermitPayment（EIP-2612 无 Gas 预授权）

**文件**: `src/permit/Permit.ts`

**职责**:
- 让用户通过签名授权，服务方代付 Gas

**主要方法**:

| 方法 | 说明 |
|------|------|
| createPermitRequest(owner, amount, orderId) | 生成 EIP-712 签名请求 |
| executePermitAndTransfer(owner, amount, sig) | 执行 permit + transferFrom |
| executePermit(owner, amount, sig) | 仅执行 permit |

**流程**:

```
1. 服务方调用 createPermitRequest() 生成签名请求
2. 用户钱包调用 eth_signTypedData_v4 签名（离线，0 gas）
3. 用户返回签名 {v, r, s, deadline}
4. 服务方调用 executePermitAndTransfer()
5. 链上完成授权 + 转账
```

### 5. AuditLog（审计日志）

**文件**: `src/audit/AuditLog.ts`

**职责**:
- 不可篡改的操作日志
- 链式哈希防篡改
- 按日期分文件存储

**主要方法**:

| 方法 | 说明 |
|------|------|
| log(params) | 记录日志 |
| read(date?) | 读取指定日期日志 |
| verify(date?) | 验证日志完整性 |
| search(filter) | 搜索日志 |

**日志格式**:

```json
{
  "timestamp": 1707811234.567,
  "datetime": "2026-02-13T10:00:34.567Z",
  "action": "transfer_executed",
  "request_id": "tr_abc123",
  "from": "0x...",
  "to": "0x...",
  "amount": 10.0,
  "tx_hash": "0x...",
  "prev_hash": "a1b2c3d4",
  "hash": "e5f6g7h8"
}
```

---

## 第三部分：协议规范

### Invoice（支付请求）

```typescript
interface Invoice {
  type: 'payment_request';
  version: '1.0';
  order_id: string;
  service: string;
  amount: string;        // 字符串避免精度问题
  token: 'USDC';
  chain: string;
  chain_id: number;
  recipient: string;
  expires_at: string;    // ISO8601
  deep_link?: string;    // MetaMask 深度链接
}
```

### 验证结果

```typescript
interface VerifyResult {
  verified: boolean;
  tx_hash?: string;
  amount?: string;
  from?: string;
  to?: string;
  block_number?: number;
  confirmations?: number;
  explorer_url?: string;
  error?: string;
}
```

---

## 第四部分：支持的链

| 链 | Chain ID | 类型 | USDC 合约 |
|---|----------|------|-----------|
| base | 8453 | 主网 | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |
| polygon | 137 | 主网 | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 |
| ethereum | 1 | 主网 | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 |
| base_sepolia | 84532 | 测试网 | 0x036CbD53842c5426634e7929541eC2318f3dCF7e |
| sepolia | 11155111 | 测试网 | 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 |

---

## 第五部分：目录结构

```
payment-agent/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── README.md
├── src/
│   ├── index.ts              # 主入口
│   ├── agent/
│   │   └── PaymentAgent.ts   # 核心支付代理
│   ├── wallet/
│   │   ├── index.ts
│   │   ├── Wallet.ts         # 基础钱包
│   │   └── SecureWallet.ts   # 安全钱包
│   ├── permit/
│   │   ├── index.ts
│   │   └── Permit.ts         # EIP-2612
│   ├── chains/
│   │   └── index.ts          # 链配置
│   ├── audit/
│   │   └── AuditLog.ts       # 审计日志
│   └── types/
│       └── index.ts          # 类型定义
├── bin/
│   └── cli.ts                # CLI
├── docs/
│   └── ARCHITECTURE.md       # 本文档
└── test/
```

---

## 第六部分：使用示例

### Bot 集成示例

```typescript
import { PaymentAgent, SecureWallet } from '@anthropic/payment-agent';

const payment = new PaymentAgent({ chain: 'base' });
const wallet = new SecureWallet({ 
  chain: 'base',
  limits: { singleMax: 100, dailyMax: 1000 }
});

// Bot 业务流程
async function handleServiceRequest(userId: string, service: string) {
  // 1. Bot 创建订单（Bot 自己管理）
  const orderId = createOrder(userId, service);
  
  // 2. 调用 Payment Agent 生成 Invoice
  const invoice = payment.createInvoice({
    orderId,
    amount: 2.0,
    service,
  });
  
  // 3. Bot 发送 Invoice 给用户
  await sendToUser(userId, payment.formatInvoiceMessage(invoice));
  
  // 4. 用户支付后，Bot 调用 Payment Agent 验证
  const verified = await payment.verifyPayment(txHash);
  
  if (verified.success) {
    // 5. Bot 执行业务（如生成视频）
    await executeService(orderId);
    
    // 6. Bot 交付服务
    await deliverService(userId);
  }
}
```

---

## 第七部分：安全特性

### 三层防护

```
┌─────────────────────────────────────────┐
│  第一层：钱包选择                        │
│  (Wallet / SecureWallet / Permit)       │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│  第二层：风控措施                        │
│  (限额 / 白名单 / 审批队列)              │
└─────────────────────────────────────────┘
                  ↓
┌─────────────────────────────────────────┐
│  第三层：审计追溯                        │
│  (链式哈希日志 / 不可篡改)               │
└─────────────────────────────────────────┘
```

### 默认限额

| 限制 | 默认值 |
|------|--------|
| 单笔最大 | $100 |
| 日最大 | $1000 |
| 白名单 | 强制开启 |

---

*文档版本: v0.1.0*
*更新时间: 2026-02-14*
