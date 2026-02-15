# Changelog

## [0.4.0] - 2026-02-16

### Added

#### x402 Protocol Support
- `createX402Client()` - Create HTTP client with automatic x402 payment handling
- `x402Fetch()` - One-shot function for paid HTTP requests
- `isX402Available()` - Check if x402 packages are installed
- Automatic 402 Payment Required response handling
- Integration with official `@x402/fetch` and `@x402/evm` packages

#### CDP (Coinbase Developer Platform) Wallet
- `initCDPWallet()` - Initialize CDP-hosted wallet
- `CDPWallet` class - Manage CDP wallet operations
- `npx moltspay init --cdp` - CLI command for CDP wallet creation
- No gas needed for wallet creation
- viem account compatibility for x402 integration

#### CLI Enhancements
- `moltspay init` now supports `--cdp` flag for CDP wallet
- `moltspay init` shows clear next steps after initialization

### Changed
- x402 packages moved to peerDependencies (optional)
- CDP SDK added as optional peerDependency
- Package exports updated to include `/x402` and `/cdp` subpaths

## [0.3.0] - 2026-02-15

### Added
- AgentWallet with auto-initialization
- Direct transfer support (wallet.transfer())
- Service payment helper (wallet.payService())

## [0.2.1] - 2026-02-15

### Changed
- Converted all content to English (templates, receipts, guides, comments)
- Status markers now use `[status:xxx]` format instead of Chinese

## [0.2.0] - 2026-02-15

### Added - Agent-to-Agent Payment Flow

Complete implementation of all features required for Agent-to-Agent conversational payment flow.

#### P0: Core Features

**createWallet()** - Create wallet for buyer Agent
```typescript
import { createWallet, loadWallet } from 'moltspay';

// Create new wallet (auto-stored to ~/.moltspay/wallet.json)
const result = createWallet();
console.log('Wallet address:', result.address);

// Encrypted storage
const result = createWallet({ password: 'secure123' });

// Load existing wallet
const wallet = loadWallet({ password: 'secure123' });
```

**PermitWallet** - Pay using Boss's Permit authorization
```typescript
import { PermitWallet } from 'moltspay';

const wallet = new PermitWallet({ chain: 'base' });

// Pay using Boss-signed Permit
const result = await wallet.transferWithPermit({
  to: '0xSELLER...',
  amount: 3.99,
  permit: {
    owner: '0xBOSS...',
    spender: wallet.address,
    value: '10000000',
    deadline: 1234567890,
    v: 27,
    r: '0x...',
    s: '0x...'
  }
});
```

#### P1: Receipt Generation

**generateReceipt()** - Generate transaction receipt
```typescript
import { generateReceipt, formatReceiptText } from 'moltspay';

const receipt = generateReceipt({
  orderId: 'vo_abc123',
  service: 'Video generation 5s 720p',
  amount: 3.99,
  chain: 'base',
  txHash: '0x...',
  payerAddress: '0xBUYER...',
  recipientAddress: '0xSELLER...',
  delivery: {
    url: 'https://...',
    fileHash: 'sha256:...'
  }
});

// Format as plain text (for Feishu/WhatsApp)
console.log(formatReceiptText(receipt));
```

#### P2: Conversation Templates

**SellerTemplates / BuyerTemplates** - Standardized dialogue templates
```typescript
import { SellerTemplates, BuyerTemplates, parseStatusMarker } from 'moltspay';

// Seller templates
SellerTemplates.askPaymentCapability();
SellerTemplates.guideInstall();
SellerTemplates.quote({ service: 'Video gen', price: 3.99, recipientAddress: '0x...' });

// Buyer templates
BuyerTemplates.requestService('video generation');
BuyerTemplates.walletCreated('0x...');
BuyerTemplates.paymentSent('0xtx...', 3.99);

// Parse status markers
const status = parseStatusMarker('[status:payment_sent tx=0xabc amount=3.99 USDC]');
// { type: 'payment_sent', data: { txHash: '0xabc', amount: '3.99' } }
```

### New Exports

```typescript
// Wallet creation
export { createWallet, loadWallet, getWalletAddress, walletExists } from 'moltspay';

// Permit wallet
export { PermitWallet, formatPermitRequest } from 'moltspay';

// Receipt
export { generateReceipt, generateReceiptFromInvoice, formatReceiptMessage, formatReceiptText, formatReceiptJson } from 'moltspay';

// Conversation templates
export { SellerTemplates, BuyerTemplates, StatusMarkers, parseStatusMarker } from 'moltspay';
```

---

## [0.1.3] - 2026-02-10

### Added
- OrderManager for order management
- Payment guide message generation

## [0.1.2] - 2026-02-08

### Added
- SecureWallet (limits/whitelist/audit)
- AuditLog for immutable audit logging

## [0.1.1] - 2026-02-06

### Added
- PaymentAgent core class
- Invoice generation
- On-chain payment verification
- Multi-chain support (Base, Polygon, Ethereum)

## [0.1.0] - 2026-02-05

### Added
- Initial release
- Basic Wallet class
- EIP-2612 Permit support
