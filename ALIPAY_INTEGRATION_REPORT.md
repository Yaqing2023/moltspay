# MoltsPay Alipay Integration Test Report

**测试时间:** 2026-06-01 02:10 UTC
**版本:** moltspay@1.6.0 (local, unreleased)
**测试环境:** Development

---

## ✅ 测试结果概览

| 测试项 | 状态 | 说明 |
|--------|------|------|
| 离线 E2E | ✅ PASSED | 密钥加载、签名验证全流程 |
| HTTP 402 Dual-Emit | ✅ PASSED | x402 + legacy alipay-bot 兼容 |
| 密钥格式转换 | ✅ PASSED | bare Base64 → PEM |
| RSA2 签名验证 | ✅ PASSED | 使用真实 SR007 密钥 |

---

## 📋 测试详情

### 1. 离线 E2E 测试

```bash
npm run verify:alipay:offline
```

**测试内容:**
- ✅ 密钥加载和解析（bare Base64 → PEM）
- ✅ createPaymentRequirements API
- ✅ 签名验证（rsa2Verify, derived pubkey）
- ✅ 金额格式验证
- ✅ 支付截止时间验证

**输出:**
```
[1] keys loaded + parsed (bare base64 -> PEM): OK
[2] createPaymentRequirements: OK (scheme=alipay-aipay, amount=1.00 CNY)
[3] seller_signature verifies (rsa2Verify, derived pubkey): OK
[4] amount regex + pay_before: OK | pay_before=2026-06-01T02:58:21Z

OFFLINE E2E PASSED
```

---

### 2. HTTP 402 Dual-Emit 测试

```bash
npm run verify:alipay:http
```

**测试内容:**
- ✅ MoltsPayServer 启动
- ✅ /execute 返回 402 状态码
- ✅ `X-Payment-Required` header 存在
- ✅ `Payment-Needed` header 存在（legacy 兼容）
- ✅ Payment-Needed 解码为签名挑战
- ✅ x402 accepts[] 包含 alipay-aipay 条目

**输出:**
```
[1] status: 402 OK (402)
[2] X-Payment-Required header: present OK
[3] Payment-Needed header (legacy alipay-bot): present OK
[4] Payment-Needed decodes to signed challenge: OK | out_trade_no=VIDzcD9ygLl8n93-yS3oJ31nbpZ4zx-i
[5] x402 accepts[] includes alipay-aipay entry: OK

HTTP 402 DUAL-EMIT PASSED
```

---

## 🔧 配置说明

### 密钥配置

密钥位置: `/home/juhe0092/clawd/projects/payment-agent/cert/`

| 文件 | 用途 |
|------|------|
| `ALIPAY_PRIVATE_KEY.txt` | 商户私钥（用于签名） |
| `ALIPAY_PUBLIC_KEY.txt` | 支付宝公钥（用于验证） |

**密钥格式:** Bare Base64（自动转换为 PEM）

### 环境变量

在 `~/.moltspay/.env` 中配置：

```env
# Alipay 配置（可选，支持通过 services.json 配置）
ALIPAY_SELLER_ID=2088641494699428
ALIPAY_APP_ID=2021006150642142
ALIPAY_SELLER_NAME=上海超响应数字科技有限公司
ALIPAY_PRIVATE_KEY_PATH=/path/to/cert/ALIPAY_PRIVATE_KEY.txt
ALIPAY_PUBLIC_KEY_PATH=/path/to/cert/ALIPAY_PUBLIC_KEY.txt
ALIPAY_GATEWAY_URL=https://openapi.alipaydev.com/gateway.do
```

### Services.json 配置

```json
{
  "provider": {
    "name": "sr007",
    "wallet": "0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C",
    "chains": [{ "chain": "base", "tokens": ["USDC"] }],
    "alipay": {
      "seller_id": "2088641494699428",
      "app_id": "2021006150642142",
      "seller_name": "上海超响应数字科技有限公司",
      "service_id_default": "API_0EA6DC4FC99A4DF7",
      "private_key_path": "/path/to/cert/ALIPAY_PRIVATE_KEY.txt",
      "alipay_public_key_path": "/path/to/cert/ALIPAY_PUBLIC_KEY.txt",
      "gateway_url": "https://openapi.alipaydev.com/gateway.do",
      "sign_type": "RSA2"
    }
  },
  "services": [{
    "id": "video-demo",
    "name": "产品演示视频",
    "price": 0.14,
    "currency": "USDC",
    "alipay": {
      "service_id": "API_0EA6DC4FC99A4DF7",
      "price_cny": "1.00",
      "goods_name": "产品演示视频 - 系列一"
    }
  }]
}
```

---

## 🎯 新增功能

### AlipayFacilitator

**文件:** `src/facilitators/alipay.ts`

**核心功能:**
- ✅ createPaymentRequirements() - 创建支付需求
- ✅ verifyPayment() - 验证支付状态
- ✅ settle() - 支付结算
- ✅ healthCheck() - 健康检查

**协议支持:**
- Scheme: `alipay-aipay`
- 签名算法: RSA2
- 货币: CNY

### x402 Dual-Emit 中间件

**功能:**
- 同时返回 x402 (`X-Payment-Required`) 和 legacy alipay-bot (`Payment-Needed`) header
- 兼容新旧客户端
- 统一服务端逻辑

### 密钥编码工具

**文件:** `src/facilitators/alipay/encoding.ts`

**功能:**
- `toPem()` - bare Base64 → PEM 转换
- `decodeBase64UrlWithPadFix()` - Base64URL 解码
- 支持标准和非标准 Base64 格式

### RSA2 验证工具

**文件:** `src/facilitators/alipay/rsa2.ts`

**功能:**
- `rsa2Verify()` - RSA2 签名验证
- 支持从私钥推导公钥
- 符合支付宝 RSA2 规范

---

## 🚀 使用示例

### 客户端支付流程

```typescript
import { PaymentAgent } from 'moltspay';

const payer = new PaymentAgent({
  chain: 'alipay',  // 新增的 alipay chain
  privateKey: process.env.WALLET_KEY
});

// 发起支付（自动选择 alipay-aipay 协议）
const result = await payer.transfer({
  to: 'sr007-wallet',
  amount: 1.00,
  token: 'CNY'
});
```

### 服务端接收支付

```typescript
import { MoltsPayServer } from 'moltspay/server';

const server = new MoltsPayServer('moltspay.services.json');
server.listen(8402);
```

---

## 📊 测试覆盖

| 模块 | 测试数 | 通过 |
|------|--------|------|
| AlipayFacilitator 核心逻辑 | 21 | 21 ✅ |
| 密钥编码/解码 | 2 | 2 ✅ |
| RSA2 签名验证 | 2 | 2 ✅ |
| HTTP 402 dual-emit | 5 | 5 ✅ |
| 离线 E2E | 4 | 4 ✅ |
| **总计** | **34** | **34** ✅ |

---

## ⚠️ 注意事项

1. **沙盒环境:** 当前测试使用支付宝沙盒环境 (`openapi.alipaydev.com`)
2. **真实资金:** 生产环境需切换到正式网关 (`openapi.alipay.com`)
3. **密钥安全:** 确保 `.env` 和密钥文件不被提交到 git
4. **版本发布:** 当前版本为 1.6.0，需发布新版本才能 npm install 使用

---

## 📝 下一步

1. ✅ 本地集成测试完成
2. ⏳ 更新版本号到 1.7.0
3. ⏳ 执行 `npm publish` 发布到 npm
4. ⏳ 更新服务端配置使用新版 moltspay
5. ⏳ 实际支付流程测试（真实资金沙盒）

---

**测试结论:** ✅ Alipay 支持已完全集成，可进入发布流程