# WeChat Pay Rail — 开发计划（场景 A）

> **配套设计**：[WECHAT-RAIL-DESIGN.md](./WECHAT-RAIL-DESIGN.md)
> **本期范围**：场景 A —— Agent 出 Native 码、付款人不限、一码一付、进同一 `mchid`，**轮询确认**
> **Target**: `moltspay@2.1.0`（提案）
> **工时**：约 1.5–2 人日

本期**只做轮询确认**。不含 `aesgcm.ts` 回调解密、notify webhook、server `/execute` 402 深度接线、`provider.wechat` 全量配置 —— 这些归 Phase 2（见设计 §8）。

---

## 1. 里程碑（M1→M4 严格串行）

### M1 — 加密 + API 基座（风险最高，先做）

| 项 | 产出 |
|---|---|
| `src/facilitators/wechat/sign.ts` | `wechatV3Sign`（SHA256-RSA 签 `METHOD\nURL\nTIMESTAMP\nNONCE\nBODY\n`）、`buildAuthorizationToken`、`wechatV3VerifyResponse`（平台公钥验签，永不抛）、`generateNonce` |
| `src/facilitators/wechat/api.ts` | `wechatV3Call(method, urlPath, body, config)`：自动加 Authorization、可选应答验签、非 2xx 抛带 code/message 的错误 |

- **依赖**：无
- **验收**：`sign.test.ts` 自签自验回环通过；`buildAuthorizationToken` 格式断言通过

### M2 — WechatFacilitator（场景 A 核心）

| 项 | 产出 |
|---|---|
| `src/facilitators/wechat.ts` | `WechatFacilitator implements Facilitator`：`createPaymentRequirements`（Native 下单→`code_url`+`out_trade_no`，元→分）、`verify`（订单查询 `trade_state===SUCCESS`）、`settle`（幂等确认）、`healthCheck`；helper `cnyToFen`、`generateOutTradeNo` |

- **依赖**：M1
- **验收**：`createPaymentRequirements`/`verify`/`settle` 用 mock `fetch` 测试通过；元→分单测（`"0.10"→10`）

### M3 — 场景驱动 + 集成接线

| 项 | 产出 |
|---|---|
| `examples/wechat-native-pay.ts` | 场景 A 可跑 demo：出码 → `qrcode-terminal` 渲染 → 3s 轮询 `verify` 直到 SUCCESS/超时 → 打印 `transaction_id` |
| `src/facilitators/registry.ts` | `registerFactory('wechat', …)` |
| `src/facilitators/index.ts` | 导出 `WechatFacilitator` + 类型 + `WECHAT_NETWORK/WECHAT_SCHEME` |
| `src/chains/index.ts` | `WECHAT_CHAIN_ID`、`isWechatChainId`、`WECHAT_RAIL{type:'fiat-rail'}` |

- **依赖**：M2
- **验收**：demo 跑通（mock/沙箱）；`registry.get('wechat')` 可用

### M4 — 收尾

| 项 | 产出 |
|---|---|
| 测试补全 | `test/facilitators/wechat/{sign,createPaymentRequirements,verify,settle}.test.ts` |
| 闸门 | `tsc --noEmit` 零错误、`vitest run` 全绿、`tsup` 构建通过 |

- **依赖**：M3
- **验收**：三道闸全过，PR 可合

---

## 2. 分支策略

当前在 `main`。沿用 Alipay（2.0.0 走 `feature/alipay`）惯例，**不在 main 直接开发**：

```bash
git checkout -b feature/wechat        # 从 main 切出
```

- 文档先单独提交：`docs: WeChat rail design + dev plan`
- 实现按里程碑分提交：`feat(wechat): v3 sign/api`、`feat(wechat): facilitator`、`feat(wechat): scenario A demo + registry wiring`…
- 完成后开 PR `feature/wechat → main`，过 review 再合并

---

## 3. 测试

**本地三道闸（与 `prepublishOnly` 一致，发布前必过）：**

```bash
npm run typecheck      # tsc --noEmit
npm run test:run       # vitest run（含 test/facilitators/wechat/*）
npm run build          # tsup
npm run verify:web     # web bundle 校验
```

**分层：**

| 层 | 内容 | 是否需真实微信 |
|---|---|---|
| 单元 | `sign`（自签自验回环）、`createPaymentRequirements`/`verify`/`settle`（mock `fetch`） | 否，CI 主力 |
| 场景 demo | `examples/wechat-native-pay.ts` | 默认 mock；接真实需填商户密钥 |
| 沙箱 e2e（可选） | 仿 `scripts/alipay-offline-e2e.mts` 加 `scripts/wechat-*.mts`，真实测试商户跑出码+轮询 | 是，密钥走 env |

**密钥纪律**：商户私钥 / `apiv3_key` 绝不入库；走 env 或本地 `cert/`（已在 `.gitignore`）。

---

## 4. 发布

新增 rail = 新功能，语义化版本走 **minor：`2.0.1 → 2.1.0`**。

```bash
# 1) 版本 & 变更记录
#    package.json: version → 2.1.0
#    CHANGELOG.md: 新增 2.1.0 段（微信 Native rail / 场景 A）
#    package.json "files": 如随包发 docs/WECHAT-RAIL.md 需显式加入

# 2) 发布（自动触发 prepublishOnly: typecheck + build + verify:web）
npm publish

# 3) 打标签并推送
git tag v2.1.0
git push origin main --tags
```

**节奏建议**：首版可**先不发 npm** —— 若仅验证场景 A，合 `main` + 打 tag 即可；待 Phase 2（notify + 证书轮换）凑齐再正式发 2.1.0，避免半成品上线。npm 凭据（PAT/OTP）沿用现有发布配置。

---

## 5. 工时

| 里程碑 | 估时 |
|---|---|
| M1 加密+API | 半天 |
| M2 facilitator | 半天 |
| M3 demo+接线 | 半天 |
| M4 收尾 | 收尾 |
| **合计** | **约 1.5–2 人日** |

无新增第三方依赖（`qrcode-terminal` / `crypto` 项目已具备）。
