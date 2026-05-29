# MoltsPay × 支付宝 AI 收 集成方案（Design Doc）

> **状态**：Draft v1 · 待审
> **创建日期**：2026-05-28
> **作者**：Claude（与 Yaqing 协作）
> **关联文档**：
> - `~/clawd/docs/alipay-aipay-402-protocol.md` — 服务端 402 协议（sr007.com 实战参考实现）
> - `~/clawd/docs/alipay-skill-integration-guide.md` — 客户端 CLI 接入流程（`alipay-bot` 官方）
> - `./ALIPAY-INTEGRATION-PLAN.md` — 本设计的执行 checklist（里程碑 + 验收标准）
> - `../SDK_REFACTOR_DESIGN.md` — MoltsPay SDK 架构基线
> - `../src/facilitators/interface.ts` — Facilitator 抽象

---

## 一、目标与非目标

### 目标
1. 在 `moltspay@1.7.0` 中把 **支付宝 AI 收（aipay）作为第 9 条 "rail"** 接入 MoltsPay SDK，与现有 Base / Polygon / BNB / Solana / Tempo 共存于同一 `moltspay.services.json` 配置文件
2. 让服务提供方一行 JSON 把任意 skill 暴露给 **AI Agent 用 RMB / USDC 任意一种支付**，由 Agent 端按偏好/能力路由
3. 复用现有 `Facilitator` 抽象，**最小代码侵入**地新增 `AlipayFacilitator`
4. 与官方 `alipay-bot` CLI 双向兼容：现有 OpenClaw / Claude Code 上跑的 `@alipay/agent-payment` skill 不受影响

### 非目标
- 在 1.7.0 内不实现 **浏览器端（`moltspay/web`）** 的支付宝支付（`alipay-bot` 是 Node CLI，没有浏览器实现）。1.7.x 再讨论收银台 URL 回退
- 不实现 **CNY ↔ USDC 即时汇率换算**。服务提供方在配置里显式声明两套价格
- 不替代 `alipay-bot`。客户端继续 shell-out 调用 CLI（理由见 §五.2）

---

## 二、协议差异 vs x402（必须先理清）

| 维度 | x402（USDC / EVM / SVM） | 支付宝 AI 收 |
|------|--------------------------|--------------|
| 402 challenge header | `X-Payment-Required`（JSON 数组，多 accepts） | `Payment-Needed`（Base64URL 单 JSON） |
| Challenge 结构 | 扁平 `accepts: [{scheme, network, asset, amount, payTo, ...}]` | **嵌套** `{protocol: {...}, method: {...}}` |
| 金额单位 | atomic units（USDC 6 位、BNB 18 位） | **元**（decimal string `"1.00"`） |
| 货币 | USDC / pathUSD / alphaUSD | CNY（`"currency": "CNY"`） |
| 签名 | EIP-712 / EIP-3009 / EIP-2612 permit / SPL transfer | **RSA2 (SHA256WithRSA)** 商户私钥签 8 个字段 |
| 客户端付款 | 钱包签名 → facilitator 上链 settle | 用户在支付宝 APP 内确认 → trade_no + payment_proof |
| Proof header | `X-Payment` | `Payment-Proof`（Base64URL） |
| Verify | 链上 RPC 校验签名 + 余额 + 转账事件 | HTTP 调 `alipay.aipay.agent.payment.verify` |
| Settle | 链上 broadcast transferWithAuthorization / transferFrom | 调 `alipay.aipay.agent.fulfillment.confirm`（履约确认） |
| 失败语义 | settle 失败必须返回 402（1.6.0 修复过 false-positive 200） | 同上 — 验证或履约失败都必须 402 |
| 浏览器 | 1.6.0 已支持 | **不支持**（CLI-only） |
| 合规 | 全球（链上无许可） | 仅中国大陆商户（需 ICP + 营业执照入驻） |

**关键观察**：尽管协议外形差异巨大，**核心抽象都是"402 challenge → user pays → proof → verify → fulfill"**，与 MoltsPay 的 `Facilitator` 接口（`verify` + `settle`）**完全同构**。所以本方案的核心是把 Alipay 当成一个签名/验证机制特殊的 Facilitator。

---

## 三、架构决策

### 决策 1：Alipay 作为 chain id `alipay`，**不**新增 rail 抽象

**选项 A**：新增 `PaymentRail` 抽象层（`EVMRail` / `SolanaRail` / `AlipayRail`）
**选项 B**：把 `alipay` 当成另一个 chain id，复用 `Facilitator` 抽象 ✅

**选 B 的理由**：
- 现有 8 链已经在签名机制上彼此异构（BNB EIP-712 PaymentIntent ≠ Base EIP-3009 ≠ Solana SPL ≠ Tempo permit）；Alipay 只是再加一种
- 引入 `Rail` 抽象会强制 1.7.0 触动所有 8 条链的代码路径 —— 违反 MoltsPay 的 "additive by default" 工程态度
- `chain id` 字符串足够承担命名空间作用（`"alipay"` 已经表达清楚不是 EVM 也不是 SVM）

**代价**：`network` 字段语义被稀释（不再严格是"区块链网络"，可能是支付轨道）。在 `src/chains/index.ts` 加注释即可，不引入运行时复杂度。

### 决策 2：x402 wire format **扩展而不替换**

服务端 402 响应同时发两个 header：
- `X-Payment-Required`（x402 标准，accepts 数组里增加一个 `scheme: "alipay-aipay"` 项）
- `Payment-Needed`（支付宝标准，Base64URL 嵌套 JSON）

**为什么双发**：
- 现有 `alipay-bot` CLI 只认 `Payment-Needed` —— 不发它，OpenClaw / Claude Code 上跑的现有 skill 全挂
- 现有 moltspay Node 客户端只认 `X-Payment-Required` —— 不发它，没法在同一个 `moltspay` 客户端里走 alipay 路径
- 两个 header 内容互相镜像，由 server 中间件统一生成，**单一真相源（single source of truth）在 server 配置**

请求是否带 `Payment-Needed` 由 `Accept-Payment-Rail` 请求头声明（缺省时全发，兼容老客户端）。

### 决策 3：客户端先 shell-out `alipay-bot`，1.8.x 再原生实现

**1.7.0 客户端策略**：`moltspay pay --rail alipay <url>` 内部 spawn `alipay-bot` CLI

**理由**：
- `alipay-bot@0.3.15` 已踩完 6 个坑（PARSE_ERROR、Base64URL、amount 单位、签名字段集、Base64 padding、client_session 提取）—— 见 alipay-aipay-402-protocol.md §九
- 原生实现需要 RSA2 + Alipay 开放平台 SDK + 钱包开通/绑定/查询/履约的整套调用链，**预估 6-8 周**；wrapper 预估 **1 周内可发**
- 节奏上：1.7.0 把 Alipay 接进来（server 端原生 + client 端 wrapper），1.8.0 视真实用量决定是否做 TS 原生客户端

**代价**：客户端必须 require Node ≥ 22（alipay-bot 的要求）；`moltspay/web` rail 列表里不包含 `alipay`。

### 决策 4：服务端 100% 原生 TS 实现，不依赖外部 alipay 服务

**理由**：
- 服务端涉及私钥（RSA2 商户私钥）—— 不应该外包给一个 npm 子进程
- 服务端 alipay 接入逻辑可控、可测、可审计 —— `sr007.com` 已用 Python 跑通端到端，TS 移植难度不高
- 服务端原生实现让我们能在 `MoltsPayServer` 里统一控制 cors / cors-expose / 错误码 / 日志

---

## 四、配置 schema 变更

### 4.1 `moltspay.services.json` 扩展（向后兼容）

```json
{
  "provider": {
    "name": "灵机一物",
    "wallet": "0xYOUR_EVM_WALLET",
    "solana_wallet": "YOUR_SOL_WALLET",
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
    "chains": ["base", "polygon", "solana", "bnb", "alipay"]
  },
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
}
```

**兼容性规则**：
- `provider.alipay` 缺省 → server 不在 accepts 数组里添加 alipay scheme，行为等同今天的 1.6.0
- `services[].alipay` 缺省 → 该 service 不支持支付宝，仅链上支付
- `"alipay" in provider.chains` 触发 server 启动时校验 `provider.alipay.private_key_path` 可读且 RSA 私钥合法

### 4.2 chains registry 扩展

`src/chains/index.ts` 增加：
```ts
export const ALIPAY_RAIL = {
  id: "alipay",
  type: "fiat-rail" as const,  // 新枚举值，与 "evm" / "svm" 并列
  currency: "CNY",
  decimals: 2,
  facilitator: "alipay-aipay",
} as const;
```

---

## 五、实现拆解

### 5.1 服务端：`src/facilitators/alipay.ts`

实现 `Facilitator` 接口（参考 `bnb.ts` / `tempo.ts` 既有形态）。

```ts
export class AlipayFacilitator implements Facilitator {
  network = "alipay";
  scheme = "alipay-aipay";

  // 构造 402 challenge —— RSA2 签名 8 个字段，输出 Payment-Needed Base64URL
  async createPaymentRequirements(opts: CreatePaymentReqOpts): Promise<{
    x402Accepts: X402PaymentRequirements;   // 喂给 X-Payment-Required
    paymentNeededHeader: string;            // 喂给 Payment-Needed
  }> {
    const sign_params = {
      amount: opts.priceCny,                          // "1.00"
      currency: "CNY",
      goods_name: opts.goodsName,
      out_trade_no: `VID${randomBase58(29)}`,
      pay_before: addMinutesISO(30),
      resource_id: opts.resourceId,
      seller_id: this.config.seller_id,
      service_id: opts.serviceId,
    };
    const seller_signature = rsa2Sign(
      sortedQuerystring(sign_params),
      this.config.privateKey
    );
    const challenge = {
      protocol: { ...sign_params, seller_signature, seller_sign_type: "RSA2", seller_unique_id: this.config.seller_id },
      method:   { seller_name: this.config.seller_name, seller_id: this.config.seller_id,
                  seller_app_id: this.config.app_id, goods_name: opts.goodsName,
                  seller_unique_id_key: "seller_id", service_id: opts.serviceId },
    };
    return {
      x402Accepts: this.toX402Accepts(sign_params),
      paymentNeededHeader: base64url(JSON.stringify(challenge)),
    };
  }

  // 验签 + 调 alipay.aipay.agent.payment.verify
  async verify(payload: AlipayPaymentProof): Promise<VerifyResult> {
    const decoded = decodeBase64UrlWithPadFix(payload.proofHeader);   // §九.5 修复 padding
    const { payment_proof, trade_no } = decoded.protocol;
    const { client_session } = decoded.method;
    const resp = await this.alipayOpenApiCall("alipay.aipay.agent.payment.verify", {
      payment_proof, trade_no, client_session,
    });
    return resp.code === "10000"
      ? { valid: true, details: { trade_no, amount: resp.amount, out_trade_no: resp.out_trade_no } }
      : { valid: false, error: `alipay-verify ${resp.code}: ${resp.msg}` };
  }

  // 履约确认（异步）
  async settle(verifyResult: VerifyResult): Promise<SettleResult> {
    const trade_no = verifyResult.details!.trade_no as string;
    const resp = await this.alipayOpenApiCall("alipay.aipay.agent.fulfillment.confirm", { trade_no });
    return resp.code === "10000"
      ? { success: true, transaction: trade_no, status: "fulfilled" }
      : { success: false, error: `alipay-fulfill ${resp.code}: ${resp.msg}` };
  }

  async healthCheck(): Promise<HealthCheckResult> { /* ping gateway，校验私钥 */ }
}
```

**新增文件**：
- `src/facilitators/alipay.ts` — 上面这个类，约 250 行
- `src/facilitators/alipay/openapi.ts` — `alipayOpenApiCall(method, params)` 通用调用器（签名、application/x-www-form-urlencoded、错误码映射），约 120 行
- `src/facilitators/alipay/rsa2.ts` — `rsa2Sign(data, pem)` + `rsa2Verify(data, sig, pem)`，用 Node `crypto` 内置，约 50 行
- `src/facilitators/alipay/encoding.ts` — `base64url` / `decodeBase64UrlWithPadFix`（pad 补齐），约 30 行

**改动文件**：
- `src/facilitators/registry.ts` — 注册 `"alipay-aipay"` scheme → `AlipayFacilitator`
- `src/facilitators/index.ts` — export
- `src/server/index.ts` — 402 中间件检测 provider.alipay 配置后，在响应里**双发** `X-Payment-Required` 和 `Payment-Needed`；`/proxy` 和 `/execute` 路径在收到 `Payment-Proof` header 时分发到 `AlipayFacilitator.verify`
- `src/chains/index.ts` — 注册 `"alipay"` chain id

### 5.2 客户端：Node CLI wrapper + 状态机 + rail 路由

客户端是这个方案里最微妙的一块 —— 它不是"把 server 端那套换个方向跑一遍"，而是涉及 **shell-out 决策 / 异步用户行为 / 多 rail 路由** 三件事，与 server 端原生 RSA2 实现是完全不同类的问题。

#### 5.2.1 决策矩阵：为什么是包 CLI 而不是原生 TS

| 选项 | 工作量 | 1.7.0 可发？ | 风险 |
|------|--------|-------------|------|
| **A. shell-out 包 `alipay-bot@0.3.15`** ✅ | 1 周 | 是 | Node-only；alipay-bot 升级需跟版本 |
| B. 原生 TS 实现（RSA2 + 钱包开通/绑定/查询/回执完整链路） | 6-8 周 | 否 | 重复造轮子，调试支付宝沙箱 + 各种钱包态等 |
| C. 直接调支付宝开放平台 REST API（绕过 CLI） | 4-5 周 | 否 | CLI 已封装了"钱包开通授权 / payment-intent / session-id 管理"等业务态，REST 不暴露 |

**选 A** —— `alipay-bot` 已经把 alipay-aipay-402-protocol.md §九 里的 6 个坑全踩完了（PARSE_ERROR、Base64URL、amount 元/分、签名 8 字段、padding 补齐、client_session 提取），重写就是把这些坑再踩一遍。

**1.8.0 再做 B**，由 1.7.x 真实用量数据决定优先级。

#### 5.2.2 用户感知的 3 个 API 面

**CLI（与 `--chain` 对齐）**：
```bash
moltspay pay --rail alipay https://sr007.com/api/v1/videos/v_001 \
  --intent "购买产品演示视频"
```

**编程式 SDK**：
```ts
import { MoltsPayClient } from "moltspay/client";

const client = new MoltsPayClient({
  railPreference: ["base", "alipay"],          // 路由策略
  alipay: { sessionId: process.env.AIPAY_SESSION_ID }  // 可选
});

const result = await client.pay("https://sr007.com/api/v1/videos/v_001", {
  rail: "alipay",
  onPaymentPending: ({ paymentUrl, tradeNo }) => {
    console.log("请用支付宝扫码：", paymentUrl);
  },
});
```

**MCP tool**：`alipay_pay_402(url, intent_summary)` —— 8 步完整跑完，MCP host（Claude Desktop / Cursor）只需调用一次。

#### 5.2.3 8 步状态机与 Promise 化

skill guide §5 硬规定 8 步**严禁跳过**。`AlipayClient.pay402()` 是一个状态机，每步对应一次 `spawn('alipay-bot', [...])`：

```
SDK 调用                                  内部命令                                              用户感知
─────────────────────────────────────────────────────────────────────────────────────────────────
client.pay(url, { rail: "alipay" })
        │
        ├─ Step 1b  alipay-bot payment-intent --session-id <uuid> --framework moltspay ...
        ├─ Step 2   alipay-bot check-wallet                                                未开通 → NeedsWalletSetupError
        ├─ Step 3   保存 Payment-Needed 到 ~/.moltspay/alipay/402_<reqId>.txt              (内部，用户无感)
        ├─ Step 4   alipay-bot 402-buyer-pay -f <file> -r <url> [-m POST -d ...]           ← 拿到 paymentUrl + tradeNo
        │           │
        │           └─→ onPaymentPending({ paymentUrl, tradeNo, shortenUrl })             ← 回调上抛给调用方
        │
        ├─ Step 5   poll: alipay-bot 402-query-payment-status -t <tradeNo> -r <url>        循环直到成功/超时
        │           间隔 = 3s，timeout = pay_before（默认 30 分钟）
        │           AbortSignal 可中断
        │
        ├─ Step 7   返回 resourceResponse.body 原样给调用方
        └─ Step 8   alipay-bot 402-buyer-fulfillment-ack -t <tradeNo>                      (异步 fire-and-forget)
```

**关键设计**：第 5 步轮询不放在调用栈里阻塞，而是 SDK 内部封装成一个 `pollUntil(tradeNo, signal)` 异步函数，调用方拿到的是一个**最终的 `PaymentResult`**（成功 / 失败 / 超时）。这把 alipay 的"长尾用户行为"对齐到了 EVM 链 settle 的"自动等待"语义 —— 调用方不需要为 alipay 写特殊代码。

#### 5.2.4 shell-out 工程细节

**spawn vs exec**：用 `child_process.spawn`，**不**用 `exec` —— 因为：
- skill guide §5 Step 4 硬规定 **"CLI 输出必须逐字符透传给用户，禁止修改/包装/省略"** —— `spawn` 的 stream API 才能做到行级转发
- `paymentUrl` 之类的内容包含**加密签名**，任何截断都会失效
- alipay-bot 会输出 `MEDIA:` 行（图片路径），需要按行检测、提取、剥离后再上抛

```ts
// src/client/alipay/cli.ts (核心)
async function runCli(args: string[], opts: { onLine: (line: string) => void; signal?: AbortSignal }) {
  const child = spawn("alipay-bot", args, { env: filterEnv(process.env) });
  opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"));

  child.stdout.on("data", chunk => splitLines(chunk).forEach(opts.onLine));   // 行级原样转发
  // stderr 同处理
  return new Promise<number>(resolve => child.on("exit", code => resolve(code ?? 1)));
}
```

**环境变量白名单**：skill guide §7 明确："**仅允许传递以下环境变量，禁止传递其他变量**"。
```ts
const ALLOW = new Set([
  "AIPAY_OUTPUT_CHANNEL", "AIPAY_SESSION_ID",
  "AIPAY_FRAMEWORK", "AIPAY_MODEL", "AIPAY_OS",
  "PATH", "HOME",   // 给 spawn 的最小生存集
]);
function filterEnv(e: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(e).filter(([k]) => ALLOW.has(k)));
}
```

**安装与版本校验**：启动时一次性校验：
```ts
async function ensureCli() {
  try {
    const { stdout } = await execFile("alipay-bot", ["--version"]);
    const v = stdout.match(/v(\d+\.\d+\.\d+)/)?.[1];
    if (!v || semver.lt(v, "0.3.15")) {
      throw new AlipayCliVersionError(
        `alipay-bot ${v ?? "?"} found, need ≥ 0.3.15. ` +
        `Run: npx -y @alipay/agent-payment@latest update`
      );
    }
  } catch (e: any) {
    if (e.code === "ENOENT") throw new AlipayCliNotFoundError(
      "alipay-bot not installed. Run: " +
      "npm install @alipay/agent-payment@1.0.9 && " +
      "npx @alipay/agent-payment@1.0.9 install-cli"
    );
    throw e;
  }
}
```

**不**自动 `npm install` —— 这是有副作用的全局/本地修改，必须用户明确同意（与 1.6.0 一贯的"不偷偷修改用户环境"原则一致）。

**sessionId 处理**：skill guide §5 Step 1b：**`sessionId` 必须是 UUID，禁止自行编造**。解读为"禁止编造一个看起来像 session 的字符串"而**不是**"禁止 SDK 生成 UUID"。所以：
```ts
const sessionId = opts.sessionId
  ?? process.env.AIPAY_SESSION_ID
  ?? crypto.randomUUID();   // 合法 UUID，不是"编造"
```

**tradeNo 严格校验**：skill guide §5 Step 8：`tradeNo` 必须是 32 位纯数字，校验不通过拒绝执行 —— 把它实现在 SDK 层而不是依赖 CLI：
```ts
function assertTradeNo(t: string) {
  if (!/^\d{32}$/.test(t)) throw new AlipayProtocolError(`invalid tradeNo: ${t}`);
}
```

#### 5.2.5 多 rail 路由：server 给两个 rail，client 怎么选？

这是 alipay 引入的真正新问题 —— 1.6.0 之前一个服务只接受一种支付方式。1.7.0 后 server 的 402 accepts 数组可能同时有 USDC（Base）和 CNY（Alipay）。

**路由决策树**：
```
1. 调用方传了 { rail: "alipay" } / --rail alipay？
     → 用 alipay；如果 server 不接受 alipay → UnsupportedRailError
2. 否则看 client.railPreference 配置（ordered list）
     → 取与 server accepts 交集中第一个
3. 否则看 client 实际可用能力
     → 有 EVM wallet 且充值过 USDC → 走 EVM
     → 否则 alipay-bot 在线且钱包已开通 → 走 alipay
4. 否则 → server accepts[0]
```

`railPreference` 是 client 端配置，**不是**全局环境 —— 因为同一个 Agent 可能服务"中国用户偏好支付宝、海外用户偏好 USDC"两种调用方。

#### 5.2.6 错误模型（与 1.6.0 风格对齐）

新增的错误类全部带稳定 `code` 字段（1.6.0 已建立的约定）：
```ts
// src/client/alipay/errors.ts
export class AlipayCliNotFoundError      extends MoltsPayError { code = "ALIPAY_CLI_NOT_FOUND" }
export class AlipayCliVersionError       extends MoltsPayError { code = "ALIPAY_CLI_VERSION" }
export class NeedsWalletSetupError       extends MoltsPayError { code = "ALIPAY_NEEDS_WALLET_SETUP" }
export class AlipayPaymentRejectedError  extends MoltsPayError { code = "ALIPAY_PAYMENT_REJECTED" }
export class AlipayPaymentTimeoutError   extends MoltsPayError { code = "ALIPAY_PAYMENT_TIMEOUT" }
export class AlipayProtocolError         extends MoltsPayError { code = "ALIPAY_PROTOCOL" }
export class UnsupportedRailError        extends MoltsPayError { code = "UNSUPPORTED_RAIL" }
```

这样 MCP host / 上层 Agent 可以基于 `error.code` 决策：`ALIPAY_CLI_NOT_FOUND` 引导用户安装、`ALIPAY_NEEDS_WALLET_SETUP` 引导用户开通钱包、`ALIPAY_PAYMENT_TIMEOUT` 重试一次。

#### 5.2.7 浏览器场景（`moltspay/web`）

**1.7.0 直接放弃浏览器 alipay**：
```ts
// src/client/web/alipay.ts
export class AlipayWebClient {
  async pay(): Promise<never> {
    throw new UnsupportedChainError(
      "alipay rail is not available in browser; use the Node CLI or wait for v1.8.0"
    );
  }
}
```

理由是 `alipay-bot` 是 Node CLI，浏览器跑不动。1.6.0 已经在 `moltspay/web` 这条线上付出过 5/8 链未浏览器 E2E 的诚实代价，1.7.0 没必要再多塞一条假承诺。

**1.7.1 / 1.8.0 的浏览器路径**会是：调支付宝**收银台 URL**（skill guide §6），让用户跳出浏览器到 Alipay 网页/APP 完成，前端轮询 `tradeNo` 状态 —— 这是另一份设计，不在本期内。

#### 5.2.8 最小可工作 demo（落地后调用方写什么）

```ts
import { MoltsPayClient } from "moltspay/client";

const c = new MoltsPayClient();

const out = await c.pay("https://www.sr007.com/api/v1/videos/v_001", {
  rail: "alipay",
  onPaymentPending: ({ paymentUrl, shortenUrl, tradeNo }) => {
    // 在 CLI / MCP 透传支付链接给用户，禁止再包装
    process.stdout.write(`请用支付宝扫码或访问：${shortenUrl}\n`);
  },
  timeoutMs: 30 * 60_000,
});

console.log(out.body);              // 资源内容（视频 URL / 二进制）
console.log(out.payment.tradeNo);   // 32 位 tradeNo
```

SDK 内部状态：`spawn alipay-bot payment-intent` → `spawn alipay-bot check-wallet` → 把 `Payment-Needed` header dump 到 tmp 文件 → `spawn alipay-bot 402-buyer-pay -f ...` 流式回调 → 轮询 `402-query-payment-status` → 拿到 body → fire-and-forget `402-buyer-fulfillment-ack`。

#### 5.2.9 新增/改动文件清单

**新增文件**：
- `src/client/alipay/index.ts` — `AlipayClient` 类 + `pay402()` 8 步状态机，约 250 行
- `src/client/alipay/cli.ts` — `spawn` 包装、stdout/stderr 流式回调、env 白名单、超时控制（与 `SKILL_TIMEOUT_SECONDS` 对齐），约 120 行
- `src/client/alipay/poll.ts` — `pollUntil(tradeNo, signal)` 轮询器（3s 间隔、AbortSignal 中断、`pay_before` 截止），约 60 行
- `src/client/alipay/install.ts` — `ensureCli()` 版本校验（≥ 0.3.15）+ 安装引导错误文案，约 40 行
- `src/client/alipay/router.ts` — `selectRail(serverAccepts, userPref, availability)` 路由决策，约 80 行
- `src/client/alipay/errors.ts` — 上述 7 个 error class，每个带稳定 `code` 字段，约 50 行

**改动文件**：
- `src/client/index.ts` — `MoltsPayClient.pay()` 接 `selectRail()`，alipay 命中时分发到 `AlipayClient`
- `src/client/web/index.ts` — 注册 `AlipayWebClient` 桩（直接 throw `UnsupportedChainError`）
- `src/cli/index.ts` — `moltspay pay --rail alipay <url>` 子命令；`moltspay alipay check / apply / bind` 直透 CLI（便于用户首次开通钱包）

**禁止**：在 `src/client/web/` 下提供真实 alipay 实现。Web bundle 引到 `AlipayClient` 直接 throw `UnsupportedChainError("alipay not supported in browser")`，1.7.0 不退让。

### 5.3 MCP：`src/mcp/tools/alipay.ts`

把客户端能力暴露为 MCP tools：
- `alipay_check_wallet`
- `alipay_pay_402(url, intent_summary)` — 内部跑完整 8 步，返回最终资源 body
- `alipay_pay_cashier(cashier_url, intent_summary)` — 收银台模式

每个 tool 的 description 必须强调 `tradeNo` 32 位纯数字校验、CLI 输出原样透传等约束（这些是 alipay 官方接入协议的硬要求）。

### 5.4 类型 & schema 更新

- `src/types/services.ts` — `ServiceDefinition` 增加可选的 `alipay?: { service_id, price_cny, goods_name }`
- `schemas/moltspay.services.schema.json` — JSON Schema 同步扩展，CI 测试 `validate-config.ts` 跟上
- `src/types/x402.ts` — `X402PaymentRequirements.extra` 在 alipay scheme 下文档约定包含 `{ payment_needed_header: string }`，方便客户端把 alipay 数据从标准 envelope 里也能拿到

### 5.5 包导出

`package.json` `exports` 不新增子路径 — Alipay 能力分别归属 `./server`（`AlipayFacilitator`）、`./client`（`AlipayClient`）、`./mcp`（tool 注册），不污染顶级 API。

---

## 六、测试策略

按 1.6.0 Known Limitations 章节的标准（哪些链有真实链上 E2E、哪些只有单测覆盖）写清楚 1.7.0 alipay 的 QA 矩阵：

| 测试层级 | 范围 | 必须通过的项 |
|----------|------|--------------|
| **单元测试**（vitest） | RSA2 sign/verify、Base64URL padding fix、签名 8 字段字典序、challenge JSON 嵌套结构 | 100% 覆盖 `src/facilitators/alipay/*` |
| **沙箱集成** | 用支付宝沙箱商户走一次 402 challenge → mock proof → verify → fulfill | server 单链完整路径 |
| **真实端到端**（必须做） | 用 1 个真实商户（建议复用 sr007.com / 上海超响应）跑 1 单 1 元 CNY，从 `moltspay-bot pay --rail alipay` 到 `alipay.aipay.agent.fulfillment.confirm` 全程录屏 | **没跑通不许发 1.7.0 latest** |
| **回归** | 现有 8 链每条至少 1 单 E2E，确保 server 双发 header 不破坏 1.6.0 行为 | 老客户端 100% 不感知 |
| **CLI 兼容性** | 用未升级的 `@alipay/agent-payment@1.0.9` skill 直接 hit MoltsPayServer，必须能完成支付 | 验证 `Payment-Needed` header 字节级匹配官方规范 |

**强制**：CHANGELOG 1.7.0 的 Known Limitations 章节必须诚实标注 ——
- 沙箱 vs 生产 vs 端到端各覆盖了什么
- 收银台模式（§六 alipay-skill-integration-guide）1.7.0 是否覆盖
- 浏览器不支持 alipay 是写死的，不是"未测试"

---

## 七、风险 & 缓解

| 风险 | 等级 | 缓解 |
|------|------|------|
| 商户资质门槛（中国 ICP + 营业执照） | 高 | 文档明确"alipay rail 仅适用中国大陆商户"，CLI 在 init 时检测 `provider.alipay` 配置缺失就跳过 |
| `alipay-bot` CLI 升级 break wrapper | 中 | wrapper 启动时 `alipay-bot --version` 校验 ≥ 0.3.15；锁 major 版本，minor 自动接受 |
| 私钥泄漏（server 持有 RSA2 私钥） | 高 | 文件路径配置而非内联；日志脱敏（已有审计 utils 复用）；`schemas/` 加 lint 规则禁止 `.json` 中出现 `BEGIN RSA PRIVATE KEY` |
| amount 单位踩坑（元 vs 分） | 中 | `AlipayFacilitator.createPaymentRequirements` 入参强类型 `priceCny: string`，运行时正则校验 `/^\d+(\.\d{1,2})?$/`，禁止传入 `"100"` 这种含糊值 |
| 履约确认失败时退款语义 | 中 | 按 1.6.0 的设计原则：fulfillment.confirm 失败不当作成功；提供 `--pay-for-success` 模式时回退到不调履约（pay-for-failure 由商户自己异步对账） |
| Payment-Proof base64 padding 兼容 | 低 | 已知坑（§九.5），单测覆盖 |
| 现有 `alipay-bot` 用户被破坏 | 高 | 双发 header 设计；CHANGELOG 标注"server 1.7.0 对 alipay-bot 1.0.x 完全向后兼容"；端到端跑一次未改造的 OpenClaw skill 作为回归 |

---

## 八、路线图

| 版本 | 范围 | 预估工期 | 退出标准 |
|------|------|----------|----------|
| **1.7.0-rc.1** | server 端 `AlipayFacilitator` + 双 header + 沙箱 E2E | 2 周 | 沙箱通过；老客户端回归通过 |
| **1.7.0-rc.2** | 客户端 `AlipayClient`（CLI wrapper）+ `moltspay pay --rail alipay` | 1 周 | 内部 1 元真单端到端通过 |
| **1.7.0** | MCP tool + 文档（README §Alipay Rail）+ CHANGELOG Known Limitations | 0.5 周 | 与 sr007.com 联调 3 单生产，全部 fulfillment.confirm 成功 |
| **1.7.1** | 收银台模式（payment-link 流）+ `alipay-bot` apply/bind/check 兜底回调 | 后置 | — |
| **1.8.0** | TS 原生客户端（去 `alipay-bot` 依赖，支持浏览器收银台 URL 回退） | 1.7.x 用量数据驱动 | 1 元真单浏览器通过 |

---

## 九、开放问题（需 Yaqing 决策）

1. **商户身份**：1.7.0 端到端测试用 sr007.com（你已有联调），还是另起一个 MoltsPay 自有沙箱商户？前者快但耦合外部团队，后者干净但需要新走支付宝商户入驻
2. **CLI 子命令命名**：`moltspay pay --rail alipay <url>` vs `moltspay alipay pay <url>`？前者与 `--chain base` 一致，后者与 `alipay-bot` 习惯一致 —— 我倾向前者，理由是 rail 是"运输通道"语义，与现有 `--chain` 同位
3. **是否在 `provider.chains` 里就用 `"alipay"`**：还是新增 `"provider.rails": ["alipay"]` 字段，把法币 rail 与链 rail 在 schema 层分开？后者更干净但破坏现有 `chains` 数组的全集语义。我倾向前者（一切都是 chain id，文档讲清楚就行）
4. **1.7.0 是否覆盖收银台模式（§六 alipay-skill-integration-guide）**？这是"用户给一个支付宝订单链接，Agent 帮付款"，与 402 反向 —— 它更像"代付钱包"而不是"卖服务"。我倾向放到 1.7.1，理由是它跟 server SDK 关系不大，主要是 MCP tool 直透 `alipay-bot submit-payment`
5. **README 改动幅度**：1.6.0 README 已经 33KB，再塞 Alipay 内容会爆。倾向单独写 `docs/ALIPAY-RAIL.md` 并在 README 加一个 5 行 callout

---

## 十、附：与官方 alipay-bot 的兼容性 checklist

一致性是用户无痛迁移的前提。MoltsPayServer 在 1.7.0 必须满足：

- [ ] `Payment-Needed` header 是 Base64URL（不是标准 Base64）—— §九.2
- [ ] 嵌套 `{protocol: {...}, method: {...}}` 结构 —— §九.1
- [ ] `amount` 单位是元的字符串（`"1.00"`），不是分 —— §九.3
- [ ] 签名仅覆盖 8 个字段，字典序拼接，不含 `protocol` / `method` 自身 —— §九.4
- [ ] `pay_before` 是 ISO 8601 +30 分钟
- [ ] `Access-Control-Expose-Headers` 在浏览器 CORS 场景下额外暴露 `Payment-Needed` 和 `Payment-Proof`（与 1.6.0 暴露 `X-Payment-Required` / `X-Payment-Response` 对齐）
- [ ] `Payment-Proof` 解码前自动补齐 base64 padding —— §九.5
- [ ] verify 时传 `client_session`（从 `method.client_session` 取）—— §九.6
- [ ] 履约确认接口 `alipay.aipay.agent.fulfillment.confirm` 在资源返回后异步调用，**不阻塞用户拿资源**

---

*本文档：Draft v1，等待 Yaqing 在 §九 决策 5 项后进入 1.7.0-rc.1 实现阶段。*
