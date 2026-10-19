# Alipay Rail（支付宝 AI 收）

> Status: Current
> Scope: MoltsPay server、Node.js SDK 与 CLI

Alipay Rail 让中国大陆商户通过支付宝 AI 收为 MoltsPay 服务收取人民币。它是法币通道，不是区块链。一个服务可以同时配置 USDC 与人民币价格，MoltsPay 不做汇率换算。

## 1. 支持范围

| 项目 | 当前行为 |
|---|---|
| Rail id / scheme | `alipay` / `alipay-aipay` |
| 币种 | CNY；配置单位为元，最多两位小数 |
| 服务端 | 原生 TypeScript，使用商户 RSA2 私钥签发挑战 |
| 客户端 | Node.js，通过 `alipay-bot` 完成钱包和付款流程 |
| 浏览器 | 不支持；`moltspay/web` 抛出 `UnsupportedChainError` |
| 商户范围 | 需要中国大陆主体、ICP 备案、营业执照及支付宝开放平台准入 |

## 2. 商户准备

准备 16 位 `seller_id`、16 位 `app_id`、商户 RSA2 私钥 PEM、支付宝平台公钥 PEM、生效的 `service_id` 和商户法定名称。

生产网关为 `https://openapi.alipay.com/gateway.do`。只有买卖双方均使用沙箱身份时才使用沙箱网关。

## 3. 服务端配置

在 `moltspay.services.json` 中启用 `alipay`，配置商户凭据，并为需要人民币收款的服务添加 `alipay`：

```json
{
  "provider": {
    "name": "Example Provider",
    "wallet": "0x1111111111111111111111111111111111111111",
    "chains": ["base", "alipay"],
    "alipay": {
      "seller_id": "2088641494699428",
      "app_id": "2021006150642142",
      "seller_name": "示例科技有限公司",
      "service_id_default": "API_0EA6DC4FC99A4DF7",
      "private_key_path": "./cert/alipay_private_key.pem",
      "alipay_public_key_path": "./cert/alipay_public_key.pem",
      "gateway_url": "https://openapi.alipay.com/gateway.do",
      "sign_type": "RSA2"
    }
  },
  "services": [{
    "id": "text-to-video",
    "name": "Text to video",
    "function": "textToVideo",
    "price": 0.99,
    "currency": "USDC",
    "input": {},
    "output": {},
    "alipay": {
      "service_id": "API_0EA6DC4FC99A4DF7",
      "price_cny": "7.00",
      "goods_name": "产品演示视频"
    }
  }]
}
```

### 配置字段

| 字段 | 必填 | 说明 |
|---|---:|---|
| `provider.alipay.seller_id` | 是 | 支付宝商户 ID，16 位数字 |
| `provider.alipay.app_id` | 是 | 支付宝应用 ID，16 位数字 |
| `provider.alipay.seller_name` | 是 | 商户法定名称 |
| `provider.alipay.service_id_default` | 是 | 默认 `service_id` |
| `provider.alipay.private_key_path` | 是 | 商户 RSA2 私钥 PEM 路径 |
| `provider.alipay.alipay_public_key_path` | 是 | 支付宝平台公钥 PEM 路径 |
| `provider.alipay.gateway_url` | 否 | 默认使用生产网关 |
| `provider.alipay.sign_type` | 否 | 当前仅支持 `RSA2` |
| `services[].alipay.price_cny` | 是 | 单位为元的字符串，匹配 `^\d+(\.\d{1,2})?$` |
| `services[].alipay.goods_name` | 是 | 支付宝展示的商品名称 |
| `services[].alipay.service_id` | 否 | 覆盖 provider 默认值 |

`"7.00"` 表示 7 元，`"100"` 合法且表示 100 元，不表示 100 分。格式校验不能判断业务价格是否填错。顶层 `price` 与 `alipay.price_cny` 相互独立。

私钥不得内联到 JSON、提交到版本库或写入日志。应限制密钥文件权限，并将密钥目录加入 `.gitignore`。

## 4. 安装与钱包激活

安装 MoltsPay 时，`postinstall` 会通过 `@alipay/agent-payment` 从支付宝官方 CDN 尝试安装 `alipay-bot`。设置 `MOLTSPAY_SKIP_CLI_INSTALL=1`、使用 `--ignore-scripts` 或处于离线环境时，可稍后手动安装：

```bash
npx -y @alipay/agent-payment install-cli
alipay-bot --version
```

当前要求 `alipay-bot >= 0.3.15`。首次付款前激活钱包：

```bash
moltspay alipay apply
moltspay alipay bind -c "<authorization-code>"
moltspay alipay check
```

## 5. 发起支付

```bash
moltspay pay https://provider.example.com text-to-video \
  --rail alipay \
  --intent "购买产品演示视频" \
  --prompt "a cat dancing"
```

Node.js SDK：

```ts
import { MoltsPayClient } from 'moltspay/client';

const client = new MoltsPayClient({ railPreference: ['alipay', 'base'] });

const result = await client.pay(
  'https://provider.example.com',
  'text-to-video',
  { prompt: 'a cat dancing' },
  {
    rail: 'alipay',
    intent: '购买产品演示视频',
    onPaymentPending: ({ paymentUrl, tradeNo }) => {
      console.log(paymentUrl, tradeNo);
    },
  },
);
```

显式选择支付宝时，服务器未提供该通道会返回 `UNSUPPORTED_RAIL`。未显式选择时，客户端可根据 `railPreference` 和本地能力选择通道。

## 6. 支付流程

1. 服务端返回 402，同时提供 `X-Payment-Required` 和 `Payment-Needed`。
2. 客户端初始化会话并检查支付宝钱包。
3. `alipay-bot` 创建订单，客户端把支付链接交给调用方。
4. 用户在支付宝中确认付款。
5. 客户端轮询交易状态；`alipay-bot` 持有 `Payment-Proof` 并重新请求资源。
6. 服务端验证证明、执行服务、确认履约并返回资源。
7. SDK 从结构化 `resourceResponse` 返回资源，不转发状态查询原始输出。
8. 客户端异步发送买家履约回执。

支付链接包含签名参数，应原样展示，不应截断、改写或重新编码。

## 7. 错误与排障

| Code | 建议处理 |
|---|---|
| `ALIPAY_CLI_NOT_FOUND` | 手动安装 `alipay-bot` |
| `ALIPAY_CLI_VERSION` | 更新并重新安装 CLI |
| `ALIPAY_NEEDS_WALLET_SETUP` | 执行 `apply`、`bind`、`check` |
| `ALIPAY_PAYMENT_REJECTED` | 重试或切换通道 |
| `ALIPAY_PAYMENT_TIMEOUT` | 查询原交易后再决定是否新建订单 |
| `ALIPAY_PROTOCOL` | 核对 CLI 版本与商户配置 |
| `UNSUPPORTED_RAIL` | 启用支付宝或选择其他通道 |

平台错误：`SERVICE_NOT_EXIST` 应核对生效的 `service_id`；`SERVICE_PRICE_MISMATCH` 应核对支付宝后台单价；履约返回 `40004` 时应查询原 `tradeNo`，不要重复交付。

## 8. 安全与运维

- `Payment-Proof` 是敏感支付凭证，不应记录或返回给无关调用方。
- 资源会经过 `alipay-bot` 的 stdout 管道，但 MoltsPay 不转发状态查询原始输出；业务代码也应避免记录完整返回体。
- 状态查询可能并发重新请求资源。服务 handler 必须以交易号或业务幂等键防止重复副作用。
- 履约确认失败不会撤销已完成的扣款，应监控失败日志并建立对账或退款流程。
- 买方钱包和卖方网关必须属于同一支付宝环境。

## 9. 性能建议

支付宝路径会启动多个 `alipay-bot` 进程。设备指纹、风控初始化、网络请求和二维码渲染可能使首次支付较慢。

- 在低负载、多核机器上运行支付客户端；
- 保持 Agent 进程常驻，以利用进程内缓存；
- 不把历史机器上的延迟数字当作 SLA，应在实际环境测量；
- 延迟异常时分别检查 CPU、CLI 版本、支付宝网关和 DNS/网络。

## 10. 相关文档

- [Alipay Integration Design](./ALIPAY-INTEGRATION-DESIGN.md)
- [MoltsPay README](../README.md)
- [支付宝官方文档](https://ideservice.alipay.com/cms/site/0j7svz.md)
