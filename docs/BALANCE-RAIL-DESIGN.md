# 免密支付（托管余额 rail）方案

> **状态（2026-07-04）**：已决策**统一到 MoltsPay SDK 整体**，作为 crypto（逐笔签名）、法币扫码（Alipay/WeChat 逐笔付）之外的第三类支付模式。本文档由 `~/clawd/docs/webchatpay-design.md` 迁移而来，原文按"独立 WebchatPay 服务（端口 4402）"编写——**独立服务路线已作废**，下文的数据模型、API 语义、安全设计仍然有效，但宿主改为 MoltsPayServer / MoltsPayClient；文末《与 MoltsPay 的关系》一节描述的"短期独立做"不再成立。具体的 SDK 集成设计（x402 scheme、facilitator 接口、充值复用现有 rail）待补充。

## 目标

让用户充值一次后，后续消费自动扣款，无需每次签名或输密码。体验类似支付宝免密支付。

---

## 核心架构

```
用户 → webchat → Zen7 Agent
                      ↓
                 WebchatPay API (余额检查/扣款)
                      ↓
                 余额服务 (SQLite)
                      ↓
                 充值入口 (USDC / 支付宝)
```

用户资金始终在服务端托管。Agent 调用内部 API 扣余额，不涉及链上交易，不要求用户签名。

---

## 数据模型

### users 表
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,              -- UUID
  webchat_session_id TEXT UNIQUE,   -- OpenClaw session ID
  display_name TEXT,
  deposit_address TEXT,             -- USDC 充值地址 (Base)
  alipay_user_id TEXT,              -- 支付宝绑定 (可选)
  balance_sat INTEGER DEFAULT 0,    -- 余额 (以分为单位, 1 USDC = 100)
  total_topup_sat INTEGER DEFAULT 0,
  total_spent_sat INTEGER DEFAULT 0,
  daily_limit_sat INTEGER DEFAULT 1000,   -- 日限额 10 USDC
  single_limit_sat INTEGER DEFAULT 500,   -- 单笔限额 5 USDC
  status TEXT DEFAULT 'active',          -- active / frozen / banned
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### transactions 表
```sql
CREATE TABLE transactions (
  id TEXT PRIMARY KEY,              -- UUID
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,                -- topup / deduct / refund
  amount_sat INTEGER NOT NULL,       -- 正数
  service TEXT,                      -- text-to-video / image-to-video / etc
  description TEXT,
  tx_hash TEXT,                      -- 链上 tx (充值时)
  alipay_trade_no TEXT,              -- 支付宝订单号 (充值时)
  status TEXT DEFAULT 'completed',  -- pending / completed / failed / refunded
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

### 设计要点
- 金额用整数（sat = cent），避免浮点精度问题
- 每笔交易都有独立记录，可审计
- 限额可配置，默认保守（单笔 5 USDC，日 10 USDC）

---

## API 设计

### 基础设施
- 服务：独立 Node.js 进程，端口 4402
- 存储：SQLite（`~/clawd/webchatpay/data/db.sqlite`）
- 鉴权：webchat session ID 作为身份标识

### 接口清单

#### 1. 查询余额
```
GET /balance?session_id=<webchat_session_id>

Response:
{
  "balance": 3.99,        // USDC
  "daily_limit": 10.00,
  "single_limit": 5.00,
  "today_spent": 0.00
}
```

#### 2. 扣款（Agent 调用）
```
POST /deduct
{
  "session_id": "<webchat_session_id>",
  "amount": 3.99,
  "service": "text-to-video",
  "description": "prompt: a dragon flying over mountains"
}

Response (成功):
{ "success": true, "tx_id": "xxx", "balance": 0.00 }

Response (余额不足):
{ "success": false, "error": "insufficient_balance", "balance": 1.50, "required": 3.99 }

Response (超限额):
{ "success": false, "error": "exceeds_limit", "limit_type": "single", "limit": 5.00 }
```

#### 3. 充值（USDC 链上）
```
POST /topup
{
  "session_id": "<webchat_session_id>",
  "tx_hash": "0xabc...",
  "amount": 10.00,
  "chain": "base"
}

→ 服务端验证链上交易 → 入账
```

#### 4. 充值（支付宝）
```
POST /topup/alipay
{
  "session_id": "<webchat_session_id>",
  "trade_no": "2026...",
  "amount": 10.00
}

→ 服务端验证支付宝回调 → 入账
```

#### 5. 退款
```
POST /refund
{
  "tx_id": "原交易ID",
  "reason": "service_failed"
}
```

#### 6. 交易记录
```
GET /transactions?session_id=<id>&limit=20&offset=0
```

---

## 充值流程

### 方式一：USDC 链上充值

1. 用户首次交互 → 后端生成专属 Base 充值地址（HD wallet 派生）
2. 展示地址 + 二维码给用户
3. 后端轮询（或 webhook）监听到账
4. 确认后入账，通知用户

```
用户: "生成视频"
Agent: 查余额 → 0
Agent: "余额不足，请充值。你的专属充值地址：
       0xABC... (Base 链 USDC)
       充值后告诉我，我帮你确认。"
用户: [转了 10 USDC]
用户: "充好了"
Agent: [调 /topup 验证 tx] → 入账 → "到账 10 USDC，开始生成视频！"
```

### 方式二：支付宝充值（接现有 skill）

1. Agent 调支付宝 skill 生成收款码
2. 用户扫码支付
3. 支付宝回调 → 后端入账
4. 或用户报订单号 → 后端验证 → 入账

### 方式三：快捷充值（已有钱包的用户）

1. 用户已有 MetaMask/Coinbase 钱包
2. webchat 前端弹 wallet connect
3. 用户签名转 USDC 到托管地址
4. 后端检测到账 → 入账

---

## Agent 集成（核心流程）

### 消费流程（Agent 侧）

```
用户: "帮我生成一个龙飞过山脉的视频"

→ Agent 调用 GET /balance?session_id=xxx
← { "balance": 5.00, ... }

→ 余额充足，Agent 先扣款
→ Agent 调用 POST /deduct
   { "session_id": "xxx", "amount": 3.99, "service": "text-to-video" }
← { "success": true, "tx_id": "abc", "balance": 1.01 }

→ 扣款成功，执行视频生成
→ [video_gen skill 生成视频]

→ 返回视频给用户
→ "视频生成好了！扣了 3.99 USDC，余额还剩 1.01"
```

### 余额不足处理

```
→ Agent 调用 GET /balance
← { "balance": 1.00 }

→ Agent: "余额 1.00，不够生成视频（需要 3.99）
   充值地址：0xABC... (Base USDC)
   或扫码支付宝充值 [二维码]
   充好后告诉我。"
```

### 服务失败退款

```
→ 扣款成功 → 视频生成失败
→ Agent 调用 POST /refund { "tx_id": "abc", "reason": "video_gen_failed" }
← { "success": true, "balance": 5.00 }
→ Agent: "视频生成失败了，已退款 3.99 USDC"
```

---

## 安全设计

### 1. 限额机制
- 单笔限额：默认 5 USDC，可调
- 日累计限额：默认 10 USDC，可调
- 超限拒绝扣款，通知用户

### 2. 原子扣款
```sql
-- 余额检查 + 扣款在一个事务内
BEGIN;
UPDATE users SET balance_sat = balance_sat - 399
  WHERE id = ? AND balance_sat >= 399 AND status = 'active';
-- affected_rows = 0 → 余额不足或状态异常
COMMIT;
```

### 3. 防重放
- 每笔扣款有唯一 tx_id（UUID）
- Agent 只在收到 success 后才执行服务
- 服务失败 → 自动退款

### 4. 审计
- 所有交易记录永久保留
- 支持按用户、时间、类型查询
- 定期对账（链上充值 vs 余额变化）

### 5. 用户身份绑定
- webchat session_id 是主要身份
- 可选绑定手机号/支付宝，跨设备识别
- 充值地址与用户绑定，防止串户

---

## 与现有系统集成

### video_gen skill

在现有 skill 中加一个支付前置检查：

```javascript
// 现有流程：直接生成视频
// 新流程：先扣款 → 再生成

async function handleVideoRequest(sessionId, prompt) {
  // 1. 查余额
  const balance = await webchatpay.getBalance(sessionId);
  if (balance < 3.99) {
    return { error: 'insufficient_balance', ... };
  }

  // 2. 扣款
  const deduct = await webchatpay.deduct(sessionId, 3.99, 'text-to-video');
  if (!deduct.success) {
    return { error: deduct.error, ... };
  }

  // 3. 生成视频
  try {
    const video = await generateVideo(prompt);
    return { success: true, video, balance: deduct.balance };
  } catch (e) {
    // 4. 失败退款
    await webchatpay.refund(deduct.tx_id, 'video_gen_failed');
    return { error: 'generation_failed', refunded: true };
  }
}
```

### OpenClaw Agent (SOUL.md / AGENTS.md)

Agent 行为变更：
- 接到视频请求 → 先查余额 → 余额够 → 扣款 → 生成 → 返回
- 余额不足 → 引导充值 → 等用户充值确认 → 继续
- Boss（Zen7）→ 免费跳过扣款

### 支付宝 skill 复用

充值环节复用现有支付宝 skill：
- 生成收款码
- 支付确认
- 不做双花防护（充值是加钱，不涉及）

---

## 文件结构

```
~/clawd/webchatpay/
├── package.json
├── src/
│   ├── index.js          # Express server
│   ├── db.js             # SQLite 初始化 + 操作
│   ├── routes/
│   │   ├── balance.js
│   │   ├── deduct.js
│   │   ├── topup.js
│   │   └── transactions.js
│   ├── services/
│   │   ├── chain.js      # 链上充值验证
│   │   └── alipay.js     # 支付宝充值验证
│   └── utils/
│       └── hdwallet.js   # HD wallet 派生充值地址
├── data/
│   └── db.sqlite
└── README.md
```

---

## 实施计划

### Phase 1：MVP（最小可用）
- SQLite 数据库 + 基础 API（余额、扣款、充值、记录）
- USDC 链上充值（手动报 tx_hash → 验证入账）
- Agent 集成：视频请求前扣款
- 预计工作量：1-2 天

### Phase 2：支付宝充值
- 接入支付宝 skill 生成收款码
- 支付宝回调自动入账
- 预计工作量：1 天

### Phase 3：自动化
- 链上充值自动检测（轮询/webhook）
- 充值到账通知用户
- 限额管理 UI
- 预计工作量：1-2 天

### Phase 4：增强
- 退款流程完善
- 交易记录查询 API
- 对账脚本
- 预计工作量：1 天

---

## 关键决策点

| 决策 | 推荐 | 备选 | 理由 |
|------|------|------|------|
| 存储 | SQLite | PostgreSQL | 用户量小，SQLite 够用 |
| 金额单位 | 整数 (sat) | 浮点 | 避免精度问题 |
| 充值地址 | HD wallet 派生 | 固定地址+备注 | 派生地址可区分用户 |
| 限额 | 服务端硬限制 | Agent 自律 | 防止 bug 导致超额扣款 |
| 退款 | 自动 | 手动 | 服务失败应自动退款 |
| Boss 免费 | 硬编码白名单 | 配置文件 | 简单直接 |

---

## 风险与应对

| 风险 | 应对 |
|------|------|
| 托管资金安全 | 多签钱包 / 冷热分离 |
| Agent bug 误扣款 | 服务端限额 + 交易审计 + 自动退款 |
| 充值地址泄露 | 每用户独立地址，互不影响 |
| 服务宕机 | SQLite 备份 + 快速恢复 |
| 跑路风险 | 透明对账，用户可查自己的交易记录 |

---

## 与 MoltsPay 的关系

WebchatPay 是 MoltsPay 的上层应用：
- MoltsPay = 链上支付基础设施（签名、结算、多链）
- WebchatPay = webchat 场景的托管余额系统

用户充值时用 MoltsPay（链上转账），消费时用 WebchatPay（内部扣款）。
这样用户不需要每次都做链上交易，体验更顺滑。

未来可以合并：MoltsPay 加一个 `/balance` 层，支持托管余额模式。
但短期独立做更快，不干扰现有 MoltsPay 代码。
