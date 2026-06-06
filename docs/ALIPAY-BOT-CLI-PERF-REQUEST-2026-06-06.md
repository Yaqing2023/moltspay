# alipay-bot CLI 性能需求：每进程冷启动占支付时延 ~80%

**收件人**：alipay-bot CLI 团队
**发件人**：moltspay 集成方
**日期**：2026-06-06
**CLI 版本**：alipay-bot-cli 0.3.15（`bin: ./dist/cli.js`）
**环境**：Linux x64，Node v22.22.0

## 一句话

我们用 Node 预加载钩子（hook `child_process` / `undici(fetch)` / 事件循环停顿）剖析了真实支付流，发现 **`402-buyer-pay` 出二维码前的 ~40 秒里，约 81% 是 CLI 每个进程从零重做的本地计算（设备指纹 + 原生风控初始化 + 二维码渲染），只有 ~16% 是真正的支付宝网关往返**。每条 `alipay-bot <step>` 命令都 spawn 一个全新进程、重付一遍这份冷启动，进程间没有任何缓存。**恳请提供常驻/daemon 模式（或惰性原生初始化 + 指纹复用），可为每笔支付省下 ~15-19 秒。**

## 测量方法

- 观测-only 的 `--require` 预加载钩子，内存缓冲、退出时落盘，不改变行为、不碰 stdout。
- 分三桶：A=同步子进程（`child_process.execFileSync`）、B=网络（undici/`fetch` 的 `diagnostics_channel` + `net` connect）、C=事件循环停顿减 A（=原生同步计算）。
- 在真实生产支付流上采集（非空跑）。

## 关键数据

### 1) 冷启动不可缓存（顺序 3 次 `--version`，无网络）

| 运行 | wall | 指纹(A) `general_external_id.js` | 原生(C) |
|---|---|---|---|
| run1 | 6680ms | 3361ms | 2868ms |
| run2 | 8860ms | 4404ms | 4005ms |
| run3 | 8515ms | 4672ms | 3503ms |

→ 每个新进程都重算 ~3-5s 指纹 + ~3-4s 原生初始化，**进程间零缓存**（多次连跑不下降）。`--version` 全程零网络。

### 2) `402-buyer-pay` 真实拆解（40.3s，单笔真实支付）

| 桶 | 时长 | 占比 |
|---|---|---|
| C 原生风控冷初始化（t=0.6→15s 一整块阻塞）| ~14s | 35% |
| C 原生 per-payment（交易签名 + `@resvg/resvg-js` 二维码渲染）| ~13s | 33% |
| A 设备指纹 `general_external_id.js` | ~5s | 13% |
| B 网关网络（见下，4 个请求合计）| ~6s | 16% |

时间线要点：fetch **直到 t=20.2s 才首次发起**——前 ~20 秒全是本地指纹 + 原生初始化 + spawn 几十个 `node cli.js __internal-*` worker。

### 3) 那 4 个网络请求

| # | t 起 | 目标 | 耗时 | 备注 |
|---|---|---|---|---|
| 1 | 20.2s | `aigw.alipay.com/api/gateway/invoke` | 2.2s | 核心网关 |
| 2 | 23.5s | `myip.ipip.net/` | — | **第三方 IP 定位，每笔都拉** |
| 3 | 25.8s | `aicashier.alipay.com/openclawpay/agent/v1/pay` | 2.9s | 收银台创建 |
| 4 | 34.0s | `gw.alipayobjects.com/hrn/font?...AlipayWeiXiaoTiMedium` | 1.1s | **每笔都下载字体用于渲染二维码图** |

## 具体请求（按影响排序）

1. **【最高】常驻/daemon 模式**，或一个可复用已初始化原生运行时的长连接接口（stdin 命令循环 / 本地 socket / `node-api` 可 require 的模块）。让设备指纹 + apguard/blueshield 原生初始化在进程生命周期内只做一次，而非每条命令重做。预计每笔省 **~15-19s**（冷初始化部分）。
2. **指纹/设备 token 落盘缓存**（带 TTL）：`general_external_id.js`（~5s）与原生设备认证结果若能跨进程复用，单独即可省 ~5s/spawn。
3. **静态资源缓存**：字体（`gw.alipayobjects.com/hrn/font`）建议随包内置或带 HTTP 缓存；IP 定位（`myip.ipip.net`）建议缓存/可关闭——二者每笔重复拉取。
4. **惰性初始化**：只读命令（如 `check-wallet`、`--version`）不必做完整原生风控初始化。

## 我们已自行做的缓解（仅治标）

- `check-wallet` 跨流程缓存（账户级、TTL）——暖流程跳过整步 ~20s。
- `payment-intent` 握手跳过缓存（账户级、TTL）——暖流程跳过 ~5-9s。
- 状态轮询重叠——降低支付后检测延迟。

这些只是减少 spawn 次数；**`402-buyer-pay` 这一笔不可避免的命令仍背着 ~19s 不可缓存的冷启动，只有 CLI 侧的常驻/复用能解决。**

## 附

完整剖析器与时间线在 moltspay 仓库：`scripts/cli-profile-hook.cjs`、`docs/ALIPAY-SLOWNESS-REPORT-2026-06-06.md`。可提供原始逐事件 JSON。
