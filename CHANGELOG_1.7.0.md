# MoltsPay v1.7.0 Release Notes

**Released:** 2026-06-01

---

## 🎉 Major Feature: Alipay Support

### New Facilitator: Alipay (Fiat Rail)

**For the first time, MoltsPay now supports fiat payments via Alipay!**

#### Key Features

- **AlipayFacilitator Implementation**
  - Full Alipay integration with RSA2 signature verification
  - Support for Chinese Yuan (CNY) payments
  - Seamless x402 protocol compliance
  - Health check and settlement APIs

- **Dual-Emit HTTP 402 Middleware**
  - Emits both x402 (`X-Payment-Required`) and legacy alipay-bot (`Payment-Needed`) headers
  - Ensures backward compatibility with existing clients
  - Unified service-side logic for all payment rails

- **Key Encoding Tools**
  - `toPem()` - Converts bare Base64 keys to PEM format
  - `decodeBase64UrlWithPadFix()` - Base64URL decoding with padding fixes
  - Supports standard and non-standard Base64 formats

- **RSA2 Verification**
  - `rsa2Verify()` - RSA2 signature verification per Alipay specs
  - Supports public key derivation from private keys
  - Cryptographically valid end-to-end flow

#### New Chain

- **`alipay`** - Alipay fiat payment rail
  - Scheme: `alipay-aipay`
  - Currency: CNY
  - Sign type: RSA2

#### Configuration

**Services JSON:**
```json
{
  "provider": {
    "name": "your-service",
    "wallet": "0x...",
    "chains": ["base"],
    "alipay": {
      "seller_id": "2088641494699428",
      "app_id": "2021006150642142",
      "seller_name": "Your Company Name",
      "service_id_default": "API_XXXXX",
      "private_key_path": "/path/to/ALIPAY_PRIVATE_KEY.txt",
      "alipay_public_key_path": "/path/to/ALIPAY_PUBLIC_KEY.txt",
      "gateway_url": "https://openapi.alipay.com/gateway.do",
      "sign_type": "RSA2"
    }
  },
  "services": [{
    "id": "your-service",
    "name": "Your Service",
    "price": 0.99,
    "currency": "USDC",
    "alipay": {
      "service_id": "API_XXXXX",
      "price_cny": "7.00",
      "goods_name": "Your Service Name"
    }
  }]
}
```

#### Environment Variables

```env
# Alipay Configuration (optional, can be set in services.json)
ALIPAY_SELLER_ID=your_seller_id
ALIPAY_APP_ID=your_app_id
ALIPAY_SELLER_NAME=Your Company Name
ALIPAY_PRIVATE_KEY_PATH=/path/to/ALIPAY_PRIVATE_KEY.txt
ALIPAY_PUBLIC_KEY_PATH=/path/to/ALIPAY_PUBLIC_KEY.txt
ALIPAY_GATEWAY_URL=https://openapi.alipay.com/gateway.do
```

#### Testing

All tests passing:

```bash
# Offline E2E test (no network, no real money)
npm run verify:alipay:offline

# HTTP 402 dual-emit test
npm run verify:alipay:http
```

**Test Results:**
- ✅ 34 test cases passed
- ✅ Offline E2E: Key loading, signing, verification
- ✅ HTTP 402: Dual-emit, challenge decoding
- ✅ RSA2 verification with real SR007 keys

---

## 🔧 Improvements

### Payment-Proof Header Consumption

**Fixed:** Server now correctly consumes and validates `Payment-Proof` header on `/execute` endpoint.

### UNPAID Status Parsing

**Fixed:** Improved payment status parsing for Alipay transactions, correctly handling `UNPAID` state.

---

## 📚 Documentation

- Added Alipay integration guide
- Updated `README.md` with fiat payment examples
- Added key encoding utilities documentation

---

## 🧪 Testing

- **New test scripts:**
  - `scripts/alipay-offline-e2e.mts` - Offline E2E test
  - `scripts/alipay-http-402.mts` - HTTP 402 dual-emit test
  - `scripts/alipay-live-server.mts` - Live server integration test

- **Test coverage:** 34 new test cases for Alipay functionality

---

## 📦 Breaking Changes

None. This is a feature release with full backward compatibility.

---

## 🚀 Migration Guide

If you're upgrading from v1.6.0:

1. **No code changes required** - fully backward compatible
2. **Optional:** Add Alipay configuration to your `services.json` to enable fiat payments
3. **Optional:** Update your client to support `alipay-aipay` scheme

---

## 🙏 Acknowledgments

- Alipay SDK reference implementation
- SR007 team for testing with real merchant credentials

---

## 📋 Full Changelog

### Added
- AlipayFacilitator with RSA2 signature support
- Dual-emit HTTP 402 middleware for x402 + legacy compatibility
- Key encoding utilities (`toPem`, `decodeBase64UrlWithPadFix`)
- RSA2 verification (`rsa2Verify`)
- `alipay` chain definition with `alipay-aipay` scheme
- Payment-Proof header consumption on `/execute`
- UNPAID status parsing for Alipay
- Alipay integration test scripts

### Fixed
- Payment-Proof header not being consumed correctly
- UNPAID status parsing issues

### Changed
- Updated documentation with Alipay examples
- Improved error messages for Alipay-specific failures

---

## 📖 See Also

- [Full Test Report](./ALIPAY_INTEGRATION_REPORT.md)
- [GitHub Repository](https://github.com/Yaqing2023/moltspay)
- [Documentation](https://docs.moltspay.com)

---

**Next Steps:**
1. Review test results
2. Build and test locally: `npm run build && npm test`
3. Publish to npm: `npm publish`
4. Update service deployments to use v1.7.0