# 支付宝 `/buy` 慢的根因分析与优化报告

**项目**：moltspay Discord bot 支付宝支付提速
**代码**：`~/clawd/projects/payment-agent`（分支 `feature/alipay`，包名 `moltspay`）；bot 在 `~/clawd/projects/moltspay-discordbot`
**报告日期**：2026-06-06
**bot 运行态**：PID 99752，`MOLTSPAY_ALIPAY_LOG=debug`

---

## 1. 问题

支付宝 `/buy` 从用户下单到二维码出现（"pre-QR" 窗口）耗时约 **78–84 秒**，体验很差。需要定位耗时构成并尽可能压缩。

## 2. 调查方法

- 在 SDK 中新增**结构化时序日志**（`MOLTSPAY_ALIPAY_LOG=info|debug`）：`flow.start / flow.pending / step.end / cli.exit / poll.tick`，其中 `flow.pending` = pre-QR 总耗时。
- 新增**逐行 CLI 时间线**埋点（debug 级）：`cli.firstbyte`（首字节时间）、`cli.line`、`cli.chunk`，用于把单条命令内部的黑盒时间拆成"一次长阻塞" vs "多次往返"。
- 用 bash `time` + Node `--require` 预加载钩子（hook `dns/net/tls/http/child_process/setTimeout`）拆分 **CPU / 阻塞等待 / 网络**（本机无 strace/ltrace/`/usr/bin/time`）。

## 3. pre-QR 耗时构成（两笔真实生产流，实测）

SDK 把支付宝链路实现为一串 `alipay-bot <step>` 子进程调用：
`ensure-cli(--version)` → `payment-intent` → `check-wallet` → `402-buyer-pay`，随后轮询。

| 步骤 | flow1 (ms) | flow2 (ms) | 说明 |
|---|---|---|---|
| ensure-cli (`--version`) | 5943 | 0（缓存命中） | CLI 冷启动闸门 |
| payment-intent | 9546 | 7053 | 基本是冷启动 |
| check-wallet | 25567 | 24781 | 钱包授权检查 |
| **402-buyer-pay** | **42126** | **46479** | **创建交易+取二维码（最大单项）** |
| discover-services / challenge-402 | ~80 each | ~80 each | 本地，可忽略 |
| **pre-QR 合计 (`flow.pending`)** | **83210** | **78336** | |

> 轮询 `query-payment-status`（40927/88661ms）和 `402-buyer-fulfillment-ack`（31387/34874ms）**含用户扫码支付时间**，不属于 pre-QR。

## 4. 根因

### 4.1 每次 CLI 冷启动 ~6–12s（已查实）
`alipay-bot`（`~/.local/bin/alipay-bot` → `node …/runtime/dist/cli.js`，v0.3.15）即使只跑 `--version` 也要 ~9–14s。预加载钩子剖析：
- **12s 墙钟，但只有 1.15s CPU、0 网络** → ~11s 是**阻塞等待**，不是计算也不是网关。
- 来源是**每次冷启动都跑的设备指纹/遥测子进程链**：`general_external_id.js`（~5.8s，混淆）、`ps`、macOS `system_profiler`（Linux 上快速失败），再 spawn `__internal-refresh-claw-info-cache` 和 `__internal-log-worker`。
- 即：慢在 **CLI 给机器做指纹**，不是支付宝网关、也不是 bot 代码。
- CLI 本体 `native/` 目录含 **`apguard.node` + `blueshield.node`/`libblueshield.so`**——支付宝设备安全/风控原生库；`cli.js` 字符串重度混淆，静态无法读出网关接口。

每次 pre-QR 有 4 次 spawn，各自背 ~6s 这种冷启动。

### 4.2 两个大命令由"命令内部等待"主导（已查实）
减去 ~6s 冷启动基线后：
- **check-wallet ≈ 6s 冷启动 + ~19s 命令内等待/网关**
- **402-buyer-pay ≈ 6s 冷启动 + ~40s 命令内等待/网关**

### 4.3 402-buyer-pay 的 40s 形态（已查实，但成分未拆）
2026-06-06 03:14 真实流逐行埋点：
```
step.start    402-buyer-pay         03:12:46.083
cli.firstbyte 402-buyer-pay  43115ms   ← 启动后沉默 43 秒才出首字节
cli.line      "✓ 支付待确认" + 二维码 + 交易号  （全部在 43115~43117ms 一次性输出）
cli.exit                      44600ms  ok=true
```
**形态结论**：CLI 沉默 43s 后一次性吐出全部输出 → 这是**一次长阻塞**（创建交易→取二维码），不是多次小往返。

> ⚠️ **诚实声明（重要）**：这 43s **尚未拆分成分**。它至少混了三块：(1) 冷启动+设备指纹 ~6s（已测）；(2) apguard/blueshield 风控原生库本地计算（**未测**，可能是零网络的 CPU 阻塞）；(3) 真正的支付宝网关下单往返（**未测**）。
> 之前"402-buyer-pay 是支付宝网关阻塞、Node 侧无解"的说法**是估算而非实测**。如果(2)占比大，它和冷启动一样**可预热/缓存**，"无解"就不成立。**只有(3)才是真正外部不可控的。**

### 4.4 突破：CLI 剖析器拆开了这 40s（2026-06-06 实测）

新增 `scripts/cli-profile-hook.cjs`（观测-only `--require` 预加载钩子），把每次 spawn 拆成 A) childSync 指纹链、B) network 网关在途、C) nativeStall 原生风控计算。**关键修复**：CLI 会 spawn 大量 `node cli.js __internal-*` 后台 worker，它们继承同一 `MOLTSPAY_CLI_PROFILE_OUT` 会覆盖真命令的文件 → 改为按 pid 写独立文件 + 记录 argv 识别真命令；并新增 undici `diagnostics_channel` 钩子（CLI 走 `fetch()`，绕过 `http.request`）。

**check-wallet 干净实测（手动跑，无扣款，11.8s）：**

| 桶 | 时长 | 占比 | 性质 |
|---|---|---|---|
| A. childSync 指纹（`general_external_id.js`）| 3320ms | 28% | **本地，可预热** |
| C. nativeStall 原生风控（`apguard`/`blueshield`）| 6075ms | 51% | **本地，可预热** |
| **B. 网关网络（`aigw.alipay.com/api/gateway/invoke`）** | **1874ms** | **16%** | **真外部，不可控** |

时间线：fetch **直到 t=8.6s 才开始**（前面全是指纹+原生+spawn 几十个 node worker），网关往返仅 ~1.9s。

> **推翻原结论**：至少对 check-wallet，~80% 是本地可预热，只有 ~16% 是真网关。"网关阻塞、Node 侧无解"不成立——真正的杠杆是 **Rec #2 预热/常驻 CLI**（消除指纹+原生冷算），不是网关。
>
> ⚠️ `402-buyer-pay` 的 40s 形态**强烈推测同此**（同一 CLI、同一 fetch 路径），但它创建真实交易、网关腿可能更重 —— **待下一笔真实 `/buy` 用修复后的 harness 捕获定数**（harness 已修复并在 check-wallet 上验证）。注：生产 check-wallet ~21s vs 手动 11.8s，差异在指纹/原生的机器负载波动，但"网络只占小头"的形态不变。

## 5. 已完成的优化（已上线、已 commit）

| 措施 | Rec | 状态 | 效果（实测） |
|---|---|---|---|
| ensure-cli 冷启动缓存 | — | ✅ | 进程内第二笔起省一次冷启动：5943ms → 0ms |
| **check-wallet 跨流程缓存** | #1 | ✅ 部署+双流验证 | flow2 完全跳过 check-wallet spawn；pre-QR 68109→54420ms（净 −13.7s）|
| **重叠状态轮询** | #3 | ✅ commit+实测 | 并发 2 个 poll、最快返回者获胜；支付检测延迟从 ~50–60s 收紧到 ~(节拍+1次spawn)|
| 时序日志 + 逐行 CLI 时间线埋点 | — | ✅ | 可拆解黑盒时间 |

**实现要点**
- **check-wallet 缓存**（`alipay/index.ts`）：进程级正向缓存 `walletReadyUntil`，键 `${configDir}::${framework}`，默认 TTL 10min（`MOLTSPAY_ALIPAY_WALLET_TTL_MS`），只缓存 "ready"、只对默认 runner；`resetWalletCache()` 在（解）绑时清除。
- **重叠轮询**（`alipay/poll.ts`）：固定节拍（`POLL_INTERVAL_MS`=3s）最多 `POLL_MAX_INFLIGHT`（默认 2）个并发 `402-query-payment-status`；首个见 `paid` 者获胜并 abort 其余。单次 spawn 阻塞 ~25–36s 且首字节≈总耗时（非服务端长轮询），故旧串行循环最坏晚 ~50–60s 才发现支付。
- **关键发现**：轮询里的 `/execute` **不是空操作**（它驱动支付宝履约）。重复 execute 被支付宝以 `40004 交易状态不允许履约`**幂等拒绝**；`40004` 解析为 `unknown`（非 `rejected`），loser 不会误终止，交付经 seller `onPaid` 只触发一次——安全。

**提交**：`248973a`（check-wallet 缓存 + 埋点）、`7e8066e`（重叠轮询）、`9ffa97d`（测试报告 + SAFETY 注释修正）。
**测试**：57 个 alipay 用例通过（AuditLog/PaymentAgent/chains 11 个失败为**既有**、与本次无关）。
**部署方式**：`npm run build`（tsup）→ `rsync -a --delete payment-agent/dist/ moltspay-discordbot/node_modules/moltspay/dist/` → 重启 bot。⚠️ rsync 是临时手段，bot `npm install` 会覆盖；durable 路径 = 发布/`npm pack`/workspace link。

## 6. 剩余杠杆

| Rec | 内容 | 量级 | 难度 |
|---|---|---|---|
| **#2** | 常驻/预热 CLI，消除 ~6s×N 次冷启动 | 全流程 ~24s | 结构性；v0.3.15 无 daemon 子命令，需自建常驻进程或预热指纹缓存 |
| **#4** | 402-buyer-pay 的 ~40s | 单项最大（~55%）| 先**拆成分**再判断：若为风控本地计算→可预热；若为网关网络→需支付宝侧配合 |

## 7. 待办（下一步）

1. **拆 402-buyer-pay 的 40s**（最高价值）：在下一笔**真实** `/buy` 时给该步 CLI 进程挂网络/CPU 预加载钩子，区分 socket 等待（网关）vs 零网络阻塞（风控本地计算）。⚠️ 该步会真实创建交易订单，不能空跑探针，只能搭真实支付抓。
2. **量化重叠轮询的多轮收益**：上次实测那笔买家秒付、tick=1 即结算，多轮延迟收益**尚未量化**；需一次"慢付"测试（买家等 1–2 分钟强制 ≥2 轮）。
3. 评估 Rec #2 常驻 CLI 方案可行性。

## 8. 相关文档

- `docs/ALIPAY-LATENCY-REPORT.md` — 时延实测原始数据
- `docs/ALIPAY-OVERLAP-POLL-TEST-2026-06-06.md` — 重叠轮询真实支付验证
- `docs/ALIPAY-RAIL.md` / `ALIPAY-INTEGRATION-DESIGN.md` / `ALIPAY-INTEGRATION-PLAN.md` — 链路与集成设计
