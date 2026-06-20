# 分发测试流程（未发布到 npmjs 的测试版）

在把 `moltspay` 发布到 npmjs **之前**，如何把测试版分发到其它机器并验证安装。
开发仓库里跑 `npm test` **验证不了分发行为**——postinstall 自动 provision、`files` 白名单、tarball 内容只在「打包 → 干净环境安装」时才生效，所以必须走 pack → 传输 → clean install 这条路。

适用版本：`moltspay@1.7.0`（分支 `feature/alipay`）。

---

## 总览

```
开发机                                    目标机（如 openclaw 部署）
┌──────────────────────┐                 ┌──────────────────────────┐
│ npm run build        │                 │ npm install <tgz>        │
│ npm pack  ─► .tgz    │ ── scp/rsync ─► │  └ postinstall:          │
│ (校验 tarball 内容)  │                 │     provision alipay-bot │
└──────────────────────┘                 │ 烟测 / 真实链路           │
                                         └──────────────────────────┘
```

---

## 1. 构建 + 打包

```bash
cd ~/clawd/projects/payment-agent
npm run build          # tsup；prebuild 会先 rm -rf dist
npm pack               # 产出 moltspay-<version>.tgz，遵守 package.json 的 files 白名单
```

> `npm pack` **不会**跑 `prepublishOnly`（typecheck + build + verify:web）——那只在 `npm publish` 时触发。
> 要完整模拟发布，先手动：`npm run typecheck && npm run verify:web`。

**核对 tarball 内容**（关键产物必须在）：

```bash
npm pack --dry-run 2>&1 | grep -iE "postinstall|dist/|schemas|README|LICENSE|total files"
```

期望包含：`scripts/postinstall.js`、`dist/`、`schemas/`、`.env.example`、`README.md`、`LICENSE`
（1.7.0 实测：77 个文件 / 包体 ~1.4MB / 解包 ~5.9MB）。
`scripts/postinstall.js` 必须在列——这是 `d99e760` 修复保证的，缺了就没有自动 provision。

---

## 2. 分发到目标机

打包产物等价于 `npm publish` 上传的内容，所以直接传 `.tgz` 即可：

```bash
# scp
scp -i ~/.ssh/<key>.pem moltspay-1.7.0.tgz <user>@<host>:~/moltspay/

# 或 rsync（带校验、增量）
rsync -avh -e "ssh -i ~/.ssh/<key>.pem" \
  moltspay-1.7.0.tgz <user>@<host>:~/moltspay/
```

传完**核对完整性**（两端 sha1 应一致）：

```bash
# 本机
sha1sum moltspay-1.7.0.tgz
# 目标机
ssh -i ~/.ssh/<key>.pem <user>@<host> "sha1sum ~/moltspay/moltspay-1.7.0.tgz"
```

> 已验证的一次：`ubuntu@ec2-44-220-151-119.compute-1.amazonaws.com`（pem `~/.ssh/zen7.pem`），
> 两端 sha1 = `02d95f2dc8e92cbbe73e069487e0c422ca2edc35`。
> 注意 EC2 用户名：该机是 `ubuntu`（非 `ec2-user`）；pem 权限须 `chmod 600`，否则 SSH 拒绝。

**其它分发方式**（按场景）：
- **Git 安装** `npm i git+https://…#feature/alipay`——⚠️ 当前仓库**无 `prepare` 脚本**且 `dist/` 未进 git，装上拿不到构建产物，**不可用**（除非先加 `prepare`）。另外 `origin` remote 内嵌明文 PAT，勿在命令里带。
- **私有 registry（Verdaccio）** `npx verdaccio` → `npm publish --registry http://host:4873` → 目标机 `npm i moltspay --registry …`。适合多机/CI 反复拉取、需要测 `moltspay@version` 版本解析时。一次性测试不必。
- **npm link** 只能同机本地软链，跨机不可用。

---

## 3. 在目标机安装并验证 postinstall

干净目录里装 tarball：

```bash
mkdir ~/molt-test && cd ~/molt-test && npm init -y
npm install ~/moltspay/moltspay-1.7.0.tgz
```

（全局安装见 [`../INSTALL-OPENCLAW.md`](../INSTALL-OPENCLAW.md)——npm prefix 为 `/usr/local` 时需 `sudo`。）

**postinstall 三条路径都要验**：

| 场景 | 命令 | 期望 |
|---|---|---|
| 在线正常 | `npm install <tgz>` | 打 banner → 从 `*.alipay.com` CDN 装 alipay-bot → 「安装完成」 |
| 离线 / CDN 不可达 | （断网下）`npm install <tgz>` | **不阻塞** `npm install`，仅打印手动命令 `npx -y @alipay/agent-payment install-cli` |
| 主动跳过 | `MOLTSPAY_SKIP_CLI_INSTALL=1 npm install <tgz>` | 跳过自动安装，提示手动命令（CI/sandbox 用） |

> alipay-bot（`0.3.x`）不在 npm、license `UNLICENSED`，由支付宝 CDN 分发；进 package.json 的只有安装器 `@alipay/agent-payment`（Puppeteer 下 Chromium 同款模型：安装时下载、绝不再分发）。

---

## 4. 烟测（不花真钱）

```bash
node -e "require('moltspay'); console.log('require ok')"   # 入口可用
npx moltspay --help
npx moltspay --version                                     # 期望 1.7.0
```

Alipay 轨还需 `alipay-bot` 在 PATH（通常 `~/.local/bin`，不在默认 PATH）：

```bash
export PATH=$HOME/.local/bin:$PATH
alipay-bot --version        # 期望 0.3.x
```

**支付逻辑离线验证**（开发机仓库内，无网络、无扣款）：

```bash
npm run verify:alipay:offline   # 离线 E2E：密钥/签名/验签
npm run verify:alipay:http      # HTTP 402 dual-emit
```

### 线上测试端点

线上参考 provider（实际在用，**非** README 示例域名 `moltspay.com/a/zen7`）：

```
https://juai8.com/zen7
```

不花钱先确认服务在线（应返回 `status: healthy`，`facilitators.alipay.healthy=true`）：

```bash
curl -s https://juai8.com/zen7/health | jq .   # 5 条轨 cdp/tempo/bnb/solana/alipay 均 healthy
```

打到 Alipay 轨（真实小额扣款，确认配置无误后再执行）：

```bash
PATH=$HOME/.local/bin:$PATH \
  moltspay pay https://juai8.com/zen7 text-to-video --rail alipay \
  --prompt "a happy cat" --config-dir ~/.moltspay
```

> 网络 Base mainnet（`eip155:8453`）；`/execute` 从 body 读 `service`/`prompt`，缺参返回 `400`。

真实 `/pay` 链路会真扣款，仅在配置确认无误后执行。计时日志（排查延迟）须**内联**设 `MOLTSPAY_ALIPAY_LOG=debug`（放 `~/.moltspay/.env` 无效，因为模块加载早于读 env）。

---

## 5. 架构注意 / 已知问题

- **linux-arm64（aarch64）无 AgentPayGuard 预编译件**：Alipay 原生风控插件 `apguard`/`blueshield` 随包只带 `linux-x64` / `darwin-arm64` / `darwin-x64` / `win32-x64` 四个平台，**`linux-arm64` 缺失**（x64 本机实测确认）。所以在 aarch64 目标机上 AgentPayGuard **init 必失败**（`AGENT_PAY_GUARD_INIT_FAILED`，非致命，**支付仍成功**），但每次冷调用都向 `~/.alipay-bot-cli/monitor-queue/` 写 `code:"999"` 失败遥测且从不上传（曾见 86k 文件 / 346MB）。可安全清理 `rm -rf ~/.alipay-bot-cli/monitor-queue/*`，建议加 TTL/cron。长期解法需支付宝补 linux-arm64 预编译件。
  > ⚠️ **分发测试关键**：本机 x64 装测正常 ≠ ARM 目标机正常——AgentPayGuard 这条只在 linux-arm64 上暴露，务必在真实 aarch64 机器上验。
- **sudo 全局安装**可能把 alipay-bot 装进 root 家目录，导致以普通用户运行的服务找不到 CLI。建议拆成「全局装 SDK」+「以运行用户单独 `npx -y @alipay/agent-payment install-cli`」两步。
- 出网防火墙只需放行 `*.alipay.com`（含 CDN）。

---

## 6. 升级 / 重新分发

```bash
# 开发机：改版本号后重新打包
npm run build && npm pack

# 同步覆盖目标机
rsync -avh -e "ssh -i ~/.ssh/<key>.pem" moltspay-<ver>.tgz <user>@<host>:~/moltspay/

# 目标机：重装 + 重启消费方（openclaw / bot）
npm install ~/moltspay/moltspay-<ver>.tgz
```

---

## 相关文档

- [`../INSTALL-OPENCLAW.md`](../INSTALL-OPENCLAW.md) — openclaw 部署机的完整安装步骤
- [`ALIPAY-RAIL.md`](./ALIPAY-RAIL.md) — Alipay 支付轨 / alipay-bot 依赖与许可模型
- [`../CHANGELOG.md`](../CHANGELOG.md) — 2.0.0 发布说明（配置示例与测试脚本）
