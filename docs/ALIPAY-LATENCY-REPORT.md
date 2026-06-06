# 支付宝 `/buy` 延迟调查报告

**日期：** 2026-06-05
**范围：** moltspay Discord bot 支付宝 `/buy` 出二维码慢（pre-QR ~74–84s）
**代码：** SDK `payment-agent`（`moltspay`，分支 `feature/alipay`）· Bot `moltspay-discordbot`
**底层：** `alipay-bot` CLI v0.3.15（`~/.local/share/alipay-bot-cli/runtime/dist/cli.js`）

---

## 1. 结论摘要（TL;DR）

1. **支付宝链路 = 一串 `alipay-bot <子命令>` 子进程 spawn。** 一笔完整支付有 **8 次 spawn**：`ensure-cli` → `payment-intent` → `check-wallet` → `402-buyer-pay`（到此出码）→ `query-payment-status` ×N（轮询）→ `402-buyer-fulfillment-ack`。

2. **每个命令都是「一次性长阻塞」，不是多次网关往返。** 逐行计时探针证明：每个 spawn 的**首字节时间 ≈ 总时长**，CLI 全程零输出，最后一瞬间把全部结果一次性吐出后退出（排空仅 0.5–1.2s）。`402-buyer-pay` 的全部输出在 **41578ms 处一次性出现**，中间没有任何进度行。

3. **出码前 74s 的构成：`402-buyer-pay` 58% + `check-wallet` 31%。** 其余（payment-intent、ensure-cli、本地步骤）合计约 11%。

4. **`402-buyer-pay` 的 ~42s 是 CLI/网关内部固有阻塞**（建单 + 生成二维码），Node 侧无法再细分、也改不动；其中只有 ~6s 是冷启动，可随常驻进程消除。

5. **`check-wallet` 的 ~23s 是纯开销**——钱包授权状态在两笔之间不变，已确认开通就不必每笔重跑。**跨流缓存即省 ~23s，是当前最高 ROI 的改动。**

6. **轮询节奏被 CLI 自身拖垮：** `query-payment-status` 每次 spawn 自身就阻塞 25–36s。名义间隔 3s 形同虚设，**用户付完款后最长 ~36s 才被检测到**，拉长了 settle 体感。

---

## 2. 测量方法（探针）

在 `src/client/alipay/log.ts` 的结构化日志设施基础上，于 `src/client/alipay/cli.ts` 的 `runCli` 增加 **debug 级逐行/逐块计时**，全部基于真实流的被动观察，**不改动真实扣款的 `402-buyer-pay` 调用本身**：

| 事件 | 含义 |
|---|---|
| `cli.firstbyte` | 该 spawn 首字节到达时间（≈ 冷启动 + 第一次网关往返） |
| `cli.line` | 每行 stdout/stderr 的偏移 ms + 120 字预览 |
| `cli.chunk` | 原始 chunk 到达（含 `\r` 进度条/缓冲输出，逐行切分会漏掉的） |
| `flow.pending` | 出码前总时长（`flow.start` → 二维码可显示） |
| `flow.settled` | 出码到付款确认的时长（含用户扫码） |

启用：`MOLTSPAY_ALIPAY_LOG=debug bash restart.sh`。已有的 `ensure-cli` 缓存（per-process memo `--version` 门控）也在生效中。

环境限制：本机无 `strace`/`ltrace`/`/usr/bin/time`，CLI 内部进一步拆分需 CLI 自身埋点或抓网络。

---

## 3. 实测数据（一笔真实支付，flow `discord-ecf318d0…`，2026-06-05 14:53–14:57）

### 3.1 出码前（pre-QR）逐步

| 步骤 | 首字节 | 退出 | 沉默时长 | 排空 | 占 pre-QR |
|---|---|---|---|---|---|
| discover-services（本地） | — | 28ms | — | — | <0.1% |
| challenge-402（本地） | — | 31ms | — | — | <0.1% |
| ensure-cli | — | 2588ms | (冷启动) | — | 3.5% |
| payment-intent | 5298ms | 5799ms | 5.3s | 0.5s | 8% |
| **check-wallet** | **21953ms** | **22837ms** | **22s** | 0.9s | **31%** |
| **402-buyer-pay** | **41578ms** | **42807ms** | **41.6s** | 1.2s | **58%** |
| **出码前合计 `flow.pending`** | | **74066ms** | | | 100% |

```
402-buyer-pay   42.8s  ████████████████████████  58%
check-wallet    22.8s  █████████████             31%
payment-intent   5.8s  ███                        8%
ensure-cli       2.6s  █                          3.5%
本地步骤         0.06s                            <0.1%
```

### 3.2 出码后（轮询 + 收尾）

| 步骤 | 单次 spawn 时长 | 备注 |
|---|---|---|
| query-payment-status tick1 | 28.8s | status=pending |
| query-payment-status tick2 | 25.7s | status=pending |
| query-payment-status tick3 | 25.0s | status=pending |
| query-payment-status tick4 | 36.5s | **status=paid** ✓ |
| `flow.settled` | **125035ms** | 含用户扫码 + 付款 + 检测延迟 |
| 402-buyer-fulfillment-ack | 28.6s | fire-and-forget，不挡用户 |

**轮询发现：** 每次 `query-payment-status` 自身阻塞 25–36s（首字节≈总时长，同样是一次性长阻塞）。名义 3s 间隔失效，付款检测粒度实际为 ~25–36s。

### 3.3 与历史两笔的对比（出码前总时长）

| 笔 | ensure-cli | payment-intent | check-wallet | 402-buyer-pay | pre-QR |
|---|---|---|---|---|---|
| 历史 flow1 | 5943ms (冷) | 9546ms | 25567ms | 42126ms | 83210ms |
| 历史 flow2 | 0ms (缓存命中) | 7053ms | 24781ms | 46479ms | 78336ms |
| 本次 | 2588ms | 5799ms | 22837ms | 42807ms | 74066ms |

`check-wallet`（~23–26s）与 `402-buyer-pay`（~42–46s）三笔高度稳定，是结构性成本；`ensure-cli` 缓存命中只省一次冷启动，对 pre-QR 总量影响有限。

---

## 4. 分析

- **"那 40s"已定性：** `402-buyer-pay` 是 CLI 内部一段单一的、零输出的阻塞（建单 + 网关生成二维码），不是多次往返。逐行探针的价值正在于**排除了"多次网关往返"假设**。≈ 6s 冷启动 + ~35s 网关固有阻塞，后者在 CLI/网关内部。

- **冷启动 vs 网关：** 用 `ensure-cli`/`--version`（纯冷启动、零网络）作基线（本机 ~2.5–6s），小命令（payment-intent）几乎全是冷启动；两个大命令（check-wallet、402-buyer-pay）的主体是命令内部的网关/等待，**不是冷启动**。这修正了早期"瓶颈全是指纹冷启动"的判断。

- **冷启动来源（早期 profiling）：** CLI 每次冷调用跑设备指纹/遥测子进程链（`general_external_id.js` ~5.8s + `ps` + macOS `system_profiler`（Linux 上快速失败）+ `__internal-refresh-claw-info-cache` / `__internal-log-worker`），零网络、~1.15s CPU，其余为阻塞等待。0.3.15 无 `serve`/`daemon` 子命令。

- **每笔 8 次 spawn**，每次各背一份冷启动；常驻进程可一次性消除全部冷启动开销。

---

## 5. 建议（ROI 从高到低）

| # | 改动 | 预期收益 | 风险/成本 |
|---|---|---|---|
| **1** | **`check-wallet` 跨流缓存/跳过**（进程级或带 TTL 持久化；已知开通即跳过） | **每笔省 ~23s（pre-QR 的 31%）** | 低；纯开销、可控、改动小 |
| 2 | **常驻/预热 CLI 进程**，消除每次 spawn 的 ~2.5–6s 冷启动（本笔 8 次） | pre-QR 省 ~10–15s，整体更多 | 中；CLI 无 daemon 子命令，需自建常驻 host 或预热 claw-info 缓存 |
| 3 | **缩短/非阻塞轮询**，降低单次 query 的 25–36s 阻塞 | 付款检测延迟从 ~36s 降下来，改善 settle 体感 | 中；取决于 CLI 是否有更轻的查询路径 |
| 4 | `402-buyer-pay` 的 ~35s 网关固有阻塞 | — | 高/不可控；除非 alipay-bot 提供更快建单路径 |

**下一步：先实现 #1。** 这是确定能砍 ~23s、风险最低的一刀。

---

## 6. 复现与运维

- **启用计时：** `MOLTSPAY_ALIPAY_LOG=debug bash restart.sh`（debug 会刷 `cli.line`；验证完降回 `info`）。
- **构建+部署：** `cd payment-agent && npm run build`，然后 `rsync -a --delete payment-agent/dist/ moltspay-discordbot/node_modules/moltspay/dist/`（⚠️ 临时；bot `npm install` 会覆盖，持久化需 publish / workspace link）。bot 需重启加载。
- **延迟探针脚本：** `scripts/probe-alipay-cli.sh [runs]`（只测 `--version`/`--help`/`check-wallet`/`payment-intent`，**绝不**跑 `402-buyer-pay` = 真实扣款）。
- **测试：** 204 个测试通过（含 `cli.test.ts`）。
- **陷阱：** 勿 inline `pkill -f "…dist…"`，会自杀当前 shell；用 `restart.sh`（内部 `fuser -k 3402/tcp`）。
