# Alipay Rail (支付宝 AI 收)

> **Target**: `moltspay@1.7.0`
> **Status**: 设计完成、rc.1 实现中
> **Scope**: 服务端 + Node CLI 客户端；浏览器**不支持**（1.7.0 写死，1.8.0 走收银台 URL 回退）

Alipay Rail 是 MoltsPay 1.7.0 引入的第 9 条 rail（继 Base / Polygon / Solana / BNB / Tempo / XRPL 之后），让中国大陆商户用支付宝 AI 收为 AI Agent 提供 CNY 计价服务。一处 `provider.alipay` + 每个 service 一段 `alipay` 子对象，同一个 skill 即可同时接受 USDC 和 CNY 两种支付，由 Agent 端按偏好/能力路由。

## TL;DR

| 维度 | 值 |
|---|---|
| Chain id | `"alipay"`（`type: "fiat-rail"`，与 EVM/SVM 同位） |
| 货币 | CNY（`amount` 单位是**元**字符串，不是分） |
| 签名 | RSA2（SHA256WithRSA），商户私钥签 8 字段字典序拼接 |
| Client | Node CLI shell-out `alipay-bot@0.3.15`（1.7.0）；TS 原生待 1.8.0 |
| Server | 100% 原生 TS，持有 RSA2 私钥 |
| Browser | 不支持（throw `UnsupportedChainError`） |
| 商户资质 | **仅中国大陆**（ICP + 营业执照 + 支付宝开放平台入驻） |
| 与 1.6.0 兼容 | server 双发 `X-Payment-Required` + `Payment-Needed`，老 `alipay-bot` skill 0 改动 |

## 1. 适用前提

支付宝 AI 收**仅适用中国大陆商户**，需通过支付宝开放平台入驻审核。

| 资质 | 用途 |
|---|---|
| ICP 备案 | 必须 |
| 企业营业执照 | 商户入驻 |
| 支付宝开放平台账号 | 创建应用 + 获取密钥 |
| AI 收产品开通 | 必须 |

入驻完成后会拿到：
- `seller_id`（商户 ID，16 位数字）
- `app_id`（应用 ID，16 位数字）
- RSA2 商户私钥（`.txt`）+ 支付宝公钥（`.txt`）
- `service_id`（服务 ID，形如 `API_0EA6DC4FC99A4DF7`，以"推进开发"页面显示为准）

> 入驻流程见支付宝官方文档：https://ideservice.alipay.com/cms/site/0j7svz.md
>
> 海外商户或个人开发者请使用 USDC rail（Base / Polygon / Solana / BNB / Tempo），无需入驻。

## 2. 服务端配置

### 2.1 `provider.alipay`

```json
{
  "provider": {
    "name": "灵机一物",
    "wallet": "0xYOUR_EVM_WALLET",
    "alipay": {
      "seller_id": "2088641494699428",
      "app_id": "2021006150642142",
      "seller_name": "上海超响应数字科技有限公司",
      "service_id_default": "API_0EA6DC4FC99A4DF7",
      "private_key_path": "./cert/ALIPAY_PRIVATE_KEY.txt",
      "alipay_public_key_path": "./cert/ALIPAY_PUBLIC_KEY.txt",
      "gateway_url": "https://openapi.alipay.com/gateway.do",
      "sign_type": "RSA2"
    },
    "chains": ["base", "polygon", "alipay"]
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `seller_id` | ✅ | 商户支付宝 ID |
| `app_id` | ✅ | 应用 ID |
| `seller_name` | ✅ | 商户全称（402 challenge 里 `method.seller_name`） |
| `service_id_default` | ✅ | 默认 service_id；service 级可覆盖 |
| `private_key_path` | ✅ | RSA2 商户私钥文件路径（相对 `moltspay.services.json` 所在目录） |
| `alipay_public_key_path` | ✅ | 支付宝公钥文件路径（验签 `Payment-Proof`） |
| `gateway_url` | 可选 | 默认 `https://openapi.alipay.com/gateway.do`；沙箱用 `https://openapi.alipaydev.com/gateway.do` |
| `sign_type` | 可选 | 默认 `RSA2`，目前唯一支持值 |

> 🔒 **私钥安全**：必须用 `private_key_path` 文件路径，**禁止内联**到 JSON。`.gitignore` 加 `cert/`。服务启动时校验私钥可读 + RSA 格式合法，失败拒绝启动。

### 2.2 `chains` 数组加入 `"alipay"`

```json
"chains": ["base", "polygon", "alipay"]
```

1.7.0 起 chain id 引入 `type: "fiat-rail"`，与现有 `type: "evm"` / `type: "svm"` 并列。`chains` 数组**不破坏全集语义**——任何被启用的 rail 都在这里声明。

### 2.3 `services[].alipay`

```json
"services": [{
  "id": "text-to-video",
  "function": "textToVideo",
  "price": 0.99,
  "currency": "USDC",
  "alipay": {
    "service_id": "API_0EA6DC4FC99A4DF7",
    "price_cny": "7.00",
    "goods_name": "产品演示视频 - 系列一"
  }
}]
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `service_id` | 可选 | 缺省用 `provider.alipay.service_id_default` |
| `price_cny` | ✅ | CNY 价格，**字符串、单位元、≤ 2 位小数**。`"7.00"` = 7 元；`"100"` = **100 元**（不是分） |
| `goods_name` | ✅ | 用户在支付宝 APP 看到的商品名 |

⚠️ **`price`（USDC）与 `price_cny`（CNY）是两套独立价格**，MoltsPay 不做汇率换算。你自己决定 USDC `0.99` 是否等价于 CNY `7.00`。

### 2.4 启动校验

`moltspay start` 启动时（检测到 `provider.alipay`）会执行：

- ✅ `private_key_path` / `alipay_public_key_path` 可读
- ✅ 私钥是合法 RSA PEM 格式
- ✅ 每个 `services[].alipay.price_cny` 正则匹配 `/^\d+(\.\d{1,2})?$/`
- ✅ 每个 `services[].alipay.service_id`（或 fallback 默认）非空

任一失败，服务拒绝启动并打印具体原因。

### 2.5 server 双 header 兼容

server 在 402 响应里同时发：
- `X-Payment-Required`（x402 标准，`accepts` 数组里加 `scheme: "alipay-aipay"` 一项）
- `Payment-Needed`（支付宝标准，Base64URL 编码的嵌套 JSON）

两个 header **互为镜像**，由 server 中间件统一生成。这样：
- 新的 `moltspay` 客户端用 `X-Payment-Required` 走 alipay 路径
- 老的 `alipay-bot` skill 只认 `Payment-Needed`，0 改动可工作

请求侧用 `Accept-Payment-Rail` 声明能力，缺省时全发。

## 3. CLI 客户端用法

> 🌐 **Node-only**：CLI 客户端 wrap 了 `alipay-bot@0.3.15`，仅在 Node ≥ 22 上可用。浏览器（`moltspay/web`）直接 throw `UnsupportedChainError`。

### 3.1 前置：安装 `alipay-bot`

```bash
# 校验包完整性
npm view @alipay/agent-payment@1.0.9 dist.integrity

# 安装 + 装 CLI
npm install @alipay/agent-payment@1.0.9 && \
  npx @alipay/agent-payment@1.0.9 install-cli

# 验证
alipay-bot --version   # 预期 ≥ 0.3.15
```

未安装时 MoltsPay 报 `ALIPAY_CLI_NOT_FOUND`，**不**自动 install（与"不偷偷修改用户环境"原则一致）。

### 3.2 一次性：开通钱包

```bash
# 申请开通（返回授权链接，用户在支付宝 APP 扫码授权）
moltspay alipay apply

# 授权完成后绑定
moltspay alipay bind -c "<授权码>"

# 检查状态
moltspay alipay check
```

辅助子命令直透同名 `alipay-bot` 命令，主要为首次开通钱包用。

### 3.3 支付：402 协议

```bash
moltspay pay --rail alipay https://www.sr007.com/api/v1/videos/v_001 \
  --intent "购买产品演示视频"
```

`--rail alipay` 与 `--chain base` 同位。命中后内部 8 步状态机：

```
1. payment-intent       初始化会话
2. check-wallet         钱包状态校验
3. 保存 Payment-Needed  到 ~/.moltspay/alipay/402_<reqId>.txt
4. 402-buyer-pay        发起支付，输出支付链接 + tradeNo
5. 等用户扫码           回调 onPaymentPending 上抛
6. 402-query-payment-status  3s 轮询直至成功/超时
7. 透传资源 body 给调用方
8. 402-buyer-fulfillment-ack  履约确认（异步 fire-and-forget）
```

CLI 输出包括支付链接（含 RSA2 签名），**逐字符透传**，禁止任何 string manipulation。

### 3.4 程序式 SDK

```ts
import { MoltsPayClient } from "moltspay/client";

const client = new MoltsPayClient();

const out = await client.pay("https://www.sr007.com/api/v1/videos/v_001", {
  rail: "alipay",
  onPaymentPending: ({ paymentUrl, shortenUrl, tradeNo }) => {
    process.stdout.write(`请用支付宝扫码或访问：${shortenUrl}\n`);
  },
  timeoutMs: 30 * 60_000,   // 默认 30 分钟 = pay_before
});

console.log(out.body);              // 资源内容
console.log(out.payment.tradeNo);   // 32 位 tradeNo
```

### 3.5 多 rail 路由

服务端同时支持 USDC + Alipay 时，客户端按下面顺序选 rail：

```
1. 显式 { rail: "alipay" } / --rail alipay
2. client.railPreference 配置（ordered list）的首项
3. 客户端实际可用能力：
   - 有 EVM wallet 且充值过 USDC → 走 EVM
   - 否则 alipay-bot 在线 + 钱包已开通 → 走 alipay
4. 服务端 accepts[0]（兜底）
```

`railPreference` 是 client 级配置，不是全局 env——同一 Agent 可同时服务"中国用户偏好支付宝、海外用户偏好 USDC"两套调用方。

## 4. 错误码表

所有 alipay 相关错误都带稳定 `code` 字段，便于程序化处理：

| Code | 含义 | 建议处理 |
|---|---|---|
| `ALIPAY_CLI_NOT_FOUND` | `alipay-bot` 未安装 | 引导 `npm install @alipay/agent-payment@1.0.9 && npx ... install-cli` |
| `ALIPAY_CLI_VERSION` | `alipay-bot` 版本 < 0.3.15 | 引导 `npx -y @alipay/agent-payment@latest update` |
| `ALIPAY_NEEDS_WALLET_SETUP` | 钱包未开通 / 已申请未授权 | 引导 `moltspay alipay apply` + `bind` |
| `ALIPAY_PAYMENT_REJECTED` | 用户在支付宝 APP 取消 | 询问用户重试或换 rail |
| `ALIPAY_PAYMENT_TIMEOUT` | 超过 `pay_before`（默认 30 分钟）未支付 | 重试或换 rail |
| `ALIPAY_PROTOCOL` | 协议层错误（tradeNo 格式 / 签名 / parse） | 上报 issue，通常是 `alipay-bot` 升级或商户配置不一致 |
| `UNSUPPORTED_RAIL` | 服务端不接受 alipay | 换 rail 或联系 service provider 开通 |

## 5. 常见坑

### 5.1 `amount` 单位是**元**，不是分

支付宝 AI 收的 402 challenge 里 `amount` 单位是**元**的字符串：

- `"1.00"` = 1 元 ✅
- `"100"` = **100 元**（不是 100 分）✅
- 商户后台"服务单价"必须与 `services[].alipay.price_cny` 一致，否则 `SERVICE_PRICE_MISMATCH`

MoltsPay server 启动时正则 `/^\d+(\.\d{1,2})?$/` 校验，拒绝歧义值。

### 5.2 `service_id` 前缀

商户后台两个页面会显示 service_id：
- "审核通过"页 —— 历史 ID
- "推进开发"页 —— **当前生效** ID（可能形如 `API_xxx`）

`services[].alipay.service_id` 必须填**"推进开发"页**的 ID，否则报 `SERVICE_NOT_EXIST`。

### 5.3 签名 8 字段，字典序拼接

RSA2 签名只覆盖 8 个字段，按 key 字典序排列：

```
amount / currency / goods_name / out_trade_no / pay_before / resource_id / seller_id / service_id
```

不含 `protocol` / `method` 嵌套结构本身，不含 `seller_signature` / `seller_sign_type` 等元字段。`AlipayFacilitator.createPaymentRequirements()` 已经实现；手工调用需按这个集合签。

### 5.4 `Payment-Needed` 是 Base64URL（不是标准 Base64）

`Payment-Needed` header 用 **Base64URL** 编码（`-` 替 `+`，`_` 替 `/`，padding 可选）。

`curl -H` 转发 header 时注意 shell 解释 `=`；推荐用 Node.js 提取（见 `alipay-skill-integration-guide` Step 3）。MoltsPay 客户端已封装。

### 5.5 `Payment-Proof` base64 padding 自动补齐

某些 proxy 会去掉末尾 `=`。server 端 verify 自动补齐：

```ts
const padded = proof + "=".repeat((4 - proof.length % 4) % 4);
```

### 5.6 浏览器不支持 alipay

1.7.0 在 `moltspay/web` 写死 `throw new UnsupportedChainError(...)`。原因：`alipay-bot` 是 Node CLI。

浏览器路径走"收银台 URL"（用户跳到支付宝 APP，前端轮询 `tradeNo`）—— 这是 1.8.0 范围，不在 1.7.0。

### 5.7 CLI 输出禁止修改

`moltspay pay --rail alipay` 输出的支付链接包含 RSA2 签名，任何修改（包括 ANSI 美化、行截断、加 emoji、改语序）都会让链接失效。MoltsPay SDK 内部用 `spawn` + stream API 行级原样转发；上层调用方在打印前**禁止** string manipulation。

### 5.8 `tradeNo` 必须 32 位纯数字

`alipay-bot 402-buyer-fulfillment-ack` 拒绝任何非 32 位纯数字的 `tradeNo`。SDK 层 `assertTradeNo` 在调用前先正则校验 `/^\d{32}$/`，校验失败直接抛 `ALIPAY_PROTOCOL`，不让调用 alipay-bot。

## 6. 端到端示例

```bash
# 1. 商户：启动 server（带 alipay 配置）
moltspay start ./my-skill --port 3000

# 2. 客户：首次开通钱包
moltspay alipay apply
moltspay alipay bind -c "AUTH_xxxxx"
moltspay alipay check         # 期望：code: 200, "已开启"

# 3. 客户：发起支付
moltspay pay --rail alipay http://merchant.local:3000/services/text-to-video \
  --intent "购买产品演示视频" \
  --data '{"prompt":"demo"}'

# CLI 内部状态（透传给用户）：
#   [1] payment-intent  initialized session
#   [2] check-wallet    code: 200
#   [3] saved Payment-Needed → ~/.moltspay/alipay/402_<uuid>.txt
#   [4] 402-buyer-pay  payment URL: https://qr.alipay.com/c1x...xyz
#                      tradeNo: 20240528xxxxxxxxxxxxxxxxxxxxxxxxxx
#   [5] waiting for user to scan & confirm in Alipay app...
#   [6] 402-query-payment-status  SUCCESS
#   [7] resource: {"video_url":"https://..."}
#   [8] 402-buyer-fulfillment-ack  confirmed (async)
```

## 7. 与其它 rail 的对比

| 维度 | x402 (USDC) | Alipay AI 收 |
|---|---|---|
| 402 header | `X-Payment-Required`（JSON 数组） | `Payment-Needed`（Base64URL JSON） |
| Challenge 结构 | 扁平 `accepts[]` | 嵌套 `{protocol, method}` |
| 货币 | USDC（atomic units） | CNY（元，decimal string） |
| 签名 | EIP-712 / EIP-3009 / Permit / SPL | RSA2 SHA256WithRSA |
| 客户端付款 | 钱包签名 → 链上 settle | 用户支付宝 APP 确认 → trade_no |
| Proof header | `X-Payment` | `Payment-Proof` |
| Verify | 链上 RPC | HTTP `alipay.aipay.agent.payment.verify` |
| 浏览器 | ✅ 1.6.0 起支持 | ❌（CLI-only，1.8.0 起走收银台 URL） |
| 合规 | 全球 | 仅中国大陆商户 |

## 8. 参考

- [`./ALIPAY-INTEGRATION-DESIGN.md`](./ALIPAY-INTEGRATION-DESIGN.md) — 完整架构设计 + 决策记录
- [`./ALIPAY-INTEGRATION-PLAN.md`](./ALIPAY-INTEGRATION-PLAN.md) — 实现 checklist + 里程碑
- 支付宝官方文档：https://ideservice.alipay.com/cms/site/0j7svz.md
- `@alipay/agent-payment` npm 包：https://www.npmjs.com/package/@alipay/agent-payment

---

*文档版本：v1（rc.1 实现中）| 创建：2026-05-29 | 目标版本：`moltspay@1.7.0`*
