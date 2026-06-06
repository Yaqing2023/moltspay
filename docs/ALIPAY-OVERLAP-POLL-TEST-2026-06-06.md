# 支付宝重叠轮询（Rec #3）真实支付测试报告

**日期：** 2026-06-06
**被测改动：** `src/client/alipay/poll.ts` — 重叠/非阻塞轮询（`POLL_MAX_INFLIGHT=2` 默认开启）
**提交：** `7e8066e perf(alipay): overlapping status polls …`
**环境：** moltspay Discord bot（PID 99752，`MOLTSPAY_ALIPAY_LOG=debug`）· SDK `moltspay@1.7.0`（已 build + rsync 进 bot `node_modules/moltspay/dist`）· `alipay-bot` CLI v0.3.15
**支付：** 真实支付宝付款一笔，flow `discord-c47b0da6…`，交易号 `20260606008281111347110000048039`

---

## 1. 结论摘要（TL;DR）

1. ✅ **真实链路上重叠轮询确认生效。** 一笔真钱支付中观测到 **2 个 `402-query-payment-status` spawn 同时在飞**（按 ~3s 节奏发起，并发约 42s），不再是旧的串行「等完再发」。

2. ✅ **「首个 paid 获胜」正确。** `tick=1` 拿到 `status:"fulfilled"` → 立即 `flow.settled`；并发兄弟 `tick=2` 晚 ~1s 返回的 `unknown` 被丢弃，未影响结果。

3. ✅ **并发安全性在真实网关下成立（且理由比原注释更强）。** 兄弟 poll 重复请求 `/execute` 时，支付宝以 `40004 交易状态不允许履约` 拒绝二次履约——**履约幂等**，既不重复扣款也不重复发货。40004 被解析为 `unknown`（非 `rejected`），输家绝不会误终止轮询。

4. ✅ **端到端成功**：买家付款 → 角色/资源交付 → `402-buyer-fulfillment-ack ok=true`。

5. ⚠️ **本笔未能量化「延迟收益」**：买家付款很快，轮询第一轮（`tick=1`）即命中 `paid`，只跑了一轮。重叠的延迟收益只在买家**于较晚的轮询周期**才付款时显现（缩短相邻检测机会之间的间隔）。要量化收益需一笔「买家故意等 1–2 分钟」的慢付测试。多轮收益目前仍由单元测试 + 推理保证。

6. 🔧 **附带修正**：原代码注释称 `/execute` 是 no-op `{ok:true}`——实测它**会驱动支付宝履约确认，并非 no-op**。已据实改写安全性注释（理由改为「支付宝履约幂等，并发的第二次履约被 40004 拒绝」）。纯注释改动，逻辑不变。

---

## 2. 实测数据（flow `discord-c47b0da6…` / 交易号 `…048039`）

### 2.1 出码前（pre-QR）= 82.0s

| 步骤 | 耗时 | ok | 备注 |
|---|---|---|---|
| payment-intent | 9657ms | ✅ | |
| check-wallet | 22953ms | ✅ | **`hit=false`**（重启后进程内缓存为空，首笔必跑；已写入 `cachedForMs=600000`，10min 内下一笔跳过） |
| 402-buyer-pay | 44600ms | ✅ | 网关固有阻塞（Rec #4，Node 侧不可改） |
| **`flow.pending`** | **82011ms** | | 出码（二维码可显示） |

与 [ALIPAY-LATENCY-REPORT.md](ALIPAY-LATENCY-REPORT.md) §3 三笔历史一致：`check-wallet` ~23s、`402-buyer-pay` ~45s 为结构性成本。

### 2.2 出码后（轮询）— 重叠并发

```
03:13:30.685  flow.pending（开始轮询）
03:13:30.7±   tick=1 launch ─┐
03:13:33.7±   tick=2 launch ─┤  ← 两个 spawn 并发在飞（cadence ~3s）
03:14:15.087  tick=1 exit 44377ms ok=true  code=0 → status=paid   ✅ 获胜
03:14:15.088  flow.settled 44391ms                                → 立即结算 + 触发 onPaid（一次）
03:14:16.053  tick=2 exit 41922ms ok=false code=1 → status=unknown  ← 被丢弃的兄弟（40004）
```

| poll | 单次 spawn 时长 | exit | 解析 status | 资源响应 |
|---|---|---|---|---|
| tick=1 | 44377ms | ok=true code=0 | **paid** | `"status":"fulfilled"` |
| tick=2（并发兄弟） | 41922ms | ok=false code=1 | unknown | `"status":"delivered_unconfirmed"`, `error: alipay fulfillment 40004: 交易状态不允许履约` |

- **并发证据**：两个 spawn 的 `cli.line` 输出在 `03:14:01`～`03:14:04` 交错出现，各自携带不同的 `/execute` 响应体——证明二者**同时在飞**，而非串行。
- **结算延迟** `flow.settled = 44391ms`：约等于一个 spawn 的时长。本笔买家在第一轮轮询窗口内已付款，故第一笔返回的 poll 即检测到 `paid`（此情形下串行/重叠耗时相同，见 §1.5）。

### 2.3 收尾

| 步骤 | 耗时 | ok | 备注 |
|---|---|---|---|
| 402-buyer-fulfillment-ack | 39831ms | ✅ | fire-and-forget，不挡用户结算 |

---

## 3. 与设计预期的对照

| 设计断言（commit 7e8066e / poll.ts） | 实测 | 结论 |
|---|---|---|
| 最多 `POLL_MAX_INFLIGHT=2` 并发 spawn | 观测到 2 个并发 | ✅ |
| 第一个 `paid` 获胜并 abort 兄弟 | tick=1 paid → settled；tick=2 unknown 丢弃 | ✅ |
| 并发查询不双重扣款/发货 | 兄弟 `/execute` 被支付宝 40004 拒绝；onPaid 仅 1 次 | ✅ |
| 输家不会误终止轮询 | 40004 → `unknown`（非 rejected），不终止 | ✅ |
| 超时仅在无 in-flight 时触发 | 本笔未触发超时；逻辑由单元测试覆盖 | ✅（单元） |
| 多轮场景缩短检测延迟 ~(2×spawn+gap)→~(cadence+spawn) | 本笔仅 1 轮，未触发 | ⏳ 待慢付测试 |

---

## 4. 发现与后续

1. **`/execute` 非 no-op（已修正注释）。** 真实安全保证是「支付宝履约幂等 + 40004 拒绝二次履约」，比原注释「/execute 是 no-op」更强也更准确。已改 `poll.ts` 模块头注释。

2. **`check-wallet` 缓存按进程级，重启即失效。** 本笔 `hit=false` 因 debug 重启清空了进程内缓存。Rec #1 在「同一进程内的后续支付」省 ~23s，但每次重启首笔仍会重跑。若要跨重启复用，需带 TTL 的持久化缓存（设计里已留 `cachedForMs`）。

3. **待补：慢付测试**量化多轮重叠的延迟收益（买家故意等 1–2 分钟，触发 ≥2 轮轮询，对比检测延迟）。本轮已确认机制/并发/安全/端到端，未确认延迟数字。

4. **运维**：测试在 `MOLTSPAY_ALIPAY_LOG=debug` 下进行；验证完应 `bash restart.sh`（不带 debug）降回 info，避免 `cli.line` 刷屏。

---

## 5. 原始日志位置

`~/clawd/projects/moltspay-discordbot/bot.log`（debug 级；含本 flow 全部 `cli.line` / `poll.tick` / `flow.*`）。关键行筛选：

```
grep -E "c47b0da6|048039" bot.log | grep -E "flow\.|poll.tick|cli.exit"
```
