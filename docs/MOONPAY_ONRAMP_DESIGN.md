# MoonPay Onramp Integration

**Status:** Pending (waiting for MoonPay support to enable onramp)
**Created:** 2026-03-13
**Priority:** Medium

## Overview

Add MoonPay as a second fiat-to-crypto onramp option alongside existing Coinbase integration. Users can choose their preferred provider when adding funds to their agent wallet.

## Integration Approach

**QR Code Flow** (same as Coinbase):
1. Generate MoonPay URL with pre-filled wallet address and currency
2. Display as QR code
3. User scans with phone -> opens MoonPay on mobile
4. User completes purchase (KYC + payment)
5. USDC arrives in wallet

## Why QR Code?

| Option | Domain Setup | Effort | UX |
|--------|--------------|--------|-----|
| iFrame/Overlay | Required | Medium | Embedded on page |
| **QR -> Direct URL** | **Not required** | **Low** | Opens on phone |
| Redirect | Not required | Low | Leaves page |

QR code approach:
- No domain whitelisting needed
- Consistent with Coinbase flow
- User completes on phone (easier for payment methods)

## MoonPay URL Format

```
https://buy.moonpay.com?
  apiKey=pk_live_xxx
  &currencyCode=usdc_base           # USDC on Base
  &walletAddress=0x...              # User's agent wallet
  &baseCurrencyAmount=10            # Optional: pre-fill amount
  &colorCode=%234F46E5              # Optional: brand color
  &redirectURL=https://...          # Optional: return URL
```

### Supported Currencies

| Currency Code | Description |
|---------------|-------------|
| `usdc_base` | USDC on Base |
| `usdc_polygon` | USDC on Polygon |
| `usdc` | USDC on Ethereum (not recommended - high gas) |

## UI Changes

### Current Flow
```
[Add Funds] -> Coinbase QR
```

### New Flow
```
[Add Funds] -> Provider Selection
               +------ Coinbase
               +------ MoonPay
            -> Show QR for selected provider
```

### Component Changes

```
WalletFund.tsx
+------ Add provider selector (tabs or buttons)
+------ Generate MoonPay URL when selected
+------ Display QR code (reuse existing QR component)
```

## Setup Requirements

### 1. MoonPay Account
- Sign up: https://dashboard.moonpay.com
- Complete KYB (Know Your Business) verification
- Timeline: 1-2 weeks for approval

### 2. API Keys
- Publishable key (pk_live_xxx) - for URL generation
- Secret key (sk_live_xxx) - for webhook verification (optional)

### 3. Environment Variables
```bash
MOONPAY_PUBLISHABLE_KEY=pk_live_xxx
MOONPAY_SECRET_KEY=sk_live_xxx        # Optional, for webhooks
```

### 4. Request Onramp Enable
- Contact MoonPay support to enable onramp for your account
- Specify: USDC on Base + Polygon

## Webhook (Optional)

MoonPay can notify us when transactions complete:

```
POST /webhooks/moonpay

{
  "type": "transaction_completed",
  "data": {
    "walletAddress": "0x...",
    "cryptoAmount": 10.0,
    "currency": "usdc_base",
    "status": "completed"
  }
}
```

Useful for:
- Updating UI immediately
- Tracking onramp volume
- Triggering notifications

## Comparison: Coinbase vs MoonPay

| Feature | Coinbase | MoonPay |
|---------|----------|---------|
| QR code flow | [OK] | [OK] |
| Pre-fill wallet | [OK] | [OK] |
| Pre-fill amount | [OK] | [OK] |
| App deep link | [OK] Coinbase app | [NO] Browser only |
| Supported chains | Base, Polygon, ETH | Base, Polygon, ETH, + more |
| KYC in widget | [OK] | [OK] |
| Webhook | [OK] | [OK] |

## Files to Modify

| File | Changes |
|------|---------|
| `frontend/src/components/WalletFund.tsx` | Add provider selector, MoonPay URL generation |
| `frontend/src/lib/moonpay.ts` | New: URL builder helper |
| `backend/routes/webhooks.py` | Add MoonPay webhook handler (optional) |
| `.env` | Add MoonPay keys |

## Implementation Steps

1. [ ] Get MoonPay account approved (blocking)
2. [ ] Request onramp enable from MoonPay support (blocking)
3. [ ] Add environment variables
4. [ ] Create MoonPay URL builder
5. [ ] Add provider selector UI
6. [ ] Test with small amount
7. [ ] Add webhook handler (optional)

## Timeline

| Phase | Duration | Notes |
|-------|----------|-------|
| Account + KYB approval | 1-2 weeks | Blocking, in progress |
| Implementation | 2-4 hours | After approval |
| Testing | 1 hour | |

## References

- MoonPay Docs: https://docs.moonpay.com
- MoonPay Dashboard: https://dashboard.moonpay.com
- Widget Customization: https://docs.moonpay.com/moonpay/widget-configuration
