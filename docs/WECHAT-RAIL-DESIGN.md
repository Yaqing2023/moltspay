# WeChat Pay Rail (微信支付 v3)

> **Target**: `moltspay@2.1.0`（提案）
> **Status**: 方案设计（未实现）
> **Scope**: **服务端 verify/settle**（本文档主体）；客户端为"出二维码 + 人扫码"形态，非 Agent 全自动
> **Author**: 基于现有 Alipay Rail（2.0.0）源码逐层镜像

WeChat Pay Rail 是为 MoltsPay 提案的第 2 条法币 rail，让中国大陆商户用**微信支付 v3 标准商户 API**为服务提供 CNY 计价收款，与已有的 USDC/EVM/SVM 加密 rail 及 Alipay AI 收 rail 并存。一处 `provider.wechat` + 每个 service 一段 `wechat` 子对象，同一个 skill 即可同时接受 USDC / 支付宝 / 微信三种支付。

## TL;DR

| 维度 | 值 |
|---|---|
| Chain id | `"wechat"`（`type: "fiat-rail"`，与 `alipay`/EVM/SVM 同位） |
| Scheme | `"wechatpay-native"` |
| 货币 | CNY（对外 `amount` 用**元**字符串对齐 Alipay；对微信 API 内部转**分**整数） |
| 请求签名 | **SHA256-RSA**，商户私钥签 `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n` |
| 应答/回调验签 | 微信**平台证书公钥**验 `Wechatpay-Signature`（`timestamp\nnonce\nbody\n`） |
| 回调解密 | **AES-256-GCM**（apiv3 key + nonce + associated_data + auth tag） |
| Server | 100% 原生 Node `crypto`，无第三方依赖；持有商户 RSA 私钥 + apiv3 key |
| Client | server 返回 `code_url` → 渲染二维码 → **真人扫码**；非 Agent 自动付款 |
| 商户资质 | 仅中国大陆（营业执照 + 微信商户平台入驻 + APIv3 密钥） |

> **与 Alipay rail 的根本区别**：Alipay AI 收提供 agent-payment 协议（`alipay-bot` CLI），Agent 可全自动付款。微信支付**无对标的智能体自动付款产品**，标准商户 API 假定真人扫码/在微信内确认。因此本 rail 的客户端形态是"server 出码 → 人扫码 → server 轮询/回调确认"。本文档聚焦你已确认的范围：**server 端 verify/settle 可行落地**。

---

## 1. 适用前提

微信支付 v3 标准商户 API**仅适用中国大陆商户**，需通过微信商户平台（pay.weixin.qq.com）入驻审核。

| 资质 | 用途 |
|---|---|
| 企业营业执照 | 商户入驻 |
| 微信商户平台账号 | 获取 `mchid`（商户号） |
| 微信公众平台/开放平台应用 | 获取 `appid` |
| API 证书 | 商户**私钥** + **证书序列号** `serial_no` |
| APIv3 密钥 | 32 字节，回调 AES-256-GCM 解密用 |
| 微信平台证书 | 应答/回调验签用（可经 `/v3/certificates` 自动下载，首版用配置注入 PEM） |

产品类型选 **Native 支付**（扫码付），与"为资源出码收款"的 402 形态最契合。

---

## 2. 架构定位（沿用现有渠道抽象）

WeChat rail 复用 MoltsPay 现成的可插拔渠道抽象，**零架构改动**：

```
                 FacilitatorRegistry (registry.ts)
                   │  按 network 选渠道
   ┌──────────┬────┴─────┬───────────┬──────────────┐
 CDP/EVM    Solana     Alipay      WeChat (新增)
 (链上)    (链上)   (alipay-aipay) (wechatpay-native)
                      verify/settle  verify/settle
```

`Facilitator` 接口要求的四个方法，WeChat 的语义映射：

| 接口方法 | WeChat v3 实现 |
|---|---|
| `createPaymentRequirements()` | `POST /v3/pay/transactions/native` 建单 → 返回 `code_url` + `out_trade_no` |
| `verify()` | `GET /v3/pay/transactions/out-trade-no/{no}?mchid=` → `trade_state === 'SUCCESS'` |
| `settle()` | 幂等再确认 SUCCESS，返回 `transaction_id`（Native 付款即捕获，无独立 capture） |
| `healthCheck()` | 校验私钥/平台公钥可解析 + apiv3 key=32B + 网关可达 |

---

## 3. 与 Alipay rail 的协议差异（实现要点）

| 维度 | 支付宝 AI 收（现有） | 微信支付 v3（本方案） |
|---|---|---|
| 传输 | form-urlencoded 网关 `gateway.do` | **REST/JSON** `https://api.mch.weixin.qq.com` |
| 请求签名 | RSA2 对参数字典序串签名 | **SHA256-RSA** 对 `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n` 签名 |
| 鉴权头 | 网关 `sign` 字段 | `Authorization: WECHATPAY2-SHA256-RSA2048 mchid="..",nonce_str="..",signature="..",timestamp="..",serial_no=".."` |
| 应答验签 | 未实现（依赖 HTTPS） | **必须**：平台公钥验 `Wechatpay-Signature` |
| 回调 | 客户端回带 `Payment-Proof` | 微信**异步 notify** 推送，资源体 **AES-256-GCM** 解密 |
| 金额单位 | **元**（小数 `"1.00"`） | **分**（整数 `100`）⚠️ |
| 支付发起 | Agent 自动 `alipay-bot` | `code_url` → 真人扫码 |
| 确认 | `agent.payment.verify` | 订单查询 `trade_state` |
| 履约 | `fulfillment.confirm` | 无独立 capture，SUCCESS 即捕获 |

---

## 4. 落地场景 A：Agent 出码、付款人不限（本期实现场景）

> **已确认范围**。本期实现就服务于这一个场景。

### 4.1 场景定义

一个商家（一个 `mchid`）。Agent 作为**商家侧出码方**，**不与任何付款人绑定**：

- Agent 调微信 **Native 下单**，拿到一个 `code_url`（付款人无关，**不需要 openid**）。
- 该 `code_url` 渲染成二维码后，**谁扫谁付**——不预先指定是张三还是李四。
- **一码一付**：一个 `code_url` = 一笔订单 = 一个固定金额；第一个扫码付款的人付掉后这单关闭。需要再收一笔就**重新出一个新码**。
- 资金全部进**同一个商户号 `mchid`**。

**为什么用 Native 而不是 JSAPI**：JSAPI 下单必须预先传入指定付款人的 `openid`，等于把码绑死到某个人；Native 天生付款人无关，符合"不绑定某个人、谁来都能扫"。

**非目标**：本场景**不是**"一张长期收款码被很多人反复扫"（那是微信"商家收款码/门店码"产品，无法用 v3 下单 API 动态生成）；也**不是**批量给每人各开一单的群收款。

### 4.2 时序

```
Agent (商家侧)                       微信支付                    付款人(任意微信用户)
  │  createPaymentRequirements()        │                              │
  │  POST /v3/pay/transactions/native ─►│                              │
  │  ◄── { code_url } ──────────────────│                              │
  │                                     │                              │
  │  渲染二维码 (qrcode-terminal)        │                              │
  │ ─────────────── 展示二维码 ───────────────────────────────────────►│
  │                                     │  ◄──────── 扫码 + 确认付款 ────│
  │                                     │                              │
  │  轮询 verify():                      │                              │
  │  GET /v3/pay/transactions/          │                              │
  │      out-trade-no/{no}?mchid= ─────►│                              │
  │  ◄── { trade_state: NOTPAY } ───────│   (未付，继续轮询)            │
  │  ◄── { trade_state: SUCCESS } ──────│   (已付，停止)               │
  │                                     │                              │
  │  settle(): 幂等再确认 SUCCESS →返回 transaction_id                  │
  │  交付资源 / 上报到账                  │                              │
```

### 4.3 数据结构与 API 序列

| 步骤 | 方法 | API | 关键字段 |
|---|---|---|---|
| 出码 | POST | `/v3/pay/transactions/native` | 入参 `appid,mchid,description,out_trade_no,notify_url,amount{total(分),currency:CNY}`；出参 `code_url` |
| 轮询 | GET | `/v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=` | `trade_state`：`NOTPAY`/`SUCCESS`/`CLOSED`/`PAYERROR`；`transaction_id`、`amount.payer_total` |
| 关单（可选） | POST | `/v3/pay/transactions/out-trade-no/{out_trade_no}/close` | 超时未付时主动关单，避免悬挂 |

每笔订单的 `out_trade_no` 由 facilitator 生成（唯一）。`code_url` 形如 `weixin://wxpay/bizpayurl?pr=xxxxxxx`，直接进二维码，**不要**自行加工。

### 4.4 轮询 / 超时 / 关单策略

- **轮询间隔**：3s（对齐 alipay-bot 轮询模型），`verify()` 每次查一次订单。
- **总超时**：默认 5min（≤ 微信下单默认有效期）。`createPaymentRequirements` 可设 `time_expire`。
- **终态**：`SUCCESS` → 成功停止；`CLOSED`/`PAYERROR` → 失败停止；超时 → 调用关单 API 后停止。
- **幂等**：`verify()` 与 `settle()` 都是纯查询/确认，可安全重试；不产生副作用。
- **并发**：同一时刻可有多个不同 `code_url` 各自轮询互不影响（但每个码仍是一码一付）。

### 4.5 场景驱动（Agent 用法示意）

```ts
import { WechatFacilitator } from 'moltspay/facilitators';
import qrcode from 'qrcode-terminal';

const wechat = new WechatFacilitator(cfg);

// 1) 出码（付款人无关）
const { x402Accepts, codeUrl, outTradeNo } =
  await wechat.createPaymentRequirements({ priceCny: '10.00', description: '咖啡一杯' });

// 2) 渲染二维码 —— 谁扫谁付
qrcode.generate(codeUrl, { small: true });

// 3) 轮询直到有人付款
const paid = await pollUntilPaid(wechat, outTradeNo, { intervalMs: 3000, timeoutMs: 300_000 });
//    内部循环调 wechat.verify({ payload: { out_trade_no } }, x402Accepts)

// 4) 到账确认
if (paid.valid) console.log('收款成功', paid.details.transaction_id);
```

> 注：场景 A 走**轮询**确认（不依赖异步 notify），因此本期**不需要** `aesgcm.ts` 回调解密；该助手与 notify webhook 留待 Phase 2。

## 5. 文件改动清单（镜像 Alipay 五层）

### 5.1 新增加密助手 `src/facilitators/wechat/`

**`sign.ts`** — SHA256-RSA 签名/验签
```ts
// 构造签名串并用商户私钥签名（PKCS#1 v1.5, RSA-SHA256）
export function wechatV3Sign(
  method: string, urlPath: string, timestamp: string,
  nonce: string, body: string, privateKeyPem: string
): string;

// 拼 Authorization header 值
export function buildAuthorizationToken(args: {
  mchid: string; serialNo: string; nonce: string;
  timestamp: string; signature: string;
}): string;

// 用平台证书公钥验应答/回调签名；永不抛，失败返回 false
export function wechatV3VerifyResponse(
  timestamp: string, nonce: string, body: string,
  signature: string, platformPublicKeyPem: string
): boolean;
```

**`aesgcm.ts`** — 回调资源解密
```ts
// AES-256-GCM 解密（ciphertext 含 16B auth tag，base64）
export function decryptResource(
  args: { ciphertext: string; nonce: string; associatedData: string },
  apiV3Key: string  // 32 字节
): string;  // UTF-8 明文 JSON
```

**`api.ts`** — v3 JSON 通用调用器
```ts
export interface WechatV3Config {
  mchid: string; serial_no: string;
  private_key_pem: string;
  platform_public_key_pem?: string;  // 提供则做应答验签
  apiv3_key: string;
  api_base?: string;  // 默认 https://api.mch.weixin.qq.com
}
// 自动加 Authorization、可选验签、统一错误（非 2xx 抛带 code/message）
export async function wechatV3Call(
  method: 'GET' | 'POST', urlPath: string,
  body: Record<string, unknown> | null, config: WechatV3Config
): Promise<{ status: number; body: any }>;
```

### 5.2 渠道实现 `src/facilitators/wechat.ts`

```ts
export const WECHAT_NETWORK = 'wechat';
export const WECHAT_SCHEME = 'wechatpay-native';
export const WECHAT_API_BASE = 'https://api.mch.weixin.qq.com';
export const WECHAT_AMOUNT_REGEX = /^\d+(\.\d{1,2})?$/;  // 元，≤2 位小数

export interface WechatFacilitatorConfig {
  mchid: string; appid: string; serial_no: string;
  private_key_pem: string; platform_public_key_pem: string;
  apiv3_key: string; notify_url: string; api_base?: string;
}

export class WechatFacilitator extends BaseFacilitator {
  readonly name = 'wechat';
  readonly displayName = 'WeChat Pay';
  readonly supportedNetworks = [WECHAT_NETWORK];

  // 建 Native 单 → code_url + out_trade_no；元→分用 cnyToFen
  async createPaymentRequirements(opts): Promise<WechatPaymentRequirements>;
  async verify(payload, req): Promise<VerifyResult>;   // 订单查询 trade_state
  async settle(payload, req): Promise<SettleResult>;   // 幂等确认 SUCCESS
  async healthCheck(): Promise<HealthCheckResult>;
  // 异步 notify 路由复用：验签 + 解密
  parseCallback(headers, rawBody): { out_trade_no; trade_state; transaction_id };
}

// 元→分，四舍五入防浮点
export function cnyToFen(cny: string): number { return Math.round(parseFloat(cny) * 100); }
```

**`verify()` 语义**：
- 提取 `out_trade_no`（来自 `payload.payload` 或 `requirements.extra.out_trade_no`）
- `GET /v3/pay/transactions/out-trade-no/{out_trade_no}?mchid=`
- `trade_state === 'SUCCESS'` → `{ valid: true, details: { transaction_id, amount, … } }`
- `NOTPAY`/`CLOSED`/异常 → `{ valid: false, error }`，**永不抛**

**`settle()` 语义**：Native 在 SUCCESS 时资金已捕获；`settle` 再查一次确认 SUCCESS，返回 `transaction_id`。失败 fire-and-forget（与 Alipay `fulfillment.confirm` 同策略，不回滚已交付资源）。

### 5.3 注册 / 导出
- `registry.ts`：`this.registerFactory('wechat', (config) => new WechatFacilitator(config as ...))`
- `facilitators/index.ts`：导出 `WechatFacilitator` + 类型 + `WECHAT_NETWORK/WECHAT_SCHEME`

### 5.4 rail 元数据 `chains/index.ts`
```ts
export const WECHAT_CHAIN_ID = 'wechat' as const;
export const WECHAT_RAIL = {
  id: WECHAT_CHAIN_ID, type: 'fiat-rail' as const,
  currency: 'CNY' as const, decimals: 2 as const,
  facilitator: 'wechatpay-native' as const,
} as const;
export function isWechatChainId(id: string): id is typeof WECHAT_CHAIN_ID {
  return id === WECHAT_CHAIN_ID;
}
```

### 5.5 配置 schema `schemas/moltspay.services.schema.json`
- `provider.chain` / `provider.chains` 枚举加 `"wechat"`
- 新增 `provider.wechat`（required: `mchid, appid, serial_no, private_key_path, platform_public_key_path, apiv3_key, notify_url`）
- 服务级 `services[].wechat`：`{ price_cny, description }`

### 5.6 服务端接入 `server/index.ts`
- **构造期**：读 `this.manifest.provider.wechat`，解析 PEM 路径 → 建 `WechatFacilitatorConfig` → 注入 `facilitatorConfig.config.wechat` + 加入 fallback；key 加载失败 → fatal（与 Alipay 一致）
- **`/execute` 分流**（line ~721）：
  ```ts
  if (payScheme === WECHAT_SCHEME || (payNetwork ? isWechatChainId(payNetwork) : false)) {
    return this.handleWechatExecute(skill, params || {}, payment, res);
  }
  ```
- **402 challenge**：新增 `buildWechatChallenge(config)`（镜像 `buildAlipayChallenge`），并入 `accepts[]`；`code_url` 放进 `accepts.extra` 供客户端渲染二维码

### 5.7 配置样例 `moltspay.services.json`
```json
{
  "provider": {
    "name": "Demo",
    "chains": ["base", "alipay", "wechat"],
    "wechat": {
      "mchid": "1900000001",
      "appid": "wx8888888888888888",
      "serial_no": "5157F09EFDC096DE15EBE81A47057A72...",
      "private_key_path": "./cert/wechat_apiclient_key.pem",
      "platform_public_key_path": "./cert/wechat_platform_cert.pem",
      "apiv3_key": "your32byteapiv3keyhere0123456789",
      "notify_url": "https://your.host/wechat/notify"
    }
  },
  "services": [{
    "id": "translate",
    "name": "Translate",
    "price": 0.01, "currency": "USDC",
    "wechat": { "price_cny": "0.10", "description": "翻译服务" }
  }]
}
```

---

## 6. 测试计划（镜像 `test/facilitators/alipay/`）

| 测试 | 覆盖 |
|---|---|
| `wechat/sign.test.ts` | 运行时生成 2048-bit RSA keypair；签名串拼接正确、验签通过、跨密钥隔离、`buildAuthorizationToken` 格式 |
| `wechat/aesgcm.test.ts` | 自加密自解密回环；错误 apiv3 key/篡改 ciphertext → 抛错 |
| `wechat/createPaymentRequirements.test.ts` | mock fetch；元→分转换、Native 请求体、`code_url` 透传 |
| `wechat/verify.test.ts` | mock 订单查询：SUCCESS→valid、NOTPAY→invalid、网络异常→不抛 |
| `wechat/settle.test.ts` | SUCCESS 幂等确认；失败 fire-and-forget |
| `server/wechat-*.test.ts` | manifest 解析 + 402 accepts 含 wechat 项 |

验收：`npm run test:run` 全绿 + `npm run typecheck`（`tsc --noEmit`）零错误 + `npm run build`（tsup）通过。

---

## 7. 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| 金额单位元/分混淆 | 🔴 高 | `cnyToFen` 统一转换 + `Math.round` 防浮点 + 正则校验，单测覆盖 `"0.10"→10` |
| 应答/回调未验签（资金安全） | 🔴 高 | `wechatV3VerifyResponse` 强制启用；平台证书首版配置注入，后续做 `/v3/certificates` 自动下载+轮换 |
| 扫码付款异步性 | 🟡 中 | `verify` 单次查询，由客户端轮询（同 alipay-bot 轮询模型）；可选接 notify webhook 主动确认 |
| 非 Agent 自动付款 | 🟡 中 | 文档明确：本 rail 需真人扫码，区别于 Alipay 全自动 |
| 平台证书过期 | 🟢 低 | 证书自动下载列入 2.2.0 |

---

## 8. 分期

- **Phase 1（本方案，server verify/settle）**：5.1–5.6 + 测试。交付可用的微信 Native 收款 rail（人扫码）。
- **Phase 2**：异步 notify webhook 路由（复用 `parseCallback`）+ 平台证书自动下载/轮换。
- **Phase 3（依赖外部）**：若微信推出智能体自动付款产品，再做 Agent 端自动付款客户端（对标 `alipay-bot`）。

---

## 9. 工作量

约 **10 个新文件 + 4 处接入点改动 + 6 个测试文件**，与 2.0.0 Alipay 接入同量级。核心 verify/settle 逻辑简单（一次签名调用 + 一次订单查询）；复杂度集中在 `sign`/`aesgcm`/`api` 三个助手，全部基于标准 Node `crypto`，**无新增第三方依赖**。
