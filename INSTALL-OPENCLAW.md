# MoltsPay — openclaw 安装文档

把本地打包的 `moltspay-1.7.0.tgz`（未发布到 npmjs 的测试版）安装到一台 openclaw 部署机上，并接入 openclaw skill。

---

## 0. 本机环境（已确认）

| 项 | 值 |
|---|---|
| 主机 | `ubuntu@ec2-44-220-151-119.compute-1.amazonaws.com`（pem: `~/.ssh/zen7.pem`） |
| OS / 架构 | Ubuntu 24.04.3 LTS / **aarch64 (ARM64)** |
| Node / npm | v18.19.1 / 9.2.0 |
| npm 全局 prefix | `/usr/local`（全局安装需 `sudo`） |
| openclaw | `~/.openclaw/workspace/skills/`（已有 lark-* skills，**暂无 moltspay**） |
| 安装包位置 | `~/moltspay/moltspay-1.7.0.tgz`（sha1 `02d95f2d…`） |

> ⚠️ **ARM64（linux-arm64）注意——必然踩**：Alipay 原生风控插件 AgentPayGuard（`apguard`/`blueshield`）**没有 linux-arm64 预编译件**。插件 `prebuilds/` 只随包带 4 个平台：`linux-x64`、`darwin-arm64`、`darwin-x64`、`win32-x64`——**`linux-arm64` 缺失**（本机 x64 实测确认）。本机正是 aarch64，所以 AgentPayGuard **init 必失败**（`AGENT_PAY_GUARD_INIT_FAILED` / `调用AgentPayGuard addon失败`）。失败**不影响支付成功**，但每次 alipay-bot 冷调用都走失败 init 并向 `~/.alipay-bot-cli/monitor-queue/` 写 `code:"999"` 遥测且从不上传 → 堆磁盘/inode（见 §6）。长期解法需支付宝补 linux-arm64 预编译件。

---

## 1. 安装 MoltsPay SDK（全局）

```bash
ssh -i ~/.ssh/zen7.pem ubuntu@ec2-44-220-151-119.compute-1.amazonaws.com

# 全局 prefix 是 /usr/local，需 sudo；保留 HOME 让 postinstall 落在 ubuntu 家目录
sudo -E env "PATH=$PATH" npm install -g ~/moltspay/moltspay-1.7.0.tgz
```

安装时 `postinstall` 会：

1. 打印 banner；
2. 调已声明依赖 `@alipay/agent-payment` 的 `install-cli`，从**支付宝官方 CDN** 把 `alipay-bot` CLI 下到本机。
   - 失败（离线 / CDN 不可达）**不会**让 `npm install` 失败，只打印手动命令。
   - 跳过自动安装：`MOLTSPAY_SKIP_CLI_INSTALL=1 sudo -E npm install -g ...`（CI/sandbox 用）。

> **sudo 下 alipay-bot 可能装进 root 家目录**导致 openclaw（以 ubuntu 运行）找不到。稳妥做法见 §2——装完 SDK 后，**以运行 openclaw 的同一用户**单独 provision 一次 alipay-bot。

验证 SDK：

```bash
which moltspay moltspay-mcp        # 应在 /usr/local/bin
moltspay --version                 # 期望 1.7.0
```

---

## 2. Provision alipay-bot CLI（仅启用 Alipay 支付轨时需要）

以**运行 openclaw 的用户**（ubuntu）执行，确保 CLI 装进该用户能访问的位置：

```bash
npx -y @alipay/agent-payment install-cli
```

- CLI 家目录：`~/.alipay-bot-cli/`
- bin 通常落在 `~/.local/bin/alipay-bot`（不在默认 PATH！）

把它加进 PATH（openclaw 进程必须能在 PATH 里看到 `alipay-bot`，否则报 `AlipayCliNotFoundError` / `ALIPAY_CLI_NOT_FOUND`）：

```bash
echo 'export PATH=$HOME/.local/bin:$PATH' >> ~/.bashrc
export PATH=$HOME/.local/bin:$PATH
command -v alipay-bot && alipay-bot --version    # 期望 0.3.x（当前 0.3.15）
```

> 网络要求：provision 与运行都需能访问 `*.alipay.com`。若机器有出网防火墙，放行 `*.alipay.com`（含 CDN）即可。

---

## 3. 初始化运行时状态

SDK 运行时状态在 `~/.moltspay/`（`.env`、`wallet.json`、`combined-manifest.json`、`alipay/402_*.txt` 等）。

```bash
moltspay init           # 创建钱包 / 初始化状态
moltspay status         # 查看余额 / 状态
```

按需在 `~/.moltspay/.env` 配置链上 / Alipay 商户参数（seller_id、app_id、私钥路径等，见 README / `.env.example` 与 `docs/ALIPAY-RAIL.md` 的 services.json 示例）。

---

## 4. 接入 openclaw skill

openclaw 通过 `~/.openclaw/workspace/skills/<name>/SKILL.md` 加载 skill。新建 moltspay skill：

```bash
mkdir -p ~/.openclaw/workspace/skills/moltspay
```

`~/.openclaw/workspace/skills/moltspay/SKILL.md` 最小示例：

```markdown
---
name: moltspay
description: 用 MoltsPay 处理 x402 / Alipay 支付——发现 402、付款、查询状态、交付资源。
---

# MoltsPay 支付 skill

全局 bins：`moltspay`、`moltspay-mcp`。运行时状态：`~/.moltspay/`。

## 常用命令
- 初始化：`moltspay init`
- 状态：`moltspay status`
- 付款（Alipay 轨，线上端点 `https://juai8.com/zen7`）：
  `PATH=$HOME/.local/bin:$PATH moltspay pay https://juai8.com/zen7 text-to-video --rail alipay --prompt "a happy cat" --config-dir ~/.moltspay`

## 注意
- Alipay 轨需 `alipay-bot` 在 PATH（见安装文档 §2）。
- 仅 `*.alipay.com` 出网即可完成支付。
```

> 已有的 lark-* skill 是同一套布局的参考样例，可对照其 `SKILL.md` 写法。

---

## 5. 烟测（不花真钱）

```bash
# SDK 入口可用
node -e "require('moltspay'); console.log('require ok')"
moltspay --help

# 确认线上 provider 在线（不花钱）——5 条轨含 alipay 应 healthy
curl -s https://juai8.com/zen7/health | jq .

# Alipay 离线 / HTTP 402 逻辑验证（无网络、无真实扣款）——需源码仓库，非本机必需
# 在开发机：npm run verify:alipay:offline / npm run verify:alipay:http
```

线上测试端点：`https://juai8.com/zen7`（网络 Base mainnet `eip155:8453`）。
真实 `/pay` 链路会真扣款，仅在确认配置无误后执行。

### 打开 Alipay 计时日志（排查延迟用）

`MOLTSPAY_ALIPAY_LOG` 在**模块加载时**从 `process.env` 读取，**早于** SDK 读 `~/.moltspay/.env`——所以放进 `.env` 无效，必须**随命令行内联**：

```bash
PATH=$HOME/.local/bin:$PATH MOLTSPAY_ALIPAY_LOG=debug \
  moltspay pay https://juai8.com/zen7 text-to-video --rail alipay --prompt "a happy cat" --config-dir ~/.moltspay > /tmp/pay.log 2>&1
# 输出在 stderr，前缀 [moltspay:alipay] <ts> <event> flow=… step=… <ms>ms
```

---

## 6. 维护 / 已知问题

- **AgentPayGuard 无 linux-arm64 预编译件**：插件随包只带 `linux-x64` / `darwin-arm64` / `darwin-x64` / `win32-x64`，**缺 `linux-arm64`**。本机为 aarch64 → AgentPayGuard init 必失败（非致命）。无本机解法，需支付宝补预编译件；在此之前按下条控制遥测堆积。
- **遥测堆积**：AgentPayGuard init 失败时，`~/.alipay-bot-cli/monitor-queue/` 会累积 `code:"999"` 失败遥测且**从不上传**（曾见 86k 文件 / 346MB）。可安全清理：
  ```bash
  rm -rf ~/.alipay-bot-cli/monitor-queue/*
  ```
  建议加 TTL / cron 定期清。
- **升级**：重新 `npm pack` 出新 tgz → rsync 覆盖 `~/moltspay/` → `sudo npm install -g` 重装；openclaw 进程需重启加载。
- **跳过自动装 CLI**：`MOLTSPAY_SKIP_CLI_INSTALL=1`。
- **卸载**：`sudo npm uninstall -g moltspay`（不会删 `~/.moltspay/` 状态与 `~/.alipay-bot-cli/`）。

---

## 附：从本机分发新版本到本机的命令

```bash
# 开发机打包
cd ~/clawd/projects/payment-agent && npm run build && npm pack

# 同步到目标机
rsync -avh -e "ssh -i ~/.ssh/zen7.pem" \
  moltspay-1.7.0.tgz \
  ubuntu@ec2-44-220-151-119.compute-1.amazonaws.com:~/moltspay/
```
