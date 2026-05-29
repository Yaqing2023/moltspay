# MoltsPay Discord Bot Plan

**Status:** Planning  
**Created:** 2026-03-29  
**Updated:** 2026-03-29 (merged with OpenAI analysis)

---

## 1. Overview

### 1.1 What We're Building

A Discord bot with **two modes**:

**Mode A: Server Monetization** (for server owners)
- Sell paid roles, premium channels, digital products
- Sell pay-per-use bot commands (AI services)
- Accept USDC payments, verify, and fulfill automatically

**Mode B: User Wallets** (for individuals)
- Create and manage crypto wallets inside Discord
- Pay for MoltsPay marketplace services
- Check balances, history, spending limits

**Mode C: Hybrid** (both)
- Server sells products
- Users can pay from bot wallet OR external wallet

### 1.2 Why Discord?

- 200M+ monthly active users
- Developer/crypto community overlap
- Slash commands = clean UX
- Server owners want monetization tools
- Easy onboarding for AI agent developers

### 1.3 Best MVP: Paid Discord Roles

Start with one narrow workflow:
1. User runs `/buy vip`
2. Bot creates MoltsPay payment
3. User pays in USDC (external wallet OR bot wallet)
4. Payment verified via webhook
5. Bot assigns VIP role

**Why this first:**
- Simple to build
- Easy to demo
- Immediately useful
- Same payment flow powers AI commands later

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Discord                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  User types: /pay zen7 text-to-video "a cat dancing"   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Discord Bot (discord.js)                     │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐       │
│  │ Slash Commands│  │ Wallet Manager│  │ Payment Flow  │       │
│  │ /wallet       │  │ Per-user state│  │ UPP client    │       │
│  │ /balance      │  │ Encrypted keys│  │ Service calls │       │
│  │ /pay          │  │ Spending limits│ │ Confirmations │       │
│  │ /services     │  │               │  │               │       │
│  │ /history      │  │               │  │               │       │
│  └───────────────┘  └───────────────┘  └───────────────┘       │
│                              │                                  │
│                    ┌─────────┴─────────┐                       │
│                    │   Storage Layer   │                       │
│                    │  (SQLite / Redis) │                       │
│                    └───────────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      MoltsPay Backend                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐            │
│  │ moltspay    │  │ UPP Protocol│  │ Marketplace │            │
│  │ npm package │  │ Multi-chain │  │ Service API │            │
│  └─────────────┘  └─────────────┘  └─────────────┘            │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Blockchain Layer                           │
│  Base │ Polygon │ BNB │ Tempo │ Solana                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Product Model (Server Monetization)

Each Discord server can configure products to sell:

```json
{
  "serverId": "123456789",
  "wallet": "0xServerOwnerWallet...",
  "products": [
    {
      "id": "vip-role",
      "name": "VIP Role",
      "type": "role",
      "price": 5.00,
      "currency": "USDC",
      "chain": "base",
      "discordRoleId": "987654321"
    },
    {
      "id": "premium-channel",
      "name": "Premium Access",
      "type": "channel",
      "price": 10.00,
      "currency": "USDC",
      "chain": "base",
      "discordRoleId": "111222333"
    },
    {
      "id": "ai-summary",
      "name": "AI Summary",
      "type": "service",
      "price": 0.05,
      "currency": "USDC",
      "chain": "base",
      "serviceEndpoint": "https://api.example.com/summarize"
    }
  ]
}
```

### 3.1 Product Types

| Type | Fulfillment | Example |
|------|-------------|---------|
| `role` | Assign Discord role | VIP, Premium, Verified |
| `channel` | Grant channel access via role | Premium-only channels |
| `service` | Execute API/AI command | Summarize, generate, analyze |
| `digital` | DM file/link/code | E-book, software key |
| `custom` | Webhook to external system | Server owner handles |

---

## 4. Slash Commands

### 4.1 `/buy` - Purchase Server Products

```
/buy <product>
  → Shows product details, price, payment options
  → User clicks [Pay with Bot Wallet] or [Pay with External Wallet]
  → Payment verified → fulfillment triggered

/buy list
  → Shows all products available in this server
```

**Flow:**
```
User: /buy vip

Bot: 🛒 **VIP Role**
     Price: $5.00 USDC
     Chain: Base
     
     Choose payment method:
     [💳 Bot Wallet ($25.50)] [🦊 External Wallet]

User: [clicks Bot Wallet]

Bot: ⏳ Processing payment...

Bot: ✅ **Purchase Complete!**
     Transaction: `0xabc...123`
     
     🎉 You now have the VIP role!
```

### 4.2 `/wallet` - Wallet Management (User)

```
/wallet create [chain]
  → Creates new wallet on specified chain (default: base)
  → Returns: address, backup instructions

/wallet import <private_key>
  → Imports existing wallet (ephemeral message, key not stored in chat)
  → Returns: address, balance

/wallet backup
  → DMs user their encrypted private key backup
  → Requires confirmation button

/wallet delete
  → Removes wallet from bot (funds not lost, just unlinked)
  → Requires confirmation
```

### 4.3 `/balance` - Check Balance

```
/balance
  → Shows USDC balance on default chain
  → Shows spending limits and today's usage

/balance all
  → Shows balances across all chains

/balance <chain>
  → Shows balance on specific chain
```

**Example response:**
```
💰 **Your Wallet**
Address: `0x1234...5678`
Chain: Base

**Balances:**
• USDC: $25.50
• ETH: 0.001 (for gas)

**Limits:**
• Per transaction: $10
• Daily limit: $100
• Spent today: $5.50
• Remaining: $94.50
```

### 4.4 `/pay` - Pay for Service

```
/pay <service> [params...]
  → Finds service, shows price, asks for confirmation
  → On confirm: executes UPP payment, returns result

/pay <provider> <service> [params...]
  → Pay specific provider's service

/pay <url> [params...]
  → Pay any UPP-compatible endpoint directly
```

**Flow:**
```
User: /pay zen7 text-to-video prompt:"a cat dancing in rain"

Bot: 🛒 **Payment Request**
     Service: Text to Video
     Provider: Zen7
     Price: $0.99 USDC
     Chain: Base
     
     [✅ Confirm] [❌ Cancel]

User: [clicks Confirm]

Bot: ⏳ Processing payment...

Bot: ✅ **Payment Complete!**
     Transaction: `0xabc...123`
     
     🎬 **Result:**
     [Video thumbnail]
     https://zen7.com/video/xyz.mp4
```

### 4.5 `/services` - Browse Marketplace

```
/services
  → Lists popular services

/services search <query>
  → Searches for services matching query

/services category <category>
  → Filters by category (video, image, data, etc.)
```

**Example response:**
```
🛒 **MoltsPay Services**

1. **Text to Video** - $0.99
   Provider: Zen7 | ⭐ 4.8 (120 reviews)
   
2. **Image to Video** - $1.49
   Provider: Zen7 | ⭐ 4.7 (85 reviews)
   
3. **Research Report** - $2.00
   Provider: DataBot | ⭐ 4.5 (42 reviews)

Use `/pay <service>` to purchase
```

### 4.6 `/history` - Transaction History

```
/history
  → Shows last 10 transactions

/history <count>
  → Shows last N transactions

/history export
  → DMs CSV export of all transactions
```

### 4.7 `/config` - Settings

```
/config limits <per_tx> <daily>
  → Set spending limits

/config chain <default_chain>
  → Set default chain for payments

/config notifications <on|off>
  → Toggle DM notifications for payments
```

### 4.8 `/fund` - Add Funds

```
/fund <amount>
  → Generates Coinbase Pay link or QR code
  → User pays with card/Apple Pay
  → Bot notifies when funds arrive

/fund address
  → Shows wallet address for direct transfer
```

### 4.9 `/faucet` - Testnet Tokens

```
/faucet
  → Requests 1 USDC from testnet faucet (Base Sepolia)
  → Rate limited: 1 per 24h per user
```

### 4.10 Admin Commands (Server Owners)

```
/setup
  → Interactive setup wizard for server owner
  → Connect wallet, create first product

/setup wallet <address>
  → Set server's receiving wallet address

/product create <name> <type> <price>
  → Create a new product
  → Example: /product create "VIP Role" role 5.00

/product list
  → List all products in this server

/product edit <id> <field> <value>
  → Edit product details

/product delete <id>
  → Remove a product

/sales
  → Show sales summary (today, week, month)

/sales history [count]
  → Show recent transactions

/sales export
  → Export CSV of all sales
```

**Admin-only:** These commands require `Administrator` or a designated manager role.

---

## 5. User Experience Flows

### 5.1 New User Onboarding

```
1. User joins server, sees bot
2. User: /wallet create
3. Bot: 
   ✅ Wallet created!
   Address: 0x1234...5678
   Chain: Base
   
   ⚠️ **Important:** This wallet is managed by this bot.
   Use `/wallet backup` to save your private key.
   
   **Next steps:**
   • `/fund 10` - Add $10 USDC
   • `/faucet` - Get free testnet tokens
   • `/services` - Browse what you can buy
   
4. User: /fund 10
5. Bot: [Shows Coinbase Pay QR code]
6. User pays with phone
7. Bot: 💰 Received $10 USDC! Ready to spend.
```

### 5.2 Paying for a Service

```
1. User: /services search video
2. Bot: [Lists video services with prices]
3. User: /pay zen7 text-to-video prompt:"sunset over mountains"
4. Bot: [Shows confirmation with price]
5. User: [Clicks Confirm button]
6. Bot: [Processing...]
7. Bot: [Shows result + video link]
```

### 5.3 Insufficient Balance

```
1. User: /pay expensive-service
2. Bot: 
   ❌ **Insufficient Balance**
   Required: $5.00
   Available: $2.50
   
   [💳 Add Funds] [❌ Cancel]
   
3. User: [Clicks Add Funds]
4. Bot: [Shows funding options]
```

---

### 5.4 Server Owner Onboarding

```
1. Server owner invites bot
2. Owner: /setup
3. Bot: 
   👋 Welcome to MoltsPay!
   Let's set up payments for your server.
   
   Step 1: Connect your wallet
   [🔗 Connect Wallet]

4. Owner connects wallet (or pastes address)
5. Bot:
   ✅ Wallet connected: 0xOwner...
   
   Step 2: Create your first product
   What do you want to sell?
   [🎭 Role] [📺 Channel Access] [🤖 AI Service] [📦 Digital Product]

6. Owner selects Role
7. Bot: Which role? [dropdown of server roles]
8. Owner selects VIP
9. Bot: Price in USDC? 
10. Owner: 5
11. Bot:
    ✅ Product created!
    
    **VIP Role** - $5.00 USDC
    
    Users can now run `/buy vip`
    
    [Create Another] [Done]
```

---

## 6. Fulfillment Modules

Make fulfillment modular so different product types trigger different actions.

### 6.1 Role Assignment

```typescript
async function fulfillRole(payment: Payment, product: Product) {
  const guild = await client.guilds.fetch(payment.serverId);
  const member = await guild.members.fetch(payment.userId);
  await member.roles.add(product.discordRoleId);
  return { success: true, message: "Role assigned" };
}
```

### 6.2 Channel Access

Same as role - assign a role that has channel permissions.

### 6.3 Digital Delivery

```typescript
async function fulfillDigital(payment: Payment, product: Product) {
  const user = await client.users.fetch(payment.userId);
  await user.send({
    content: "🎁 Here's your purchase!",
    files: [product.fileUrl]
  });
  return { success: true, message: "Delivered via DM" };
}
```

### 6.4 AI/Service Execution

```typescript
async function fulfillService(payment: Payment, product: Product, params: any) {
  const result = await fetch(product.serviceEndpoint, {
    method: 'POST',
    body: JSON.stringify(params)
  });
  return { success: true, result: await result.json() };
}
```

### 6.5 Custom Webhook

```typescript
async function fulfillCustom(payment: Payment, product: Product) {
  await fetch(product.webhookUrl, {
    method: 'POST',
    body: JSON.stringify({ payment, product })
  });
  return { success: true, message: "Webhook sent" };
}
```

---

## 7. Edge Cases & Error Handling

### 7.1 Payment Expiration

```
Problem: User doesn't complete payment in time
Solution:
- Payment sessions expire after 15 minutes
- Mark as "expired" in database
- User can run /buy again to regenerate
```

### 7.2 Duplicate Webhook Events

```
Problem: MoltsPay webhook fires twice
Solution:
- Use payment_id as idempotency key
- Check if already fulfilled before processing
- Return 200 OK even for duplicates (don't re-fulfill)
```

### 7.3 User Leaves Server

```
Problem: User pays but leaves before role assignment
Solution:
- Store purchase record permanently
- On rejoin, check for unfulfilled purchases
- Optionally restore access automatically
```

### 7.4 Wrong Payment Amount

```
Problem: User sends wrong amount
Solution:
- Reject payments that don't match expected amount
- Flag for manual review if partial payment
- Refund instructions in error message
```

### 7.5 Role Assignment Failure

```
Problem: Bot lacks permission to assign role
Solution:
- Check permissions before selling role products
- If assignment fails: mark payment as "paid_unfulfilled"
- Notify admin, queue for retry
- User keeps payment record for manual resolution
```

### 7.6 Bot Below Role

```
Problem: Bot's highest role is below the role it's trying to assign
Solution:
- Pre-check during product creation
- Warn admin if role hierarchy is wrong
- Prevent selling roles bot can't assign
```

---

## 8. Storage & Security

### 8.1 What to Store (per user)

```typescript
interface UserWallet {
  discordId: string;
  
  // Wallet (encrypted)
  encryptedPrivateKey: string;
  address: string;
  chain: string;
  
  // Settings
  defaultChain: string;
  maxPerTx: number;
  maxPerDay: number;
  notificationsEnabled: boolean;
  
  // Tracking
  spentToday: number;
  lastResetDate: string;
  createdAt: Date;
}

interface Transaction {
  id: string;
  discordId: string;
  service: string;
  provider: string;
  amount: number;
  chain: string;
  txHash: string;
  status: 'pending' | 'success' | 'failed';
  timestamp: Date;
  result?: any;
}

// Server configuration (for monetization)
interface ServerConfig {
  serverId: string;
  ownerWallet: string;
  defaultChain: string;
  products: Product[];
  createdAt: Date;
}

interface Product {
  id: string;
  serverId: string;
  name: string;
  type: 'role' | 'channel' | 'service' | 'digital' | 'custom';
  price: number;
  currency: string;
  chain: string;
  
  // Type-specific fields
  discordRoleId?: string;
  serviceEndpoint?: string;
  fileUrl?: string;
  webhookUrl?: string;
  
  active: boolean;
  createdAt: Date;
}

// Payment session (for webhook verification)
interface PaymentSession {
  paymentId: string;          // MoltsPay payment ID
  discordUserId: string;
  discordServerId: string;
  productId: string;
  
  amount: number;
  currency: string;
  chain: string;
  
  status: 'pending' | 'paid' | 'fulfilled' | 'expired' | 'failed';
  txHash?: string;
  
  createdAt: Date;
  expiresAt: Date;
  paidAt?: Date;
  fulfilledAt?: Date;
  
  // Idempotency
  webhookProcessed: boolean;
  fulfillmentAttempts: number;
}
```

### 8.2 Database Schema (SQL)

```sql
-- User wallets
CREATE TABLE wallets (
  discord_id TEXT PRIMARY KEY,
  encrypted_private_key TEXT NOT NULL,
  address TEXT NOT NULL,
  chain TEXT DEFAULT 'base',
  max_per_tx REAL DEFAULT 10,
  max_per_day REAL DEFAULT 100,
  spent_today REAL DEFAULT 0,
  last_reset_date TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Server configurations
CREATE TABLE servers (
  server_id TEXT PRIMARY KEY,
  owner_wallet TEXT NOT NULL,
  default_chain TEXT DEFAULT 'base',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Products
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT DEFAULT 'USDC',
  chain TEXT DEFAULT 'base',
  discord_role_id TEXT,
  service_endpoint TEXT,
  file_url TEXT,
  webhook_url TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (server_id) REFERENCES servers(server_id)
);

-- Payment sessions
CREATE TABLE payments (
  payment_id TEXT PRIMARY KEY,
  discord_user_id TEXT NOT NULL,
  discord_server_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  chain TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  tx_hash TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  paid_at TIMESTAMP,
  fulfilled_at TIMESTAMP,
  webhook_processed BOOLEAN DEFAULT false,
  fulfillment_attempts INTEGER DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- Indexes for common queries
CREATE INDEX idx_payments_user ON payments(discord_user_id);
CREATE INDEX idx_payments_server ON payments(discord_server_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_products_server ON products(server_id);
```

### 8.3 Storage Options

| Option | Pros | Cons |
|--------|------|------|
| **SQLite** | Simple, no server, portable | Single file, no replication |
| **PostgreSQL** | Robust, scalable | Needs hosting |
| **Redis** | Fast, good for sessions | Data can be lost |
| **MongoDB** | Flexible schema | Overkill for this |

**Recommendation:** SQLite for MVP, PostgreSQL for production.

### 8.4 Webhook Verification Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   User      │     │  MoltsPay   │     │  Your Bot   │
│  (Discord)  │     │   Server    │     │  (Backend)  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │ 1. /buy vip       │                   │
       │──────────────────────────────────────>│
       │                   │                   │
       │                   │ 2. Create payment │
       │                   │<──────────────────│
       │                   │                   │
       │ 3. Payment link   │                   │
       │<──────────────────────────────────────│
       │                   │                   │
       │ 4. User pays      │                   │
       │──────────────────>│                   │
       │                   │                   │
       │                   │ 5. Webhook: paid  │
       │                   │──────────────────>│
       │                   │                   │
       │                   │   6. Verify sig   │
       │                   │   7. Check idemp  │
       │                   │   8. Fulfill      │
       │                   │   9. Mark done    │
       │                   │                   │
       │ 10. ✅ Role assigned                  │
       │<──────────────────────────────────────│
```

**Webhook endpoint:** `POST /webhook/moltspay`

```typescript
app.post('/webhook/moltspay', async (req, res) => {
  // 1. Verify signature
  const signature = req.headers['x-moltspay-signature'];
  if (!verifySignature(req.body, signature)) {
    return res.status(401).send('Invalid signature');
  }
  
  // 2. Parse event
  const { paymentId, status, txHash } = req.body;
  
  // 3. Idempotency check
  const payment = await db.getPayment(paymentId);
  if (payment.webhookProcessed) {
    return res.status(200).send('Already processed');
  }
  
  // 4. Update payment status
  await db.updatePayment(paymentId, { status, txHash, paidAt: new Date() });
  
  // 5. Fulfill
  if (status === 'paid') {
    await fulfill(payment);
    await db.updatePayment(paymentId, { 
      fulfilledAt: new Date(), 
      webhookProcessed: true 
    });
  }
  
  // 6. Notify user in Discord
  await notifyUser(payment);
  
  return res.status(200).send('OK');
});
```

### 8.5 Private Key Security

**Same options as MCP Server:**

1. **Bot-managed encryption** (default)
   - Bot generates encryption key on first run
   - Key stored in env var
   - Encrypted private keys in database

2. **User password** (optional upgrade)
   - User provides password on wallet create
   - Password → PBKDF2 → encryption key
   - More secure but UX friction

3. **No custody** (power users)
   - Bot never stores private key
   - User signs transactions externally
   - Bot just coordinates

---

## 9. Tech Stack

```
┌─────────────────────────────────────────┐
│              Discord Bot                │
├─────────────────────────────────────────┤
│ Runtime      │ Node.js 20+             │
│ Framework    │ discord.js v14          │
│ Commands     │ Slash commands          │
│ Database     │ SQLite (better-sqlite3) │
│ Payments     │ moltspay npm package    │
│ Encryption   │ Node.js crypto (AES-256)│
└─────────────────────────────────────────┘
```

### 9.1 Key Dependencies

```json
{
  "dependencies": {
    "discord.js": "^14.14.0",
    "moltspay": "^0.8.15",
    "better-sqlite3": "^9.4.0",
    "dotenv": "^16.4.0"
  }
}
```

---

## 10. Deployment Options

### 7.1 Self-Hosted (VPS)

```bash
# Clone repo
git clone https://github.com/moltspay/discord-bot
cd discord-bot

# Configure
cp .env.example .env
# Edit .env with Discord token, encryption key, etc.

# Run
npm install
npm start

# Or with PM2
pm2 start npm --name "moltspay-bot" -- start
```

### 7.2 Railway / Render

One-click deploy button:
```
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/moltspay-discord)
```

### 7.3 Docker

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
CMD ["node", "src/index.js"]
```

---

## 11. Monetization (Optional)

### 8.1 Free Tier
- 10 transactions/month
- Testnet only
- Basic support

### 8.2 Premium ($9/mo)
- Unlimited transactions
- All chains
- Priority support
- Custom commands

### 8.3 Server License ($49/mo)
- Host for your whole Discord server
- Admin dashboard
- Analytics
- White-label option

---

## 12. Development Phases

### Phase 1: MVP (Week 1-2)
- [ ] Bot setup with discord.js
- [ ] `/wallet create`, `/balance`, `/fund`
- [ ] SQLite storage with encryption
- [ ] Basic `/pay` with confirmation flow
- [ ] Single chain (Base)

### Phase 2: Full Features (Week 3-4)
- [ ] All slash commands implemented
- [ ] Multi-chain support
- [ ] `/services` marketplace integration
- [ ] `/history` with pagination
- [ ] Button interactions for confirmations

### Phase 3: Polish (Week 5)
- [ ] Error handling & edge cases
- [ ] Rate limiting
- [ ] Testnet faucet integration
- [ ] DM backup flow
- [ ] Nice embeds & formatting

### Phase 4: Launch (Week 6)
- [ ] Documentation
- [ ] Deploy to Railway template
- [ ] Announce on Discord servers
- [ ] Submit to bot directories

---

## 13. Example Code Structure

```
moltspay-discord-bot/
├── src/
│   ├── index.ts              # Entry point, client setup
│   ├── commands/
│   │   ├── wallet.ts         # /wallet command
│   │   ├── balance.ts        # /balance command
│   │   ├── pay.ts            # /pay command
│   │   ├── services.ts       # /services command
│   │   ├── history.ts        # /history command
│   │   ├── config.ts         # /config command
│   │   ├── fund.ts           # /fund command
│   │   └── faucet.ts         # /faucet command
│   ├── services/
│   │   ├── wallet.ts         # Wallet management
│   │   ├── payment.ts        # UPP payment flow
│   │   ├── marketplace.ts    # Service discovery
│   │   └── database.ts       # SQLite operations
│   ├── utils/
│   │   ├── crypto.ts         # Encryption helpers
│   │   ├── embeds.ts         # Discord embed builders
│   │   └── validation.ts     # Input validation
│   └── types/
│       └── index.ts          # TypeScript types
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

---

## 14. Security Considerations

### 11.1 Discord-Specific

- [ ] Ephemeral messages for sensitive data (private keys, balances)
- [ ] DM-only for wallet backup
- [ ] Rate limiting per user
- [ ] No private keys in public channels ever

### 11.2 Payment Security

- [ ] Confirmation buttons with timeout (60s)
- [ ] Spending limits enforced
- [ ] Transaction receipts via DM
- [ ] Failed payment rollback

### 11.3 Bot Security

- [ ] Discord token in env vars only
- [ ] Encryption key separate from database
- [ ] No eval() or dynamic code execution
- [ ] Validate all user inputs

---

## 15. Success Metrics

| Metric | Target (3 months) |
|--------|-------------------|
| Discord servers | 50+ |
| Active users | 500+ |
| Transactions | 1,000+ |
| Payment volume | $5,000+ |

---

## 16. Future Ideas

- **Multi-wallet:** Support multiple wallets per user
- **Allowances:** Let users pre-approve spending for specific services
- **Subscriptions:** Recurring payments for services
- **Tipping:** `/tip @user $1` for peer-to-peer
- **Server treasury:** Shared wallet for Discord servers
- **Webhooks:** Notify when payments received

---

*Document version: 2.0*  
*Last updated: 2026-03-29*  
*Changes: Merged with OpenAI analysis - added server monetization, product model, fulfillment modules, edge cases, webhook flow*
