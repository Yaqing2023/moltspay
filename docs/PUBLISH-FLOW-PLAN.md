# PUBLISH-FLOW-PLAN — 一条命令上架（钱包签名即身份）

状态：MVP 已实现并本地联调通过，待部署（需重启线上 moltspay-creators，等 Boss 点头）
作者：Zen7 Assistant
最后更新：2026-08-20

**进度（2026-08-20）：**
- ✅ creators 端：`POST /registry/publish` + `DELETE /registry/publish/:serviceId` + migration 023（products.service_id）。
- ✅ CLI 端：`moltspay publish <path> --url` + `moltspay unpublish <service-id>`（钱包签名 SIWE，无账号无 key）。
- ✅ 本地联调：真实 CLI 打本地 creators 实例，publish→registry 可见→幂等改价→unpublish 全绿。
- ✅ 平台托管 Tier 1（代理托管）：migration 024（products.hosting_mode/upstream_url）+ publish 接口支持
  `hostingMode:'proxy'`（service_endpoint 自动填平台 `/a/:username/services/:id/execute`，upstream 存卖家 API）+
  `agent.js` execute 双端点按 hosting_mode 分流（proxy=settle-only→executeService 打 upstream）+
  `payment.js` executeService 用 upstream_url + CLI `publish --proxy --upstream`。本地测试全绿（含 SSRF 拦截、
  DB 存储、executeService 转发到卖家 API 验证）。
- ⏳ 未部署：线上 moltspay-creators 尚未加载新接口（迁移全是加列，安全），需重启才生效 —— 等 Boss 决定。
- 注意：钱包登录端点在 `/cri/auth/wallet/*`（不是 `/auth`），CLI 已按此硬编码。
- 未做（Tier 1 收尾）：真实 x402 结算→upstream 的端到端仅逻辑验证（结算路径与 file_download 复用，已在线上跑）；
  Tier 2（Railway 跑代码）/Tier 3（沙箱）未动。

**已锁定范围（2026-08-20 拍板）：**
- 第一批**不带**平台托管 URL —— 自托管 + 手给 `--url`，先跑通闭环验证需求。
- 收款地址**强制 == 签名钱包** —— 最简单最安全；分离方案留到后续批次。

---

## 0. 目标

让开发者写完 skill 后执行 **`moltspay publish`**，自动完成：
本地校验 → 钱包签名换身份 → 把服务写进公开 registry → 可被发现、可收款。

全程 **无需注册账号、无需 API key、无需碰 moltspay.com 后台**。

一句话验收：装了 moltspay + 有一个收款钱包（收款本来就需要）→ 敲一条命令 → 服务上架可被 Agent 发现。

---

## 1. 背景与现状（为什么要做）

调研结论（2026-08-20，已核对源码）：

- 公开 registry 由 **moltspay-creators** 提供，且 **只读**：`src/routes/registry.js` 只有 GET
  （`/registry/services|tags|creators|stats`）。
- registry 里的"服务" = **products 表的一行**：`GET /registry/services` 实际
  `FROM products p JOIN creators c LEFT JOIN agents a`，条件 `p.is_active=1 AND c.wallet_address IS NOT NULL`。
- products 全站唯一写入点 = **`POST /products`**（`src/routes/products.js:75`），走 web JWT，
  必须先注册 creator + 绑钱包，`service_endpoint` 手填公网 URL。
- **CLI 与 registry 完全没连线**：`moltspay validate/start` + `moltspay.services.json` 跟 products 表
  无任何代码关系。CLI 起的服务永远不会自动进 registry。
- 全站**没有** api-key / x-api-key，鉴权只有 web JWT。

结论：注册是"网站独占"的，CLI 只是消费方（读 registry + 付款），没有生产方能力。
要打通"接入即上架即收款"闭环，必须在 midtier 里补上写入 registry 的原语。

### 为什么放进 midtier

midtier 是所有开发者的必经之路。把 publish 做成 midtier 原语 = 能力加一次，所有开发者白拿，
midtier 从"支付库"升级为"生态底座"。反之若让每个服务各自对接注册，就是 N 个人重复踩坑。

---

## 2. 核心设计：钱包签名即身份（零账号零 key）

卖家为了收款本来就必须有钱包。这一个东西同时解决三件事：

| 作用 | 说明 |
|------|------|
| 身份 | 钱包地址就是"他是谁" |
| 鉴权 | 私钥签一个 challenge，证明钱包归他 |
| 收款 | 这地址本来就是打款地址 |

**关键利好：creators 端底层已现成。** `POST /auth/wallet/nonce` + `POST /auth/wallet/verify`
（`src/routes/auth.js:973+`）已实现 SIWE 钱包登录：
- `ethers.verifyMessage` 验签；
- 按 `wallet_address` 查 creator：有 → 登录；无 → **自动建号**（username `wallet-xxxx`，占位邮箱）；
- 返回 JWT。

即"首次 publish 自动开号"底层已支持，无需新造账号体系，也无需 API key。

---

## 3. publish 完整流程（CLI 内部自动跑，用户无感）

```
moltspay publish <skill路径> --url <公网URL>
  │
  ├─ 1. 本地 validate（复用现成 moltspay validate）
  ├─ 2. GET  /auth/wallet/nonce   （用 ~/.moltspay 钱包地址）
  ├─ 3. 本地私钥签 nonce message
  ├─ 4. POST /auth/wallet/verify  → 换回 JWT（首次带 acceptedTerms）
  ├─ 5. POST 写接口（带 JWT）：manifest 里每个 service → upsert 一个 product
  └─ 6. 打印上架结果 + registry 可见链接
```

用户视角：一条命令，无注册页、无邮箱验证、无 API key。JWT 缓存到 `~/.moltspay`，短期免重复签。

---

## 4. 两端改动清单

### 4.1 creators 端（改动很小）

- `POST /products` 本已是 `requireAuth`(JWT)，CLI 换到的正是这种 JWT → **鉴权直接复用**。
- 需补：
  - **(a) 批量 upsert 写接口**：一个 manifest 多个 service → 多个 product，
    按 `(creator_id, service_id)` **幂等** upsert，重复 publish 不产生脏数据。
    建议新开 `POST /registry/publish`（内部复用 product upsert 逻辑），语义比复用单条 `POST /products` 清晰。
  - **(b) 钱包一致性校验**：`manifest.provider.wallet` 必须 == 登录钱包（防冒用收款地址）。
    因身份即钱包，这个校验几乎白送。
  - **(c) 首次开号 consent**：现有逻辑要 `acceptedTerms=true`，CLI 首次 publish 打印 ToS URL + 交互确认。

### 4.2 CLI 端（主要工作量）

- 新增 `moltspay publish`：validate → 钱包签名换 JWT → 调写接口。
- 新增 `moltspay unpublish <service-id>`：下架（置 `is_active=0`）。
- JWT + 上次 publish 参数缓存到 `~/.moltspay`。

### 4.3 字段映射（manifest → product）

| manifest | product 列 |
|----------|-----------|
| `provider.name` | 归属/命名空间 |
| `service.id` | 幂等键 / 标识 |
| `service.name`（**需新增**） | `name`（人类可读标题） |
| `service.description`（**需新增**） | `description` |
| `service.price` | `price_cents`（×100） |
| `service.currency` | `currency` |
| `service.tags`（**需新增**） | `tags` |
| `provider.chains` | `chains` |
| 固定 `api_service` | `delivery_type` |
| `--url` | `service_endpoint` |

---

## 5. 再想一轮：上一版漏掉、但影响成败的坑

1. **签名钱包 ≠ 收款钱包（冷钱包问题）。**
   `~/.moltspay` 是 SDK 生成的热钱包；卖家可能想把收款打到硬件钱包/交易所地址，那种私钥不在 CLI，签不了。
   - MVP：**强制 `provider.wallet == 签名钱包`**（最简单、最安全）。
   - 后续：允许 manifest 声明独立收款地址（与 web 后台"手填地址不验证"同等风险），或对收款地址做单独 permit 证明。

2. **热钱包 key = 账号，丢了就丢号。**
   creator 身份绑在这把 key 上，丢 key = 丢上架记录。
   - MVP 接受此风险并文档提示。
   - 后续：允许一个 creator 绑定多重身份（钱包 + 邮箱/OAuth）做恢复。

3. **manifest 元数据不足，会导致"上架了但搜不到"。**
   registry 搜索靠 `name/description LIKE`，而现 manifest 只有 `id/function/price/currency`。
   → 必须扩展 manifest schema，加 `service.name/description/tags`（见 §4.3）。否则市场里全是 kebab-id，检索体验差。

4. **幂等键对齐。** products 现按 `(creator_id, name)` 去重；publish 要按 `(creator_id, service_id)` 幂等。
   需在写接口里统一，避免"改了 name 就变成新产品"。

5. **生命周期 / stale 治理。** 服务下线后 registry 仍显示 = 死链接污染市场。
   - 复用**现成的 `src/services/health-check.js`**（已会 ping `endpoint/health` 并更新 status）：
     把 publish 的 `service_endpoint` 纳入健康检查，连续失败自动置 `is_active=0`。
   - CLI 提供 `unpublish` 主动下架。

6. **安全：写接口 + 自动开号 = 潜在滥用。**
   任何人可自动开号并把 `service_endpoint` 指向任意 URL。
   - 反向探活/health-check 必须**防 SSRF**：禁止内网/保留 IP、限方案 https、限跳转。
   - 写接口限速（复用现有 rateLimit 中间件）。
   - 可选：新号首次上架进 `pending`，探活通过才 `is_active=1`。

7. **价格一致性。** registry 存的 price 与实际 x402 server 从自身 manifest 强制的 price 可能漂移
   （卖家改了 manifest 没 re-publish）。
   - publish 视为唯一真源，鼓励改动即 re-publish；
   - 探活时可顺带抓 live `/services` 对账，不一致标记警告。

8. **签名仅 EVM。** `ethers.verifyMessage` 只覆盖 EVM；纯 Solana 卖家没有 EVM 身份。
   - MVP：要求一个 EVM 钱包作身份（即使实际收款走 solana_wallet）。

---

## 6. 唯一剩下的"真摩擦"：公网 URL —— 平台托管（三档设计）

账号/key 已被钱包干掉。现在卖家唯一还要操心的就是 `--url`（自托管公网地址）。
"平台托管"就是消灭这最后一点摩擦。但"托管"不是一件事，是**三档**，成本与风险差一个数量级，
应分档实现，而不是一上来就跑卖家代码。

### 现状可复用的基建
- `/a/:username` 代理路由已存在（moltspay-creators `src/routes/agent.js`）：
  `GET /a/:username/.well-known/agent-services.json`、`/services`、
  `POST /a/:username/services/:id/execute`（已处理 x402 402 流程 + 验款 + 执行 + 记账）。
- **但 execute 目标写死**：`PAYMENT_SERVER_URL` 默认硬编码 `https://juai8.com/zen7` —— 单租户占位实现。
- Railway 整容器托管已存在（`agents` 表 + `src/services/railway.js`），但那是给"整只 AI 聊天 agent"用的
  重型物（订阅/消息额度/personality/健康检查/休眠），托管"一个收费函数"是杀鸡用牛刀。

### 第一档 · 代理托管（先做，零执行风险，~1-2 天）
面向"已有自己 API、只是不想搞 x402 与收款"的卖家。平台只托管**支付壳**：付款成功后把请求
转发到卖家声明的 upstream URL，取回结果返回。**不跑任何卖家代码。**
- 落地：把 `agent.js` 写死的 `PAYMENT_SERVER_URL` 改成按 product 读 `upstream_url`；
  `service_endpoint` 自动 = `moltspay.com/a/:username/services/:id`。
- CLI：`moltspay publish <path> --proxy --upstream https://卖家的api`
- 效果：卖家从此不碰 x402、不装 moltspay server，只保留一个原始 API。覆盖面最大、我们零代码执行风险。

### 第二档 · 真·跑代码托管（zero-ops，复用 Railway）
面向"只想上传代码、连服务器都不想有"的卖家。即 SKILL-UPLOAD-DESIGN.md 的第三种交付类型。
- 落地：`moltspay publish <path> --host` → CLI 打包 skill 上传 → 服务端用现成 `railway.js` 起容器
  跑 `moltspay start <skill>` → 轮询拿到 `endpoint_url` → 自动回填 `service_endpoint`。
  复用 `agents` 表（endpoint_url/status/health）。
- 隔离靠容器/网络边界，安全。代价：每卖家一容器、有冷启动与成本 → 做成 opt-in / 付费档。

### 第三档 · 沙箱化（硬化，后续）
把"每卖家一容器"优化成共享沙箱池（Docker/Firecracker/gVisor，按执行拉临时容器），降成本。
长期形态、真基建活，等有量再投。

### ⚠️ 必须避开：不要在主机上进程隔离跑卖家代码
SKILL-UPLOAD-DESIGN.md 旧版 MVP 推荐"进程隔离"（在 moltspay-creators 主机上 `child_process`
跑卖家 `index.js`）。**反对**：那是让不受信任的任意代码与数据库、钱包私钥、其它租户同机，
等于给平台开 RCE + 横向移动口子。要跑代码，起步就得容器/网络隔离（第二档），不能主机进程隔离。

### 要改的东西（落到文件）
- `products` 表加：`hosting_mode`（'self'|'proxy'|'hosted'）、`upstream_url`、`agent_id`（hosted 指向 agents）。
- `agent.js` 的 execute：目标解析从写死改成按 `hosting_mode` 分流 ——
  self→`product.service_endpoint`；proxy→转发 `upstream_url`；hosted→provisioned 容器 `endpoint_url`。
- 上传接口：`POST /registry/skills`（multipart bundle）或在 publish 里带包。
- CLI：publish 增加 `--proxy --upstream` 与 `--host` 两种模式，URL 均由平台回填，与已完成的自托管 `--url` 并列。

### 优先级
先做**第一档（代理托管）**：复用现有 `/a` 代理、改动最小、零执行风险，却能立刻让"有 API 的卖家"
零摩擦上架，覆盖面与性价比最高。第二档（Railway 跑代码）作为 opt-in zero-ops 档随后跟上；
第三档沙箱化等有量再投。

---

## 7. 分批交付

**第一批（MVP，本计划范围）**
- creators：`POST /registry/publish` 批量幂等 upsert + 钱包一致性校验 + 限速。
- CLI：`moltspay publish`（钱包签名换 JWT）+ `moltspay unpublish`。
- manifest schema：新增 `service.name/description/tags`（向后兼容，缺省时从 id 兜底）。
- 复用 health-check 纳入 publish 端点 + SSRF 加固。

**第二批（后续）**
- 平台托管 URL（`--host`）。
- 独立收款地址 / 多重身份恢复。
- 价格对账、pending 审核态。

---

## 8. 决策点（已拍板 2026-08-20）

1. **第一批要不要带"平台托管 URL"？** → **不带。**
   自托管 + 手给 `--url`，先跑通闭环、验证需求，creators 端改动最小。
   平台托管（`--host`）归入第二批（§7）。

2. **收款地址是否允许 ≠ 签名钱包？** → **强制一致。**
   MVP 强制 `provider.wallet == 签名钱包`，最安全最简单。
   独立收款地址 / 单独 permit 证明归入第二批（§5 第 1 条）。

---

## 9. 开工第一步（拍板后）

按"MVP + 强制钱包一致 + 自托管"组合：
1. creators：写 `POST /registry/publish` 接口契约 + upsert SQL + 钱包校验中间件。
2. CLI：`publish` 命令骨架（validate → nonce → sign → verify → publish）。
3. manifest schema：加 `name/description/tags` 字段 + 更新 validate。
4. 联调：本地 skill → publish → `moltspay services` 能查到自己。
