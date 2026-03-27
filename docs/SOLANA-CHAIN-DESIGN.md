# Solana Chain Support Design

Add Solana mainnet and devnet USDC support to MoltsPay payments.

## Summary

| Decision | Choice |
|----------|--------|
| CDP support? | [NO] No - Solana not EVM |
| Gasless method | SPL Token Transfer (rent paid by sender) |
| Pay-for-success? | [OK] Yes - via durable nonces or server-side execution |
| Token support | USDC only (official Circle SPL token) |
| Transaction cost | ~0.000005 SOL (~$0.001) |

**Key Challenge:** Solana is NOT an EVM chain - requires completely different wallet, signing, and transaction infrastructure.

## Current State

### Chains Supported (All EVM)
| Chain | Chain ID | Protocol | VM |
|-------|----------|----------|-----|
| Base | 8453 | x402 (CDP) | EVM |
| Polygon | 137 | x402 (CDP) | EVM |
| Base Sepolia | 84532 | x402 (CDP) | EVM |
| Tempo Moderato | 42431 | MPP | EVM |
| BNB | 56 | Pre-approval | EVM |
| BNB Testnet | 97 | Pre-approval | EVM |
| **Solana** | **N/A** | **SPL Transfer** | **SVM** |
| **Solana Devnet** | **N/A** | **SPL Transfer** | **SVM** |

### Why Solana Matters
- Huge DeFi ecosystem ($5B+ TVL)
- Fast finality (~400ms)
- Low transaction costs (~$0.001)
- Many AI/crypto projects built on Solana
- Circle's official USDC is native SPL token

## Solana Architecture Differences

### EVM vs Solana Comparison

| Aspect | EVM Chains | Solana |
|--------|------------|--------|
| Address format | 0x... (40 hex chars) | Base58 (32-44 chars) |
| Key type | secp256k1 (ECDSA) | ed25519 (EdDSA) |
| Token standard | ERC-20 | SPL Token |
| Gas model | Gas price x gas used | Fixed per-signature + rent |
| Account model | EOA + Contract | Program + Data accounts |
| Token accounts | Balance on token contract | Associated Token Accounts (ATAs) |
| Transaction format | RLP encoded | Borsh serialized |
| Signature | ECDSA | Ed25519 |

### Key Implications

1. **Separate Wallet Required**
   - Cannot use same private key for EVM and Solana
   - Need to manage two keypairs per user
   - Or: derive both from same seed (BIP-39 with different paths)

2. **Associated Token Accounts (ATAs)**
   - Users need an ATA for each SPL token they hold
   - ATA creation costs ~0.002 SOL rent
   - Can be created by sender (payer) if doesn't exist

3. **Different SDK Required**
   - @solana/web3.js instead of ethers.js
   - @solana/spl-token for USDC transfers

## Solana Network Details

| Property | Mainnet | Devnet |
|----------|---------|--------|
| Name | Solana Mainnet | Solana Devnet |
| Cluster | mainnet-beta | devnet |
| RPC | https://api.mainnet-beta.solana.com | https://api.devnet.solana.com |
| Explorer | https://solscan.io | https://solscan.io?cluster=devnet |
| Avg Block Time | ~400ms | ~400ms |
| Native Token | SOL | SOL |

### USDC Token (Official Circle SPL)

| Network | Mint Address | Decimals |
|---------|--------------|----------|
| Mainnet | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | 6 |
| Devnet | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | 6 |

**Note:** Decimals = 6, same as EVM chains (unlike BNB's 18).

## Design Decisions

### 1. Wallet Architecture

**Option A: Separate Solana Wallet (Recommended)**
```
~/.moltspay/
+------ wallet.json           # EVM wallet (existing)
+------ wallet-solana.json    # Solana wallet (NEW)
```

Pros:
- Clean separation
- Each chain uses native key format
- No complex derivation

Cons:
- User manages two addresses
- Need to fund both separately

**Option B: Unified Seed with Derivation Paths**
```
Same mnemonic -> 
  - m/44'/60'/0'/0/0 -> EVM address
  - m/44'/501'/0'/0' -> Solana address
```

Pros:
- Single backup phrase
- Familiar to crypto users

Cons:
- More complex implementation
- Need to store mnemonic (security concern)

**Decision: Option A** - Separate wallets for simplicity in v1. [OK] CONFIRMED 2026-03-21

### 2. Pay-for-Success Flow

Solana doesn't have EIP-2612 permits, but we have options:

**Option A: Durable Nonces (Recommended)**
```
1. Client creates durable nonce account (one-time setup)
2. Client signs tx with durable nonce (offline)
3. Client sends signature to server
4. Server executes service
5. Success -> Server submits pre-signed tx
6. Fail -> Server discards tx (nonce unused)
```

**Option B: Delegated Authority**
```
1. Client delegates transfer authority to server (one-time)
2. Server executes transfers on behalf of client
3. Similar to BNB pre-approval flow
```

**Option C: Server-Side Wallet (Like BNB)**
```
1. Client approves server wallet as delegate
2. Server executes transferChecked after service success
```

**Decision: Option A (Durable Nonces)** - Most decentralized, client controls funds.

### 3. ATA Handling

When sending USDC, recipient needs an Associated Token Account.

**Strategy:**
```typescript
// Check if recipient ATA exists
const recipientATA = await getAssociatedTokenAddress(USDC_MINT, recipientPubkey);
const ataInfo = await connection.getAccountInfo(recipientATA);

if (!ataInfo) {
  // Create ATA in same transaction (sender pays ~0.002 SOL rent)
  const createATAIx = createAssociatedTokenAccountInstruction(
    senderPubkey,      // payer
    recipientATA,      // ata to create
    recipientPubkey,   // owner
    USDC_MINT          // mint
  );
  transaction.add(createATAIx);
}

// Add transfer instruction
transaction.add(
  createTransferCheckedInstruction(
    senderATA,
    USDC_MINT,
    recipientATA,
    senderPubkey,
    amount * 1e6, // 6 decimals
    6
  )
);
```

## Implementation Plan

### Phase 1: Core Infrastructure (8-10 hours)

#### 1.1 Add Solana Dependencies

```bash
cd ~/clawd/projects/payment-agent
npm install @solana/web3.js @solana/spl-token bs58
npm install -D @types/bs58
```

#### 1.2 Create Solana Chain Config

New file: `src/chains/solana.ts`

```typescript
import { Connection, clusterApiUrl, PublicKey } from '@solana/web3.js';

export interface SolanaChainConfig {
  name: string;
  cluster: 'mainnet-beta' | 'devnet' | 'testnet';
  rpc: string;
  explorer: string;
  explorerTx: string;
  tokens: {
    USDC: {
      mint: string;
      decimals: number;
    };
  };
}

export const SOLANA_CHAINS: Record<string, SolanaChainConfig> = {
  solana: {
    name: 'Solana Mainnet',
    cluster: 'mainnet-beta',
    rpc: 'https://api.mainnet-beta.solana.com',
    explorer: 'https://solscan.io/account/',
    explorerTx: 'https://solscan.io/tx/',
    tokens: {
      USDC: {
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
      },
    },
  },
  solana_devnet: {
    name: 'Solana Devnet',
    cluster: 'devnet',
    rpc: 'https://api.devnet.solana.com',
    explorer: 'https://solscan.io/account/',
    explorerTx: 'https://solscan.io/tx/',
    tokens: {
      USDC: {
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        decimals: 6,
      },
    },
  },
};

export function getSolanaConnection(chain: 'solana' | 'solana_devnet'): Connection {
  const config = SOLANA_CHAINS[chain];
  return new Connection(config.rpc, 'confirmed');
}

export function getUSDCMint(chain: 'solana' | 'solana_devnet'): PublicKey {
  return new PublicKey(SOLANA_CHAINS[chain].tokens.USDC.mint);
}
```

#### 1.3 Update Types

In `src/types/index.ts`:

```typescript
// Add to ChainName type
export type ChainName = 
  | 'base' 
  | 'polygon' 
  | 'base_sepolia' 
  | 'tempo_moderato'
  | 'bnb'
  | 'bnb_testnet'
  | 'solana'        // NEW
  | 'solana_devnet'; // NEW

// New type for Solana addresses
export type SolanaAddress = string; // Base58 encoded

// Chain family detection
export type ChainFamily = 'evm' | 'svm';

export function getChainFamily(chain: ChainName): ChainFamily {
  if (chain === 'solana' || chain === 'solana_devnet') {
    return 'svm';
  }
  return 'evm';
}
```

### Phase 2: Solana Wallet Management (4-6 hours)

#### 2.1 Solana Wallet Storage

New file: `src/wallet/solana.ts`

```typescript
import { Keypair } from '@solana/web3.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import bs58 from 'bs58';

const SOLANA_WALLET_PATH = join(process.env.HOME || '', '.moltspay', 'wallet-solana.json');

export interface SolanaWalletData {
  publicKey: string;  // Base58 encoded
  secretKey: string;  // Base58 encoded (encrypted in production)
  createdAt: string;
}

export function loadSolanaWallet(): Keypair | null {
  if (!existsSync(SOLANA_WALLET_PATH)) {
    return null;
  }
  const data: SolanaWalletData = JSON.parse(readFileSync(SOLANA_WALLET_PATH, 'utf-8'));
  const secretKey = bs58.decode(data.secretKey);
  return Keypair.fromSecretKey(secretKey);
}

export function createSolanaWallet(): Keypair {
  const keypair = Keypair.generate();
  const data: SolanaWalletData = {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: bs58.encode(keypair.secretKey),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(SOLANA_WALLET_PATH, JSON.stringify(data, null, 2));
  console.log(`[LOCK] Created Solana wallet: ${keypair.publicKey.toBase58()}`);
  return keypair;
}

export function getSolanaAddress(): string | null {
  const wallet = loadSolanaWallet();
  return wallet?.publicKey.toBase58() || null;
}
```

#### 2.2 CLI Integration

Update `src/cli/index.ts`:

```typescript
import { loadSolanaWallet, createSolanaWallet, getSolanaAddress } from '../wallet/solana.js';

// Add to init command
async function initWallet(options: { chain?: string }) {
  // ... existing EVM init ...
  
  // Initialize Solana wallet if requested
  if (!options.chain || options.chain === 'solana' || options.chain === 'solana_devnet') {
    let solanaWallet = loadSolanaWallet();
    if (!solanaWallet) {
      console.log('\n[CLIP] Setting up Solana wallet...');
      solanaWallet = createSolanaWallet();
    } else {
      console.log(`[OK] Solana wallet: ${solanaWallet.publicKey.toBase58()}`);
    }
  }
}

// Add to status command
async function showStatus() {
  // ... existing EVM status ...
  
  // Show Solana status
  const solanaAddress = getSolanaAddress();
  if (solanaAddress) {
    console.log(`\n[SOL] Solana: ${solanaAddress}`);
    const balance = await getSolanaUSDCBalance(solanaAddress, 'solana');
    console.log(`   USDC: ${balance.toFixed(2)}`);
  }
}
```

### Phase 3: Solana USDC Transfers (6-8 hours)

#### 3.1 Balance Checking

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import { getSolanaConnection, getUSDCMint } from '../chains/solana.js';

export async function getSolanaUSDCBalance(
  address: string, 
  chain: 'solana' | 'solana_devnet'
): Promise<number> {
  const connection = getSolanaConnection(chain);
  const owner = new PublicKey(address);
  const mint = getUSDCMint(chain);
  
  try {
    const ata = await getAssociatedTokenAddress(mint, owner);
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 1e6; // 6 decimals
  } catch (error) {
    // ATA doesn't exist = 0 balance
    return 0;
  }
}
```

#### 3.2 USDC Transfer

```typescript
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { 
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
} from '@solana/spl-token';

export async function transferSolanaUSDC(
  fromKeypair: Keypair,
  toAddress: string,
  amount: number, // in USDC (e.g., 1.50)
  chain: 'solana' | 'solana_devnet'
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const connection = getSolanaConnection(chain);
    const mint = getUSDCMint(chain);
    const toPubkey = new PublicKey(toAddress);
    
    // Get ATAs
    const fromATA = await getAssociatedTokenAddress(mint, fromKeypair.publicKey);
    const toATA = await getAssociatedTokenAddress(mint, toPubkey);
    
    const transaction = new Transaction();
    
    // Check if recipient ATA exists
    const toATAInfo = await connection.getAccountInfo(toATA);
    if (!toATAInfo) {
      // Create ATA for recipient (sender pays rent ~0.002 SOL)
      transaction.add(
        createAssociatedTokenAccountInstruction(
          fromKeypair.publicKey, // payer
          toATA,                  // ata
          toPubkey,              // owner
          mint                   // mint
        )
      );
    }
    
    // Add transfer instruction
    const amountLamports = BigInt(Math.round(amount * 1e6));
    transaction.add(
      createTransferCheckedInstruction(
        fromATA,              // source
        mint,                 // mint
        toATA,                // destination
        fromKeypair.publicKey, // owner
        amountLamports,       // amount
        6                     // decimals
      )
    );
    
    // Send and confirm
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [fromKeypair],
      { commitment: 'confirmed' }
    );
    
    return { success: true, signature };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
```

### Phase 4: Solana Facilitator (Pay-for-Success) (6-8 hours)

#### 4.1 Durable Nonce Setup

```typescript
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
} from '@solana/web3.js';

export async function createDurableNonce(
  payer: Keypair,
  chain: 'solana' | 'solana_devnet'
): Promise<{ nonceAccount: Keypair; nonce: string }> {
  const connection = getSolanaConnection(chain);
  const nonceAccount = Keypair.generate();
  
  // Calculate rent-exempt balance
  const rentExempt = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  
  const transaction = new Transaction().add(
    // Create nonce account
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: nonceAccount.publicKey,
      lamports: rentExempt,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    // Initialize nonce
    SystemProgram.nonceInitialize({
      noncePubkey: nonceAccount.publicKey,
      authorizedPubkey: payer.publicKey,
    })
  );
  
  await sendAndConfirmTransaction(connection, transaction, [payer, nonceAccount]);
  
  // Get the nonce value
  const nonceAccountInfo = await connection.getAccountInfo(nonceAccount.publicKey);
  const nonceData = NonceAccount.fromAccountData(nonceAccountInfo!.data);
  
  return {
    nonceAccount,
    nonce: nonceData.nonce,
  };
}
```

#### 4.2 Pre-Sign Transaction with Durable Nonce

```typescript
export async function createPresignedTransfer(
  fromKeypair: Keypair,
  toAddress: string,
  amount: number,
  nonceAccount: PublicKey,
  nonce: string,
  chain: 'solana' | 'solana_devnet'
): Promise<{ serializedTx: string; signature: string }> {
  const connection = getSolanaConnection(chain);
  const mint = getUSDCMint(chain);
  const toPubkey = new PublicKey(toAddress);
  
  const fromATA = await getAssociatedTokenAddress(mint, fromKeypair.publicKey);
  const toATA = await getAssociatedTokenAddress(mint, toPubkey);
  
  const transaction = new Transaction();
  
  // Use durable nonce instead of recent blockhash
  transaction.recentBlockhash = nonce;
  transaction.feePayer = fromKeypair.publicKey;
  
  // Advance nonce instruction (required first)
  transaction.add(
    SystemProgram.nonceAdvance({
      noncePubkey: nonceAccount,
      authorizedPubkey: fromKeypair.publicKey,
    })
  );
  
  // Transfer instruction
  const amountLamports = BigInt(Math.round(amount * 1e6));
  transaction.add(
    createTransferCheckedInstruction(
      fromATA,
      mint,
      toATA,
      fromKeypair.publicKey,
      amountLamports,
      6
    )
  );
  
  // Sign (offline-capable)
  transaction.sign(fromKeypair);
  
  return {
    serializedTx: transaction.serialize().toString('base64'),
    signature: bs58.encode(transaction.signature!),
  };
}
```

#### 4.3 Server-Side Execution

```typescript
export async function executePresignedTransaction(
  serializedTx: string,
  chain: 'solana' | 'solana_devnet'
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const connection = getSolanaConnection(chain);
    const transaction = Transaction.from(Buffer.from(serializedTx, 'base64'));
    
    // Send pre-signed transaction (no additional signing needed)
    const signature = await connection.sendRawTransaction(transaction.serialize());
    
    // Wait for confirmation
    await connection.confirmTransaction(signature, 'confirmed');
    
    return { success: true, signature };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
```

### Phase 5: Server Integration (4-6 hours)

#### 5.1 Update Server Routes

In `moltspay-creators/src/routes/agent.js`:

```javascript
// Add Solana to supported chains
const supportedChains = [
  'base', 'polygon', 'base_sepolia', 
  'tempo_moderato', 'bnb', 'bnb_testnet',
  'solana', 'solana_devnet'  // NEW
];

// Handle Solana payment verification
async function verifyPayment(chain, txHash, expected) {
  if (chain === 'solana' || chain === 'solana_devnet') {
    return verifySolanaPayment(chain, txHash, expected);
  }
  // ... existing EVM verification ...
}

async function verifySolanaPayment(chain, signature, expected) {
  const connection = getSolanaConnection(chain);
  
  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  
  if (!tx || tx.meta?.err) {
    return { valid: false, error: 'Transaction failed or not found' };
  }
  
  // Parse token transfer from transaction
  const preBalances = tx.meta.preTokenBalances || [];
  const postBalances = tx.meta.postTokenBalances || [];
  
  // Find USDC transfer to expected recipient
  const usdcMint = SOLANA_CHAINS[chain].tokens.USDC.mint;
  
  for (const post of postBalances) {
    if (post.mint !== usdcMint) continue;
    
    const pre = preBalances.find(p => 
      p.accountIndex === post.accountIndex && p.mint === usdcMint
    );
    
    const preAmount = pre?.uiTokenAmount?.uiAmount || 0;
    const postAmount = post.uiTokenAmount?.uiAmount || 0;
    const received = postAmount - preAmount;
    
    if (received >= expected.amount * 0.99) {
      return { valid: true };
    }
  }
  
  return { valid: false, error: 'Payment not found in transaction' };
}
```

### Phase 6: Faucet Support (Devnet) (2-3 hours)

#### 6.1 Solana Devnet Faucet

```typescript
// Get devnet SOL for gas
export async function requestDevnetSol(address: string): Promise<string> {
  const connection = getSolanaConnection('solana_devnet');
  const pubkey = new PublicKey(address);
  
  const signature = await connection.requestAirdrop(pubkey, 1e9); // 1 SOL
  await connection.confirmTransaction(signature);
  
  return signature;
}

// Get devnet USDC (if faucet available)
// Note: Circle's devnet USDC may not have a public faucet
// Alternative: Deploy our own test SPL token
export async function mintTestUSDC(
  toAddress: string,
  amount: number
): Promise<string> {
  // This requires us to be the mint authority
  // For devnet, we can deploy our own test token
  // ...
}
```

### Phase 7: Testing (4-6 hours)

#### 7.1 Unit Tests

```typescript
describe('Solana Support', () => {
  describe('Wallet', () => {
    it('creates new Solana wallet', () => {
      const wallet = createSolanaWallet();
      expect(wallet.publicKey.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    });
    
    it('loads existing wallet', () => {
      const wallet1 = createSolanaWallet();
      const wallet2 = loadSolanaWallet();
      expect(wallet1.publicKey.equals(wallet2!.publicKey)).toBe(true);
    });
  });
  
  describe('Transfers', () => {
    it('gets USDC balance', async () => {
      const balance = await getSolanaUSDCBalance(TEST_ADDRESS, 'solana_devnet');
      expect(typeof balance).toBe('number');
    });
    
    it('transfers USDC', async () => {
      // Requires funded devnet wallet
      const result = await transferSolanaUSDC(
        testKeypair,
        RECIPIENT_ADDRESS,
        0.01,
        'solana_devnet'
      );
      expect(result.success).toBe(true);
    });
  });
});
```

#### 7.2 Integration Tests

```bash
# Test on devnet
export MOLTSPAY_CHAIN=solana_devnet

# Initialize Solana wallet
npx moltspay init --chain solana

# Check status
npx moltspay status
# Should show Solana address and balance

# Request devnet SOL (for gas)
npx moltspay faucet --chain solana_devnet

# Test transfer (to self)
npx moltspay send 0.01 YOUR_ADDRESS --chain solana_devnet
```

## File Checklist

| File | Changes | Status |
|------|---------|--------|
| `package.json` | Add @solana/web3.js, @solana/spl-token, bs58 | [ ] TODO |
| `src/chains/solana.ts` | NEW - Solana chain configs | [ ] TODO |
| `src/types/index.ts` | Add solana, solana_devnet to ChainName | [ ] TODO |
| `src/wallet/solana.ts` | NEW - Solana wallet management | [ ] TODO |
| `src/transfers/solana.ts` | NEW - USDC transfer logic | [ ] TODO |
| `src/facilitators/solana.ts` | NEW - Pay-for-success with durable nonces | [ ] TODO |
| `src/cli/index.ts` | Add Solana to init, status, faucet commands | [ ] TODO |
| `src/client/index.ts` | Handle Solana payments | [ ] TODO |
| `moltspay-creators/src/routes/agent.js` | Add Solana chain support | [ ] TODO |
| `moltspay-creators/src/routes/faucet.js` | Add Solana devnet faucet | [ ] TODO |

## Effort Estimate

| Phase | Time | Priority |
|-------|------|----------|
| 1. Core Infrastructure | 8-10h | High |
| 2. Wallet Management | 4-6h | High |
| 3. USDC Transfers | 6-8h | High |
| 4. Pay-for-Success Facilitator | 6-8h | Medium |
| 5. Server Integration | 4-6h | High |
| 6. Faucet (Devnet) | 2-3h | Low |
| 7. Testing | 4-6h | High |

**Total: 34-47 hours** (~5-7 days)

### MVP (Faster Path)

Skip pay-for-success, use direct transfers:
- Phase 4: Skip or simplify
- **Total: 24-32 hours** (~4-5 days)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Different wallet format confuses users | Medium | Clear documentation, separate addresses in UI |
| Durable nonce complexity | High | Start with direct transfers, add nonces later |
| Circle devnet USDC availability | Medium | Deploy our own test token if needed |
| RPC rate limits | Low | Use paid RPC (Helius, QuickNode) for production |
| Transaction serialization bugs | Medium | Extensive testing, use official SDKs |

## Open Questions

1. **Wallet Derivation:** Should we derive EVM and Solana keys from same seed?
   - Pro: Single backup
   - Con: More complex, need mnemonic storage

2. **Default Chain:** Should Solana be opt-in or included by default?
   - Recommendation: Opt-in with `--chain solana`

3. **RPC Provider:** Use public RPC or paid service?
   - Dev: Public (api.devnet.solana.com)
   - Prod: Helius/QuickNode (rate limits, reliability)

4. **Pay-for-Success Priority:** Is durable nonce essential for v1?
   - Could launch with direct transfers first
   - Add pay-for-success in v1.1

## Resources

- [Solana Web3.js Docs](https://solana-labs.github.io/solana-web3.js/)
- [SPL Token Docs](https://spl.solana.com/token)
- [Circle USDC on Solana](https://developers.circle.com/stablecoins/docs/usdc-on-main-networks)
- [Durable Nonces Guide](https://docs.solana.com/implemented-proposals/durable-tx-nonces)
- [Solscan Explorer](https://solscan.io/)

---

*Created: 2026-03-21*
*Author: Zen7 Assistant*
