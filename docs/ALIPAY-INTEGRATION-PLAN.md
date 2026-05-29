# MoltsPay × 支付宝 AI 收 集成执行计划

> **状态**：v1 · §0 决策全部 settled（2026-05-29），rc.1 可启动
> **创建日期**：2026-05-29
> **决策日期**：2026-05-29
> **目标版本**：`moltspay@1.7.0`
> **关联文档**：
> - `./ALIPAY-INTEGRATION-DESIGN.md` — 完整设计（架构决策、配置 schema、文件清单）
> - `~/clawd/docs/alipay-aipay-402-protocol.md` — 服务端 402 协议参考实现（sr007.com）
> - `~/clawd/docs/alipay-skill-integration-guide.md` — 客户端 CLI 接入流程（`alipay-bot` 官方）

本文档是 design doc 的可执行 checklist。每一项都对应一个可勾选状态；rc.1 启动前必须解掉 §0 全部 5 个决策。

---

## §0 启动前决策（已 settled，2026-05-29）

来自 design doc §九。全部按推荐项 A 落定。

- [x] **决策 1：商户身份 → A（复用 sr007.com / 上海超响应）**
  - 已有 Python 端到端跑通、6 个坑都踩完，移植成本可控
  - 取消选项：新建 MoltsPay 自有沙箱商户（入驻周期阻塞 rc.1）
  - **执行影响**：rc.1 沙箱阶段直接用 sr007 沙箱密钥；§3 生产 3 单也在 sr007；商户入驻费用/账号管理推迟到 1.8.x
- [x] **决策 2：CLI 子命令命名 → A（`moltspay pay --rail alipay <url>`）**
  - 与 `--chain base` 同位语义，rail 是"运输通道"
  - 取消选项：`moltspay alipay pay <url>` 子命令形态
  - **执行影响**：`src/cli/index.ts` 在 `pay` 命令下加 `--rail` 选项，不新增 `moltspay alipay` 子命令树；但 `moltspay alipay check / apply / bind` 仍作为**辅助子命令**保留（首次开通钱包用，直透 `alipay-bot`）
- [x] **决策 3：rail 在 schema 中的位置 → A（复用 `provider.chains: ["alipay", ...]`）**
  - 不破坏现有 schema 全集语义；文档讲清楚 chain id 现在可以是 fiat-rail 即可
  - 取消选项：新增 `provider.rails` 字段
  - **执行影响**：`schemas/moltspay.services.schema.json` 不加 `provider.rails`；`src/chains/index.ts` 给 `"alipay"` 标注 `type: "fiat-rail"`；README 加一句"chains 数组现在也可以含法币 rail"
- [x] **决策 4：1.7.0 范围 → A（仅 402，收银台放 1.7.1）**
  - 收银台与 server SDK 关系不大，主要是 MCP 直透 `alipay-bot submit-payment`，没必要拖 1.7.0
  - 取消选项：1.7.0 同时覆盖两种
  - **执行影响**：MCP tool `alipay_pay_cashier` **从 §3 1.7.0 GA 移到 §5 1.7.1**；CHANGELOG Known Limitations 写明"1.7.0 仅 402；收银台 1.7.1"
- [x] **决策 5：文档落地位置 → A（单独 `docs/ALIPAY-RAIL.md` + README 5 行 callout）**
  - README 已 33 KB，再塞会爆
  - 取消选项：直接塞 README
  - **执行影响**：§3 文档清单调整 —— 新建 `docs/ALIPAY-RAIL.md`（用户视角接入指南），README 加一段 callout 指向它

---

## §1 里程碑 1：1.7.0-rc.1（server 端基础 + 沙箱 E2E）

**预估**：2 周
**退出标准**：沙箱通过；老 `alipay-bot` 客户端回归通过

### 新增文件

- [x] `src/facilitators/alipay.ts` — `AlipayFacilitator` 类，4 个方法全部实现（createPaymentRequirements / verify / settle / healthCheck）2026-05-29，组合 56 单测
- [x] `src/facilitators/alipay/openapi.ts` — `alipayOpenApiCall()` 通用调用器（2026-05-29 实现 + 16 单测，含 fetch mock）
- [x] `src/facilitators/alipay/rsa2.ts` — `rsa2Sign` / `rsa2Verify`，Node `crypto` 内置（2026-05-29 实现 + 14 单测）
- [x] `src/facilitators/alipay/encoding.ts` — `base64url` / `decodeBase64UrlWithPadFix`（2026-05-29 实现 + 17 单测）

### 改动文件

- [ ] `src/facilitators/registry.ts` — 注册 `"alipay-aipay"` scheme → `AlipayFacilitator`
- [ ] `src/facilitators/index.ts` — export
- [ ] `src/server/index.ts` — 402 中间件**双发** `X-Payment-Required` + `Payment-Needed`
- [ ] `src/server/index.ts` — `/proxy` 与 `/execute` 在收到 `Payment-Proof` 时分发到 `AlipayFacilitator.verify`
- [x] `src/chains/index.ts` — 注册 `"alipay"` chain id（`ALIPAY_RAIL` 元数据 + `isAlipayChainId` 守卫；不动 `ChainName`/`EvmChainName` union 避免触动 20+ caller，2026-05-29，18 单测含 cross-module 一致性检查）

### Schema 扩展

- [x] `src/server/types.ts` — `ServiceConfig.alipay?: ServiceAlipayConfig` + `ServiceAlipayConfig` 接口（2026-05-29；PLAN 原称 `src/types/services.ts`，实际项目里 service types 在 `src/server/types.ts`）
- [x] `src/server/types.ts` — `ProviderConfig.alipay?: ProviderAlipayConfig` + `ProviderAlipayConfig` 接口（2026-05-29）
- [x] `schemas/moltspay.services.schema.json` — JSON Schema 同步，含 `provider.alipay` / `services[].alipay` / chains enum 加 `"alipay"` / 完整 alipay 示例（2026-05-29）
- [x] `src/facilitators/interface.ts` — `X402PaymentRequirements.extra` 加 per-scheme JSDoc 约定（PLAN 原称 `src/types/x402.ts`，实际在 `src/facilitators/interface.ts`；2026-05-29）
- [ ] `scripts/validate-config.ts` 跟上新字段校验 —— 文件**尚不存在**于仓库，需要时单独建

### 启动校验

- [ ] `provider.chains` 含 `"alipay"` 时，启动校验 `provider.alipay.private_key_path` 可读且 RSA 私钥合法
- [ ] `provider.alipay` 缺省时不发 `Payment-Needed` header，行为等同 1.6.0

### 单元测试（vitest）100% 覆盖 `src/facilitators/alipay/*`

- [x] RSA2 sign/verify（2026-05-29 用 runtime 生成的 2048-bit 双密钥对验证 sign/verify 正确性 + cross-key 拒绝 + 错误鲁棒性，14 单测；真支付宝沙箱密钥对端到端留给 rc.1 沙箱集成阶段）
- [x] Base64URL padding fix（覆盖 `==` / `=` / 无 padding 三种 + URL-safe/标准字母表 + UTF-8 + round-trip，2026-05-29）
- [x] 签名 8 字段字典序：`amount`/`currency`/`goods_name`/`out_trade_no`/`pay_before`/`resource_id`/`seller_id`/`service_id`（2026-05-29，real `rsa2Verify` round-trip + tamper detection）
- [x] Challenge JSON 嵌套结构 `{protocol: {...}, method: {...}}`（2026-05-29，protocol 8 keys + method 6 keys 精确断言 + UTF-8 fidelity）
- [x] `pay_before` ISO 8601 +30 分钟（2026-05-29，UTC `Z` 形式，无 fractional seconds）
- [x] `amount` 正则校验 `/^\d+(\.\d{1,2})?$/`（2026-05-29，15 个 `it.each` 用例覆盖接受/拒绝；`"100"` 由 regex 接受，"元/分含糊"由文档 + types 防范）

### 沙箱集成

- [ ] 支付宝沙箱商户走一次完整 402 challenge → mock proof → verify → fulfill

### 回归

- [ ] 现有 8 链每条 1 单 E2E，确保双发 header 不破坏 1.6.0
- [ ] **CLI 兼容性**：用未升级的 `@alipay/agent-payment@1.0.9` skill 直接 hit MoltsPayServer，必须完成支付

---

## §2 里程碑 2：1.7.0-rc.2（客户端 CLI wrapper + 状态机）

**预估**：1 周
**退出标准**：内部 1 元真单端到端通过

### 新增文件

- [ ] `src/client/alipay/index.ts` — `AlipayClient` + `pay402()` 8 步状态机（~250 行）
- [ ] `src/client/alipay/cli.ts` — `spawn` 包装、stdout/stderr 流式回调、env 白名单（~120 行）
- [ ] `src/client/alipay/poll.ts` — `pollUntil(tradeNo, signal)`，3s 间隔，`pay_before` 截止，`AbortSignal` 中断（~60 行）
- [ ] `src/client/alipay/install.ts` — `ensureCli()` 版本校验 ≥ 0.3.15（~40 行）
- [ ] `src/client/alipay/router.ts` — `selectRail(serverAccepts, userPref, availability)`（~80 行）
- [ ] `src/client/alipay/errors.ts` — 7 个 error class，每个带稳定 `code` 字段（~50 行）

### 改动文件

- [ ] `src/client/index.ts` — `MoltsPayClient.pay()` 接 `selectRail()`，alipay 命中分发到 `AlipayClient`
- [ ] `src/client/web/index.ts` — `AlipayWebClient` 桩直接 throw `UnsupportedChainError`
- [ ] `src/cli/index.ts` — `moltspay pay --rail alipay <url>` 子命令
- [ ] `src/cli/index.ts` — `moltspay alipay check / apply / bind` 直透 CLI（首次开通钱包）

### Skill guide 硬约束（SDK 层实现，不依赖 CLI）

- [ ] **CLI 输出逐字符透传**：`spawn` + 行级 stream API，不用 `exec`
- [ ] **环境变量白名单**：仅 `AIPAY_OUTPUT_CHANNEL` / `AIPAY_SESSION_ID` / `AIPAY_FRAMEWORK` / `AIPAY_MODEL` / `AIPAY_OS` + 最小生存集（`PATH`/`HOME`）
- [ ] **8 步严禁跳过**：状态机强约束步骤顺序，每步对应一次 spawn
- [ ] **sessionId**：`opts.sessionId ?? AIPAY_SESSION_ID ?? crypto.randomUUID()`（不"编造" 假 UUID）
- [ ] **tradeNo 32 位纯数字**：SDK 层 `assertTradeNo` 正则校验，不依赖 CLI
- [ ] **MEDIA: 行**：行级检测、提取图片路径、剥离后上抛
- [ ] **禁止 npm 自动安装**：缺失时报 `AlipayCliNotFoundError`，引导用户手动装

### Error codes（稳定 API）

- [ ] `ALIPAY_CLI_NOT_FOUND`
- [ ] `ALIPAY_CLI_VERSION`
- [ ] `ALIPAY_NEEDS_WALLET_SETUP`
- [ ] `ALIPAY_PAYMENT_REJECTED`
- [ ] `ALIPAY_PAYMENT_TIMEOUT`
- [ ] `ALIPAY_PROTOCOL`
- [ ] `UNSUPPORTED_RAIL`

### 真实端到端（强制）

- [ ] 1 单 1 元 CNY，从 `moltspay pay --rail alipay <sr007 video>` 到 `alipay.aipay.agent.fulfillment.confirm` 全程录屏
- [ ] **录屏归档进 `~/moltspay-qa-notes/`**，与 1.6.0 QA 记录同位

---

## §3 里程碑 3：1.7.0 GA（MCP + 文档）

**预估**：0.5 周
**退出标准**：sr007.com 联调 **3 单**生产，全部 fulfillment.confirm 成功

### 新增文件

- [ ] `src/mcp/tools/alipay.ts` — MCP tool 注册
  - [ ] `alipay_check_wallet`
  - [ ] `alipay_pay_402(url, intent_summary)` — 8 步完整跑完
  - ~~`alipay_pay_cashier`~~ —— 按决策 4，移到 §5 1.7.1
- [x] `docs/ALIPAY-RAIL.md` —— 用户视角接入指南（按决策 5，2026-05-29 v1 草稿落地）

### 文档

- [x] `docs/ALIPAY-RAIL.md` 内容覆盖：商户入驻前置、`provider.alipay` 配置、`services[].alipay` 配置、`moltspay pay --rail alipay` 用法、错误码表（7 个 `ALIPAY_*` code）、常见坑（amount 元/分、service_id 前缀、签名 8 字段）+ 端到端示例 + x402 对比
- [x] README 加 callout 行，链接到 `docs/ALIPAY-RAIL.md`（Features 列表，1 行紧凑形式）
- [ ] CHANGELOG（GitHub Release notes，CHANGELOG.md 仍 gitignore）
  - [ ] Known Limitations：浏览器**写死不支持** alipay（不是"未测试"）
  - [ ] Known Limitations：仅中国大陆商户（需 ICP + 营业执照）
  - [ ] Known Limitations：收银台模式覆盖度（按决策 4 写）

### 生产验收

- [ ] sr007.com 1 单 1 CNY，fulfillment.confirm `code: 10000`
- [ ] sr007.com 1 单 ≥10 CNY，fulfillment.confirm `code: 10000`
- [ ] sr007.com POST 请求 1 单（验证 `-m POST -d` 路径），fulfillment.confirm `code: 10000`

---

## §4 横切验收（任何 milestone 完成都不放过）

### 兼容性 checklist（design doc §十）

- [ ] `Payment-Needed` 是 **Base64URL**（不是标准 Base64）
- [ ] 嵌套 `{protocol: {...}, method: {...}}` 结构
- [ ] `amount` 单位是**元**的字符串（`"1.00"`），不是分
- [ ] 签名仅覆盖 8 字段，字典序拼接，不含 `protocol` / `method` 自身
- [ ] `pay_before` ISO 8601 +30 分钟
- [ ] `Access-Control-Expose-Headers` 浏览器 CORS 暴露 `Payment-Needed` 和 `Payment-Proof`（即便 1.7.0 不让浏览器付 alipay，header 也得暴露给读 challenge 的页面）
- [ ] `Payment-Proof` 解码前自动补齐 base64 padding
- [ ] verify 时传 `client_session`（从 `method.client_session` 取）
- [ ] 履约确认 `alipay.aipay.agent.fulfillment.confirm` 在资源返回后**异步**调用，**不阻塞**用户拿资源

### 风险登记（design doc §七，监控直到 1.7.0 GA）

| 风险 | 级别 | 缓解状态 |
|---|---|---|
| 商户资质门槛（中国 ICP + 营业执照） | 高 | [ ] 文档明确 + CLI 检测 `provider.alipay` 缺失跳过 |
| `alipay-bot` CLI 升级 break wrapper | 中 | [ ] `ensureCli()` 锁 ≥ 0.3.15；major 锁定，minor 接受 |
| 私钥泄漏（RSA2 商户私钥） | 高 | [ ] 文件路径配置，禁止内联；日志脱敏；schema lint 禁 `BEGIN RSA PRIVATE KEY` |
| amount 单位（元 vs 分） | 中 | [ ] 强类型 `priceCny: string` + 正则校验 |
| 履约失败退款语义 | 中 | [ ] fulfillment.confirm 失败不当作成功 |
| Payment-Proof base64 padding | 低 | [ ] 单测覆盖 |
| 现有 `alipay-bot` 用户被破坏 | 高 | [ ] 双发 header；老 1.0.9 skill 回归通过 |

---

## §5 1.7.0 之后（参考，不在本期 scope）

- **1.7.1**（按决策 4 落定的范围）：
  - `alipay_pay_cashier(cashier_url, intent_summary)` MCP tool（直透 `alipay-bot submit-payment`）
  - `moltspay alipay pay-cashier <url>` CLI 子命令
  - `apply` / `bind` / `check` 兜底回调（钱包未开通时的引导流）
- **1.8.0**：TS 原生客户端（去 `alipay-bot` 依赖），浏览器收银台 URL 回退；触发条件 = 1.7.x 真实用量数据
- **1.8.x / 之后**：MoltsPay 自有沙箱商户入驻（决策 1 推迟项），降低对 sr007.com 的耦合

---

## 附：自检入口

任一时刻，回到这份文档，检查：

1. §0 五个决策是否都解了？没解就不许碰 §1
2. §1 / §2 / §3 当前 milestone 的全部 checkbox 是否都打了勾？没打满不许进下一个 milestone
3. §4 兼容性 checklist 是否每个 milestone 重跑一次？因为任何 server 改动都可能破坏 1.6.0 老客户端兼容
4. §4 风险登记中"高"级项是否都有缓解措施已落地？未落地不许发 latest tag

*本文档随 1.7.0 实现推进同步更新。每个 PR merge 后回来打 checkbox。1.7.0 GA 时归档为 v1 final。*
