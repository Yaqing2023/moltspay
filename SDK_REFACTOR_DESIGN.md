# MoltsPay SDK v1.0 Refactor Design

## 1. Executive Summary

**Goal:** Simplify the MoltsPay SDK to make x402 adoption trivial for any AI agent or service provider.

**Current Pain Points:**
1. Too many concepts to understand (Client/Server/Facilitators/Skills)
2. Configuration-heavy setup
3. Skill registration is confusing for simple use cases
4. Multi-chain complexity exposed to users
5. CLI sprawl with many subcommands

**Design Principles:**
- Zero-config where possible
- Convention over configuration
- One import, one function call
- Progressive disclosure (simple → advanced)

---

## 2. Target User Experience

### 2.1 Client (Paying for Services)

**Current (Complex):**
```typescript
import { MoltsPayClient } from 'moltspay';

const client = new MoltsPayClient();
// First: npx moltspay init
// Then: npx moltspay fund
// Configure limits...
const result = await client.pay('https://api.example.com', 'text-to-video', 
  { prompt: 'a cat' }, 
  { chain: 'base', token: 'USDC' }
);
```

**Target (Simple):**
```typescript
import { pay } from 'moltspay';

// Auto-init wallet if needed, auto-select chain/token based on service
const result = await pay('https://api.example.com/text-to-video', {
  prompt: 'a cat'
});
```

### 2.2 Server (Selling Services)

**Current (Complex):**
```typescript
import { MoltsPayServer } from 'moltspay';

const server = new MoltsPayServer('./moltspay.services.json');
server.skill('text-to-video', async (params) => {
  // implementation
});
server.listen(3000);
```

**Target (Simple):**
```typescript
import { serve } from 'moltspay';

// Define service inline
serve({
  'text-to-video': {
    price: 0.99,
    handler: async ({ prompt }) => {
      return { video_url: '...' };
    }
  }
});

// Or even simpler - decorator style
import { service, serve } from 'moltspay';

@service({ price: 0.99 })
async function textToVideo({ prompt }) {
  return { video_url: '...' };
}

serve({ textToVideo }); // Auto-derives service ID from function name
```

---

## 3. API Redesign

### 3.1 Core Module Structure

```
moltspay/
├── index.ts          # Main exports (pay, serve, discover)
├── client.ts         # MoltsPayClient (advanced)
├── server.ts         # MoltsPayServer (advanced)
├── wallet.ts         # Wallet management
├── types.ts          # Shared types
└── cli/              # CLI implementation
```

### 3.2 New Primary API

```typescript
// ============ CLIENT SIDE ============

/**
 * Pay for a service and get the result.
 * 
 * @param url - Service URL (can include service ID in path)
 * @param params - Service parameters
 * @param options - Optional: chain, token, timeout
 */
export async function pay(
  url: string | URL,
  params?: Record<string, any>,
  options?: PayOptions
): Promise<any>;

/**
 * Discover available services from a provider
 */
export async function discover(baseUrl: string): Promise<Service[]>;

/**
 * Check wallet status
 */
export async function status(): Promise<WalletStatus>;

// ============ SERVER SIDE ============

/**
 * Start a payment-enabled service server
 * 
 * @param services - Map of service ID to handler or config
 * @param options - Server options (port, wallet, etc)
 */
export function serve(
  services: ServiceMap,
  options?: ServeOptions
): Promise<Server>;

/**
 * Decorator for defining a paid service
 */
export function service(config: ServiceConfig): MethodDecorator;

// ============ TYPES ============

interface PayOptions {
  chain?: 'base' | 'polygon' | 'base_sepolia';
  token?: 'USDC' | 'USDT';
  timeout?: number;
  wallet?: string; // Custom wallet (for agents)
}

interface Service {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  input: Record<string, ParamSchema>;
  output: Record<string, ParamSchema>;
}

interface ServiceMap {
  [serviceId: string]: ServiceHandler | ServiceDefinition;
}

type ServiceHandler = (params: any) => Promise<any>;

interface ServiceDefinition {
  price: number;
  currency?: string;  // Default: USDC
  name?: string;      // Default: derived from serviceId
  description?: string;
  input?: Record<string, ParamSchema>;
  handler: ServiceHandler;
}

interface ServeOptions {
  port?: number;           // Default: 3000 or PORT env
  wallet?: string;         // Receive wallet (required for mainnet)
  chain?: ChainConfig;     // Chain(s) to accept
  cors?: boolean;          // Default: true
}

interface WalletStatus {
  address: string;
  balances: Record<string, number>;  // { base: 10.5, polygon: 5.2 }
  limits: { perTx: number; perDay: number };
  todaySpent: number;
}
```

### 3.3 URL-Based Service Discovery

Support service ID in URL path for cleaner API:

```typescript
// These are equivalent:
await pay('https://zen7.example.com/text-to-video', { prompt: '...' });
await pay('https://zen7.example.com', 'text-to-video', { prompt: '...' });

// URL parsing logic:
// 1. If path ends with known service ID -> extract it
// 2. If path is /execute or / -> require explicit service param
// 3. Check /.well-known/agent-services.json for service list
```

### 3.4 Auto-Initialization

```typescript
// Client auto-init flow:
async function pay(url, params, options) {
  const wallet = await ensureWallet(); // Creates if missing
  
  // If first time:
  // 1. Generate new wallet
  // 2. Save to ~/.moltspay/wallet.json
  // 3. Print "New wallet created: 0x... Fund with USDC to use."
  // 4. Throw InsufficientFundsError with funding instructions
  
  // If wallet exists but empty:
  // Throw InsufficientFundsError with balance info
  
  return await executePayment(wallet, url, params, options);
}
```

---

## 4. CLI Simplification

### 4.1 Current Commands (Too Many)

```
moltspay init
moltspay config
moltspay fund
moltspay faucet
moltspay status
moltspay pay
moltspay validate
moltspay start
```

### 4.2 New Command Structure

```bash
# Primary commands (most users need only these)
moltspay pay <url> [params...]     # Pay for a service
moltspay serve [services-file]     # Start a server
moltspay status                    # Wallet status + balances

# Setup (run once)
moltspay setup                     # Interactive wallet setup + funding

# Advanced
moltspay wallet export             # Export private key (danger zone)
moltspay wallet import <key>       # Import existing wallet
moltspay config set <key> <value>  # Modify limits
moltspay discover <url>            # List services from provider
```

### 4.3 CLI Examples

```bash
# Setup (first time)
$ moltspay setup
Creating new wallet...
✓ Wallet created: 0x1234...abcd

How would you like to fund your wallet?
1. Coinbase Onramp (card/bank)
2. Transfer USDC directly
3. Testnet faucet (free, for testing)

> 3

✓ Sent 1 USDC to your wallet (base_sepolia testnet)
✓ Ready to use! Run `moltspay status` to check balance.

# Pay for service
$ moltspay pay https://zen7.example.com/text-to-video --prompt "a happy cat"
Paying $0.99 USDC to zen7...
✓ Video generated: https://cdn.example.com/video123.mp4

# Check status
$ moltspay status
Wallet: 0x1234...abcd

Balances:
  Base:     $45.20 USDC
  Polygon:  $12.00 USDC
  Testnet:  $99.00 USDC

Limits:
  Per transaction: $100
  Daily remaining: $850 / $1000

# Start server
$ moltspay serve ./services.json
✓ Loaded 2 services from services.json
✓ Server running on http://0.0.0.0:3000
  - POST /text-to-video ($0.99)
  - POST /image-to-video ($1.49)
```

---

## 5. Configuration Simplification

### 5.1 Service Definition (Server Side)

**Current (Verbose JSON):**
```json
{
  "provider": {
    "name": "Zen7",
    "description": "AI Video Generation",
    "wallet": "0x...",
    "chains": [{ "chain": "base", "tokens": ["USDC"] }]
  },
  "services": [{
    "id": "text-to-video",
    "name": "Text to Video",
    "description": "Generate video from text prompt",
    "price": 0.99,
    "currency": "USDC",
    "function": "generateVideo",
    "input": {
      "prompt": { "type": "string", "required": true }
    },
    "output": {
      "video_url": { "type": "string" }
    }
  }]
}
```

**New (Simple YAML or minimal JSON):**
```yaml
# services.yaml
wallet: 0x...
chain: base  # or [base, polygon]

services:
  text-to-video:
    price: 0.99
    handler: ./handlers/video.js  # or inline
    
  image-to-video:
    price: 1.49
    handler: ./handlers/video.js
```

Or even simpler inline:
```javascript
// services.js
export default {
  wallet: process.env.WALLET_ADDRESS,
  
  'text-to-video': {
    price: 0.99,
    async handler({ prompt }) {
      // Generate video...
      return { video_url: '...' };
    }
  }
};
```

### 5.2 Client Configuration

**Current (~/.moltspay/):**
```
~/.moltspay/
├── config.json      # Limits, chain preference
├── wallet.json      # Private key + address
└── spending.json    # Daily spending tracker
```

**New (Consolidated):**
```
~/.moltspay/
└── wallet.json      # Everything in one file

{
  "address": "0x...",
  "privateKey": "0x...",  // Encrypted with passphrase option
  "chain": "base",
  "limits": { "perTx": 100, "perDay": 1000 },
  "spending": {
    "date": "2024-03-17",
    "amount": 45.50
  }
}
```

---

## 6. Error Handling Improvements

### 6.1 User-Friendly Errors

```typescript
// Current
throw new Error('Client not initialized. Run: npx moltspay init');

// New: Structured errors with recovery instructions
class WalletNotFoundError extends MoltsPayError {
  code = 'WALLET_NOT_FOUND';
  message = 'No wallet found';
  recovery = 'Run `moltspay setup` to create a wallet';
  docs = 'https://moltspay.com/docs/setup';
}

class InsufficientFundsError extends MoltsPayError {
  code = 'INSUFFICIENT_FUNDS';
  message = 'Insufficient balance';
  
  constructor(required: number, available: number, chain: string) {
    this.details = { required, available, chain };
    this.recovery = `Need $${required} USDC, have $${available}. ` +
                    `Fund via: moltspay fund`;
  }
}

class PaymentFailedError extends MoltsPayError {
  code = 'PAYMENT_FAILED';
  // Include tx hash, facilitator used, detailed reason
}

class ServiceUnavailableError extends MoltsPayError {
  code = 'SERVICE_UNAVAILABLE';
  // Include service ID, provider URL, suggested alternatives
}
```

### 6.2 Error Recovery Suggestions

Every error should include:
1. What went wrong (clear message)
2. Why it happened (context)
3. How to fix it (actionable steps)
4. Where to learn more (docs link)

---

## 7. Progressive Complexity

### 7.1 Level 1: Zero Config (Just Works)

```typescript
import { pay, serve } from 'moltspay';

// Client
const video = await pay('https://zen7.com/text-to-video', { prompt: 'cat' });

// Server  
serve({
  'my-service': {
    price: 1.00,
    handler: async (params) => ({ result: 'done' })
  }
});
```

### 7.2 Level 2: Basic Configuration

```typescript
import { pay, serve, configure } from 'moltspay';

// Client with options
configure({
  chain: 'polygon',
  limits: { perTx: 50 }
});

const video = await pay(url, params, { token: 'USDT' });

// Server with provider info
serve({
  ...services
}, {
  name: 'My Provider',
  wallet: '0x...',
  chains: ['base', 'polygon']
});
```

### 7.3 Level 3: Full Control (Current API)

```typescript
import { MoltsPayClient, MoltsPayServer, FacilitatorRegistry } from 'moltspay';

// Full access to current APIs for advanced use cases
const client = new MoltsPayClient({ configDir: '/custom/path' });
const server = new MoltsPayServer('./services.json', {
  facilitators: {
    primary: 'cdp',
    fallback: ['mock'],
    strategy: 'failover'
  }
});
```

---

## 8. Implementation Plan

### Phase 1: New Simple API (Week 1-2)

1. Implement `pay()` function with auto-init
2. Implement `serve()` function with inline service definitions
3. Implement `discover()` function
4. Update `status` command
5. Add new `setup` command

### Phase 2: CLI Cleanup (Week 2-3)

1. Consolidate commands
2. Add interactive setup flow
3. Improve error messages with recovery hints
4. Add `--help` examples for each command

### Phase 3: Documentation & Migration (Week 3-4)

1. Write new getting-started guide
2. Document migration path from old API
3. Add deprecation warnings to old classes
4. Create video tutorials

### Phase 4: Polish & Release (Week 4)

1. Integration tests for new API
2. Performance optimization
3. v1.0.0 release

---

## 9. Backwards Compatibility

### 9.1 Deprecation Strategy

```typescript
// Old API still works, but warns
import { MoltsPayClient } from 'moltspay';

const client = new MoltsPayClient();
// Console: [moltspay] Warning: MoltsPayClient is deprecated. 
//          Use `pay()` function instead. See: https://...

// New API
import { pay } from 'moltspay';
await pay(url, params);
```

### 9.2 Migration Guide

```markdown
# Migrating to MoltsPay v1.0

## Client Changes

Before:
```typescript
const client = new MoltsPayClient();
await client.pay(url, 'service-id', params, { chain: 'base' });
```

After:
```typescript
await pay(`${url}/${serviceId}`, params);
// or
await pay(url, { ...params, _service: serviceId });
```

## Server Changes

Before:
```typescript
const server = new MoltsPayServer('./services.json');
server.skill('my-service', handler);
server.listen(3000);
```

After:
```typescript
serve({
  'my-service': { price: 1.00, handler }
});
```
```

---

## 10. Open Questions

1. **Wallet encryption**: Should we encrypt private keys by default with a passphrase?
   - Pro: More secure
   - Con: Breaks headless/automated use cases
   - Decision: Optional, off by default for agents

2. **YAML vs JSON**: Should we support YAML for service definitions?
   - Pro: More readable
   - Con: Additional dependency
   - Decision: Support both, detect from extension

3. **Decorator syntax**: TypeScript decorators for service definitions?
   - Pro: Clean syntax, familiar to NestJS/Angular users
   - Con: Requires experimental decorators, may not work in all environments
   - Decision: Provide as optional pattern, not primary API

4. **Auto-chain selection**: Should client auto-select cheapest chain?
   - Pro: Best UX
   - Con: May confuse users, gas costs vary
   - Decision: Yes, with clear logging of selection reason

---

## 11. Success Metrics

1. **Time to first payment**: < 5 minutes from npm install
2. **Lines of code for basic client**: < 5 (was 10+)
3. **Lines of code for basic server**: < 10 (was 20+)
4. **Documentation length**: 1 page for getting started (was 3+)
5. **Error resolution time**: Every error should be fixable in < 30s with provided instructions

---

## Appendix: File Changes Summary

### New Files
- `src/simple.ts` - New simple API (pay, serve, discover)
- `src/errors.ts` - Structured error classes
- `src/cli/setup.ts` - Interactive setup command

### Modified Files
- `src/index.ts` - Add new exports, deprecation warnings
- `src/cli/index.ts` - Simplified command structure
- `src/client/index.ts` - Add auto-init, better errors
- `src/server/index.ts` - Support inline service definitions

### Deprecated (Keep for Compatibility)
- `MoltsPayClient` class → use `pay()`
- `MoltsPayServer` class → use `serve()`
- Separate config/wallet files → consolidated wallet.json

---

*Document Version: 1.0*
*Created: 2024-03-17*
*Author: Zen7 Assistant*
