# MoltsPay Alipay Integration Design

> Status: Current
> Scope: 当前支付宝支付架构、协议边界和维护约束

## 1. 目标与边界

MoltsPay 将支付宝 AI 收建模为 `alipay` 法币通道，使同一服务可以同时接受 CNY 和加密资产。支付宝通道复用 Facilitator 接口，但不被视为区块链网络。

- 服务端原生实现 challenge、RSA2 签名、Payment-Proof 验证和履约确认；
- Node.js 客户端通过官方 `alipay-bot` 管理钱包状态和用户付款；
- 浏览器客户端不支持支付宝；
- CNY 与 USDC 独立定价；
- 商户必须完成支付宝开放平台与 AI 收准入。

## 2. 组件与职责

| 组件 | 职责 |
|---|---|
| MoltsPay Server | 生成 402 challenge、验证证明、执行服务、调用履约确认 |
| `AlipayFacilitator` | 构造支付要求，调用 Open API verify 与 fulfillment.confirm |
| MoltsPay Node Client | 选择通道、驱动状态机、返回支付链接和资源 |
| `alipay-bot` | 钱包激活、订单创建、持有 Payment-Proof、带证明重新请求资源 |
| 支付宝 Open API | 验证付款并记录履约状态 |

商户私钥只属于服务端。客户端不接触商户私钥；MoltsPay SDK 也不从 `alipay-bot` 导出 Payment-Proof。

## 3. 配置模型

`provider.chains` 中的 `alipay` 启用法币通道。`provider.alipay` 保存商户和密钥配置，`services[].alipay` 保存单个服务的人民币价格和商品信息。

约束：

- 密钥通过文件路径配置，不允许内联；
- `price_cny` 是以元为单位的十进制字符串；
- 服务级 `service_id` 缺省时使用 provider 默认值；
- 未配置商户或服务级支付宝信息时，不提供支付宝 challenge；
- 加密资产价格与 CNY 价格互不推导。

字段说明见 [ALIPAY-RAIL.md](./ALIPAY-RAIL.md)。

## 4. Wire Protocol

服务器同时发送：

- `X-Payment-Required`：MoltsPay/x402 客户端使用；
- `Payment-Needed`：支付宝客户端使用，为 Base64URL 编码的 `{protocol, method}`。

两者由同一配置生成。RSA2 签名覆盖以下八个字段，并按键名字典序组成待签名字符串：

```text
amount
currency
goods_name
out_trade_no
pay_before
resource_id
seller_id
service_id
```

`amount` 是元字符串，`currency` 固定为 `CNY`，`pay_before` 是 ISO 8601 截止时间。

付款后，`alipay-bot` 携带 Base64URL 编码的 `Payment-Proof` 请求资源：

```json
{
  "protocol": {
    "payment_proof": "...",
    "trade_no": "..."
  },
  "method": {
    "client_session": "..."
  }
}
```

服务器恢复缺失的 padding，并调用支付宝验证接口。解析或验证失败时不能执行服务。

## 5. 服务端流程

```text
无证明请求
  -> 生成 challenge
  -> 402 + X-Payment-Required + Payment-Needed

携带 Payment-Proof 的请求
  -> 解析并验证证明
  -> payment.verify
  -> 执行 service handler
  -> fulfillment.confirm
  -> 返回服务响应
```

当前实现等待 `fulfillment.confirm` 结束后发送响应，但确认失败被记录为 non-fatal，不回滚已经执行的服务，也不能撤销已完成的扣款。运维必须监控并对账。

服务执行失败时不调用履约确认。法币已经扣款时，需要业务补偿或退款流程。

## 6. 客户端状态机

1. 获取服务要求并选择 `alipay`；
2. 初始化 payment intent；
3. 检查钱包；
4. 保存 `Payment-Needed` 并调用 `402-buyer-pay`；
5. 解析 `tradeNo` 和支付 URL；
6. 轮询 `402-query-payment-status`；
7. 从结构化 `resourceResponse` 提取资源；
8. 异步发送 `402-buyer-fulfillment-ack`。

携带证明重新请求资源发生在 `alipay-bot` 内部。状态查询输出可能包含服务响应，原始输出不得转发到应用日志。

## 7. 路由与兼容性

显式的 `rail: 'alipay'` 或 `--rail alipay` 优先级最高。未显式选择时，客户端结合 `railPreference`、服务器 accepts 和本地能力选择通道。

双 header 同时兼容 MoltsPay 客户端和官方支付宝客户端。CORS 必须允许 `Payment-Proof`，并在需要读取 challenge 时暴露 `Payment-Needed`。

## 8. 幂等与并发

状态轮询可以重叠执行，每次查询都可能携带同一 Payment-Proof 重新请求资源。支付宝拒绝重复的 `fulfillment.confirm`，但这不保证 service handler 只执行一次。

服务端和 handler 必须用稳定幂等键保护副作用，推荐至少包含：

```text
rail + trade_no + service_id
```

必须保证：

- 并发请求只执行一次不可逆副作用；
- 重复请求返回第一次结果或处理中状态；
- loser poll 不覆盖成功结果；
- 首个 paid 结果后取消 sibling；
- 超时不把在途成功误判为拒绝。

尚无可靠幂等保护时，应将支付宝轮询最大并发设为 1。

## 9. 失败与重试

| 阶段 | 失败处理 |
|---|---|
| Challenge | 返回服务器错误 |
| 钱包/订单创建 | 返回稳定的 `ALIPAY_*` 错误码 |
| 证明解析或验证 | 不执行服务 |
| 服务执行 | 不履约确认；进入补偿或退款流程 |
| `fulfillment.confirm` | 记录并告警；按 `trade_no` 对账 |
| 买家 ack | best-effort，不阻塞 SDK 返回 |
| 查询超时 | 终止等待；重试前查询原交易 |

Payment-Proof、交易号和 session 是敏感数据。日志可以记录脱敏标识和耗时，但不得记录证明或完整资源。

## 10. 性能模型

主要延迟来自多次 `alipay-bot` 启动、设备与风控初始化、支付宝网络请求和二维码生成。进程内缓存可以减少部分步骤，但不能消除必要的 CLI 启动。

应分别测量支付链接可用时间、付款检测延迟、服务执行和履约确认。历史单机数据不能作为 SLA；基准测试应记录 CLI 版本、CPU、系统负载和网络环境，并报告中位数与尾延迟。

## 11. 安全要求

- 启动时校验商户私钥和支付宝平台公钥；
- 私钥使用最小权限，不进入配置、日志或构建产物；
- Payment-Proof 不暴露给日志或无关调用方；
- 支付 URL 原样传递；
- 子进程环境变量使用 allowlist；
- service handler 支持支付级幂等；
- 失败和超时可观测、可对账；
- 生产与沙箱身份、钱包和网关不得混用。

## 12. 必需测试

- RSA2 签名、验签和字段排序；
- Base64URL 编解码及 padding 恢复；
- 双 header 与无支付宝配置时的兼容行为；
- 证明验证失败时不执行 handler；
- 有效证明执行服务并调用履约确认；
- POST 方法和请求体在状态查询中保持一致；
- 状态解析不把 `success: false` 判为成功；
- 资源内容不进入日志回调；
- 同一 `trade_no` 的并发请求只产生一次业务副作用；
- 超时、取消和 sibling 清理；
- 浏览器构建明确拒绝 `alipay`。
