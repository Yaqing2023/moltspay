# Payment Agent Architecture Design

> **Historical document (v0.1.0).** This document reflects the project's original
> architecture from early 2026 and is preserved for reference. It describes an
> earlier scope (`@anthropic/payment-agent`) with fewer chains and no Web
> Client. For the current 1.6.x architecture, see `docs/WEB-CLIENT-DESIGN.md`,
> `docs/WHITEPAPER.md`, and the per-chain design docs.

## Part 1: System Positioning

**Payment Agent** is blockchain payment infrastructure for AI agents, published as a standalone npm package for bots (e.g. Clawdbot) to consume.

### Architecture Layers

```
+----------------------------------------------------------------------------------------------------------------------+
|                    Bot (Clawdbot)                       |
|  - Business logic (video generation, order management, …)|
|  - User interaction (WhatsApp / Feishu / Moltbook)      |
|  - Service delivery                                     |
+----------------------------------------------------------------------------------------------------------------------+
                          v calls
+----------------------------------------------------------------------------------------------------------------------+
|              Payment Agent (npm package)                |
|  - Invoice generation / parsing                         |
|  - On-chain payment verification                        |
|  - Custodial wallet transfers                           |
|  - Security controls (limits / whitelist / audit)       |
|  - EIP-2612 Permit                                      |
+----------------------------------------------------------------------------------------------------------------------+
                          v
+----------------------------------------------------------------------------------------------------------------------+
|                    Blockchain                           |
|              (Base / Polygon / Ethereum)                |
+----------------------------------------------------------------------------------------------------------------------+
```

### Responsibility Boundaries

| [OK] Payment Agent handles | [NO] Bot handles |
|----------------------|-------------|
| Invoice generation | Order creation / management |
| Payment verification | Video generation and other business logic |
| Wallet balance queries | File storage / push delivery |
| USDC transfers | User interaction |
| Limit / whitelist controls | Business flow orchestration |
| Audit log | Notification push |
| EIP-2612 Permit | Platform integration |

---

## Part 2: Module Design

### 1. PaymentAgent (core payment agent)

**File**: `src/agent/PaymentAgent.ts`

**Responsibilities**:
- Generate Invoices (payment requests)
- Verify on-chain payments
- Build wallet deep-links

**Primary methods**:

| Method | Description |
|------|------|
| createInvoice(params) | Generate a protocol-compliant payment request |
| verifyPayment(txHash, options) | Verify a transaction hash |
| scanRecentTransfers(amount, timeout) | Scan recent transfers (match by amount) |
| getBalance(address?) | Fetch a wallet balance |
| formatInvoiceMessage(invoice) | Format into a human-readable message |

### 2. Wallet (basic wallet)

**File**: `src/wallet/Wallet.ts`

**Responsibilities**:
- Query balances
- Send USDC transfers

**Primary methods**:

| Method | Description |
|------|------|
| getBalance() | Get ETH + USDC balance |
| transfer(to, amount) | Send USDC |

### 3. SecureWallet (secure wallet)

**File**: `src/wallet/SecureWallet.ts`

**Responsibilities**:
- Add security controls on top of the basic Wallet
- Per-transfer and daily limits
- Whitelist enforcement
- Audit log
- Over-limit approval queue

**Primary methods**:

| Method | Description |
|------|------|
| transfer(params) | Transfer with security checks |
| approve(requestId, approver) | Approve an over-limit transfer |
| reject(requestId, rejecter) | Reject an over-limit transfer |
| addToWhitelist(address, addedBy) | Add a whitelist entry |
| getPendingTransfers() | Get the pending approval list |

**Security control flow**:

```
Transfer request
    v
Whitelist check ----no----> Reject
    v yes
Per-transfer limit ----over----> Approval queue
    v within limit
Daily limit ----over----> Approval queue
    v within limit
Balance check ----insufficient----> Reject
    v sufficient
Execute transfer + write audit log
```

### 4. PermitPayment (EIP-2612 gasless pre-authorization)

**File**: `src/permit/Permit.ts`

**Responsibilities**:
- Allow users to authorize via signature while the service provider covers gas

**Primary methods**:

| Method | Description |
|------|------|
| createPermitRequest(owner, amount, orderId) | Build an EIP-712 signature request |
| executePermitAndTransfer(owner, amount, sig) | Execute permit + transferFrom |
| executePermit(owner, amount, sig) | Execute permit only |

**Flow**:

```
1. Provider calls createPermitRequest() to build the signature request
2. User wallet calls eth_signTypedData_v4 to sign (offline, 0 gas)
3. User returns the signature {v, r, s, deadline}
4. Provider calls executePermitAndTransfer()
5. Authorization + transfer settle on-chain
```

### 5. AuditLog (audit log)

**File**: `src/audit/AuditLog.ts`

**Responsibilities**:
- Tamper-resistant operation log
- Hash-chained entries to detect tampering
- One file per day

**Primary methods**:

| Method | Description |
|------|------|
| log(params) | Record a log entry |
| read(date?) | Read entries for a given date |
| verify(date?) | Verify log integrity |
| search(filter) | Search log entries |

**Log format**:

```json
{
  "timestamp": 1707811234.567,
  "datetime": "2026-02-13T10:00:34.567Z",
  "action": "transfer_executed",
  "request_id": "tr_abc123",
  "from": "0x...",
  "to": "0x...",
  "amount": 10.0,
  "tx_hash": "0x...",
  "prev_hash": "a1b2c3d4",
  "hash": "e5f6g7h8"
}
```

---

## Part 3: Protocol Specification

### Invoice (payment request)

```typescript
interface Invoice {
  type: 'payment_request';
  version: '1.0';
  order_id: string;
  service: string;
  amount: string;        // string to avoid precision issues
  token: 'USDC';
  chain: string;
  chain_id: number;
  recipient: string;
  expires_at: string;    // ISO8601
  deep_link?: string;    // MetaMask deep link
}
```

### Verification result

```typescript
interface VerifyResult {
  verified: boolean;
  tx_hash?: string;
  amount?: string;
  from?: string;
  to?: string;
  block_number?: number;
  confirmations?: number;
  explorer_url?: string;
  error?: string;
}
```

---

## Part 4: Supported Chains

| Chain | Chain ID | Type | USDC contract |
|---|----------|------|-----------|
| base | 8453 | Mainnet | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |
| polygon | 137 | Mainnet | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 |
| ethereum | 1 | Mainnet | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 |
| base_sepolia | 84532 | Testnet | 0x036CbD53842c5426634e7929541eC2318f3dCF7e |
| sepolia | 11155111 | Testnet | 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 |

---

## Part 5: Directory Structure

```
payment-agent/
+------ package.json
+------ tsconfig.json
+------ tsup.config.ts
+------ README.md
+------ src/
|   +------ index.ts              # Main entry point
|   +------ agent/
|   |   +------ PaymentAgent.ts   # Core payment agent
|   +------ wallet/
|   |   +------ index.ts
|   |   +------ Wallet.ts         # Basic wallet
|   |   +------ SecureWallet.ts   # Secure wallet
|   +------ permit/
|   |   +------ index.ts
|   |   +------ Permit.ts         # EIP-2612
|   +------ chains/
|   |   +------ index.ts          # Chain configuration
|   +------ audit/
|   |   +------ AuditLog.ts       # Audit log
|   +------ types/
|       +------ index.ts          # Type definitions
+------ bin/
|   +------ cli.ts                # CLI
+------ docs/
|   +------ ARCHITECTURE.md       # This document
+------ test/
```

---

## Part 6: Usage Example

### Bot integration example

```typescript
import { PaymentAgent, SecureWallet } from '@anthropic/payment-agent';

const payment = new PaymentAgent({ chain: 'base' });
const wallet = new SecureWallet({
  chain: 'base',
  limits: { singleMax: 100, dailyMax: 1000 }
});

// Bot business flow
async function handleServiceRequest(userId: string, service: string) {
  // 1. Bot creates an order (managed by the bot itself)
  const orderId = createOrder(userId, service);

  // 2. Call Payment Agent to generate an Invoice
  const invoice = payment.createInvoice({
    orderId,
    amount: 2.0,
    service,
  });

  // 3. Bot sends the Invoice to the user
  await sendToUser(userId, payment.formatInvoiceMessage(invoice));

  // 4. After the user pays, the Bot calls Payment Agent to verify
  const verified = await payment.verifyPayment(txHash);

  if (verified.success) {
    // 5. Bot performs the business action (e.g. video generation)
    await executeService(orderId);

    // 6. Bot delivers the service
    await deliverService(userId);
  }
}
```

---

## Part 7: Security Features

### Three layers of protection

```
+--------------------------------------------------------------------------------------+
|  Layer 1: Wallet choice                  |
|  (Wallet / SecureWallet / Permit)        |
+--------------------------------------------------------------------------------------+
                  v
+--------------------------------------------------------------------------------------+
|  Layer 2: Risk controls                  |
|  (limits / whitelist / approval queue)   |
+--------------------------------------------------------------------------------------+
                  v
+--------------------------------------------------------------------------------------+
|  Layer 3: Audit trail                    |
|  (hash-chained log / tamper-resistant)   |
+--------------------------------------------------------------------------------------+
```

### Default limits

| Limit | Default |
|------|--------|
| Per-transfer max | $100 |
| Daily max | $1000 |
| Whitelist | Enforced by default |

---

*Document version: v0.1.0*
*Last updated: 2026-02-14*
