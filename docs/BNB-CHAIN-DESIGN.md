# BNB Chain Support Design

Add BNB Smart Chain (BSC) as a supported chain for MoltsPay payments.

## Summary

| Decision | Choice |
|----------|--------|
| CDP support? | ❌ No - BNB not supported |
| Gasless method | Pre-approval + server pays gas |
| Pay-for-success? | ✅ Yes - server controls settlement |
| Token support | USDT + USDC (18 decimals) |
| Gas cost | ~$0.01 (absorbed by server) |

**Key difference from Tempo:**
- Tempo MPP: Client pays first → service might fail → money lost ❌
- BNB approach: Client approves → service runs → success = payment ✅

**UX:** No new commands! Approval integrated into `moltspay init`
**Onboarding:** Server sponsors ~$0.01 BNB gas for new wallets (seamless)

## Current State

### Chains Supported
| Chain | Chain ID | Protocol | Status |
|-------|----------|----------|--------|
| Base | 8453 | x402 (CDP) | ✅ Production |
| Polygon | 137 | x402 (CDP) | ✅ Production |
| Base Sepolia | 84532 | x402 (CDP) | ✅ Testnet |
| Tempo Moderato | 42431 | MPP | ✅ Testnet |
| **BNB** | **56** | **Pre-approval** | **✅ Code Complete** |
| **BNB Testnet** | **97** | **Pre-approval** | **🧪 Testing Pending** |

### Tokens Supported
- USDC (all chains)
- USDT (all chains) - **Already implemented!**
- pathUSD/alphaUSD (Tempo only)

## BNB Chain Details

| Property | Mainnet | Testnet |
|----------|---------|---------|
| Name | BNB Smart Chain | BNB Testnet |
| Chain ID | 56 | 97 |
| RPC | https://bsc-dataseed.binance.org | https://data-seed-prebsc-1-s1.binance.org:8545 |
| Explorer | https://bscscan.com | https://testnet.bscscan.com |
| Avg Block Time | 3 seconds | 3 seconds |
| Gas Token | BNB | BNB |

### Token Contracts (BNB Mainnet)

| Token | Address | Decimals |
|-------|---------|----------|
| USDT | `0x55d398326f99059fF775485246999027B3197955` | 18 |
| USDC | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | 18 |

**Note:** Both tokens use 18 decimals on BNB (not 6 like on Base/Polygon).

### Token Contracts (BNB Testnet)

| Token | Address | Decimals | Note |
|-------|---------|----------|------|
| USDT | TBD | 18 | Deploy or find existing |
| USDC | TBD | 18 | Deploy or find existing |

**Option 1:** Use existing testnet stablecoins (search BSCScan testnet)
**Option 2:** Deploy our own test tokens (simple ERC20)

```solidity
// Simple test token for BNB testnet
contract TestUSDT is ERC20 {
    constructor() ERC20("Test USDT", "tUSDT") {
        _mint(msg.sender, 1000000 * 10**18); // 1M tokens
    }
    
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
```

## Key Question: CDP Support

**Does Coinbase CDP support BNB chain for gasless payments?**

### Research Result: NO ❌

CDP only supports: Base, Polygon, Ethereum, Arbitrum, Optimism (EVM chains in Coinbase ecosystem).
BNB Chain is NOT supported by CDP.

### BNB Gasless Options

BNB supports gasless via **meta-transactions** (EIP-2771) and **account abstraction** (ERC-4337), 
but these are application-layer solutions, not protocol-level.

For MoltsPay, we have three options:

| Option | Description | Pay-for-Success? | Effort |
|--------|-------------|------------------|--------|
| A: Server pays gas | Server holds BNB, executes transfers | ✅ Yes | Medium |
| B: Meta-tx relayer | EIP-2771 trusted forwarder | ✅ Yes | High |
| C: Direct on-chain (like Tempo) | Client pays first | ❌ No | Low |

### Chosen Approach: Option A (Server pays gas + Pay-for-Success)

**Why Option A:**
- Supports **pay-for-success** (unlike Tempo MPP where client pays upfront)
- Server controls settlement timing
- Gas cost ~$0.01 (absorbed in service pricing)
- Reuses x402-like UX

**Why NOT Tempo-style (Option C):**
- Tempo MPP = client pays before service executes
- If service fails, client already lost money
- Bad UX for paid services

## Pay-for-Success Architecture

### The Problem with Tempo/MPP
```
1. Client pays on-chain         → Money committed
2. Client sends txHash to server
3. Server executes service      → Service might fail!
4. Service fails                → Client's money is gone ❌
```

### Solution: Pre-Approval Flow
```
1. One-time: Client approves BNBFacilitator contract (or server wallet)
2. Client signs intent (NOT payment)
3. Server validates intent signature
4. Server executes service
5. Success → Server calls transferFrom (server pays gas)
6. Fail → No transfer, client keeps money ✅
```

### How Pre-Approval Works

**Integrated into `moltspay init` - No separate approve command!**

**New wallet (first time):**
```bash
$ moltspay init

🔐 Creating new wallet...
   Address: 0xABC123...

📋 Setting up chain approvals...
   ✅ Base: gasless (no approval needed)
   ✅ Polygon: gasless (no approval needed)  
   ⏳ BNB: approving USDT... (tx: 0x...) ✅
   ⏳ BNB: approving USDC... (tx: 0x...) ✅

💰 Fund your wallet:
   Send USDC/USDT to 0xABC123... on any supported chain

✅ Wallet ready!
```

**Existing wallet, add BNB support:**
```bash
$ moltspay init --chain bnb

🔐 Wallet found: 0xABC123...

📋 Setting up BNB approvals...
   ⏳ BNB: approving USDT... (tx: 0x...) ✅
   ⏳ BNB: approving USDC... (tx: 0x...) ✅

✅ BNB chain enabled!
```

**Implementation in CLI:**
```typescript
// In moltspay init
async function initWallet(options: { chain?: string }) {
  let wallet = loadExistingWallet();
  const isNewWallet = !wallet;
  
  if (!wallet) {
    // Create new wallet
    wallet = createNewWallet();
    saveWallet(wallet);
    console.log('🔐 Created wallet:', wallet.address);
  }
  
  // Setup approvals for requested chain (or all chains)
  const chains = options.chain ? [options.chain] : ['base', 'polygon', 'bnb'];
  
  for (const chain of chains) {
    if (chain === 'bnb') {
      // BNB requires approval (not gasless)
      await setupBNBApprovals(wallet, isNewWallet);
    } else {
      // Base/Polygon are gasless via CDP, no approval needed
      console.log(`✅ ${chain}: gasless (no approval needed)`);
    }
  }
}

async function setupBNBApprovals(wallet: Wallet, sponsorGas: boolean) {
  const provider = new JsonRpcProvider(CHAINS.bnb.rpc);
  const signer = wallet.connect(provider);
  
  // Check if user has BNB for gas
  let bnbBalance = await provider.getBalance(wallet.address);
  
  if (bnbBalance < parseEther('0.001')) {
    if (sponsorGas) {
      // Server sponsors gas for new wallets (~$0.01)
      console.log('⏳ Sponsoring BNB gas for approval...');
      await sponsorBNBGas(wallet.address, '0.001');
      bnbBalance = await provider.getBalance(wallet.address);
    } else {
      console.log('⚠️  Need ~0.001 BNB for approval gas.');
      console.log('   Run: moltspay init --chain bnb (after funding)');
      return;
    }
  }
  
  for (const token of ['USDT', 'USDC']) {
    const tokenConfig = CHAINS.bnb.tokens[token];
    const contract = new Contract(tokenConfig.address, ERC20_ABI, signer);
    
    // Check existing allowance
    const allowance = await contract.allowance(wallet.address, SERVER_WALLET);
    if (allowance > 0) {
      console.log(`✅ BNB ${token}: already approved`);
      continue;
    }
    
    console.log(`⏳ BNB: approving ${token}...`);
    const tx = await contract.approve(SERVER_WALLET, MaxUint256);
    await tx.wait();
    console.log(`✅ BNB ${token}: approved (tx: ${tx.hash})`);
  }
}

async function sponsorBNBGas(toAddress: string, amount: string) {
  // Server wallet sends small BNB for approval gas
  // Cost: ~$0.01 per new user (one-time)
  const serverWallet = new Wallet(SERVER_PRIVATE_KEY, bnbProvider);
  const tx = await serverWallet.sendTransaction({
    to: toAddress,
    value: parseEther(amount),
  });
  await tx.wait();
  console.log(`✅ Sponsored ${amount} BNB (tx: ${tx.hash})`);
}
```

**Step 2: Client signs intent (every payment - unchanged)**
```typescript
// Client signs EIP-712 intent (no gas, just signature)
const intent = {
  from: clientAddress,
  to: serviceProvider,
  amount: parseUnits('0.99', 18),
  token: 'USDT',
  service: 'text-to-video',
  nonce: 12345,
  deadline: Date.now() + 3600000, // 1 hour
};
const signature = await wallet.signTypedData(domain, types, intent);
```

**Step 3: Server executes after success (unchanged)**
```typescript
// Server verifies signature, executes service
const result = await executeService(params);

if (result.success) {
  // Server calls transferFrom (server pays gas)
  await facilitator.executePayment(intent, signature);
  // Money moves from client → provider
}
// If failed, no transfer happens
```

### BNBFacilitator Contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract BNBFacilitator is EIP712 {
    using ECDSA for bytes32;
    
    mapping(address => uint256) public nonces;
    
    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "PaymentIntent(address from,address to,uint256 amount,address token,string service,uint256 nonce,uint256 deadline)"
    );
    
    constructor() EIP712("MoltsPay", "1") {}
    
    function executePayment(
        address from,
        address to,
        uint256 amount,
        address token,
        string calldata service,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "Intent expired");
        require(nonces[from] == nonce, "Invalid nonce");
        
        bytes32 structHash = keccak256(abi.encode(
            INTENT_TYPEHASH, from, to, amount, token, keccak256(bytes(service)), nonce, deadline
        ));
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = hash.recover(signature);
        
        require(signer == from, "Invalid signature");
        
        nonces[from]++;
        
        // Transfer tokens (requires prior approval)
        IERC20(token).transferFrom(from, to, amount);
        
        emit PaymentExecuted(from, to, amount, token, service);
    }
    
    event PaymentExecuted(address indexed from, address indexed to, uint256 amount, address token, string service);
}
```

### Alternative: Server Wallet as Spender

If we don't want to deploy a contract, we can use our server wallet directly:

```typescript
// Client approves server wallet (not a contract)
await usdt.approve(SERVER_WALLET_ADDRESS, MAX_UINT256);

// Server executes transferFrom directly
const serverWallet = new Wallet(SERVER_PRIVATE_KEY, provider);
const usdt = new Contract(USDT_ADDRESS, ERC20_ABI, serverWallet);
await usdt.transferFrom(clientAddress, providerAddress, amount);
```

**Pros:** No contract deployment needed
**Cons:** Server wallet becomes critical infrastructure (security concern)

### Comparison: BNB vs Other Chains

| Chain | Protocol | Pay-for-Success | Who Pays Gas | Client Action |
|-------|----------|-----------------|--------------|---------------|
| Base | x402 (CDP) | ✅ Yes | CDP Facilitator | Sign permit |
| Polygon | x402 (CDP) | ✅ Yes | CDP Facilitator | Sign permit |
| Tempo | MPP | ❌ No | Client | Pay on-chain |
| **BNB** | **Pre-approval** | **✅ Yes** | **Server** | **Approve once + sign intent** |

## Implementation Plan

### Phase 1: Contract & Setup (2-3 hours)

1. **Deploy BNBFacilitator contract**
   - Deploy to BNB testnet first
   - Test approve + executePayment flow
   - Deploy to mainnet

2. **Alternative: Use server wallet**
   - Skip contract deployment
   - Server wallet calls transferFrom directly
   - Trade-off: simpler but more centralized

### Phase 2: Chain Configuration (30 min)

Add to `src/chains/index.ts`:

```typescript
bnb: {
  name: 'BNB Smart Chain',
  chainId: 56,
  rpc: 'https://bsc-dataseed.binance.org',
  tokens: {
    USDC: {
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      decimals: 18,  // ⚠️ Different from Base/Polygon!
      symbol: 'USDC',
      eip712Name: 'USD Coin',
    },
    USDT: {
      address: '0x55d398326f99059fF775485246999027B3197955',
      decimals: 18,  // ⚠️ Different from Base/Polygon!
      symbol: 'USDT',
      eip712Name: 'Tether USD',
    },
  },
  usdc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
  explorer: 'https://bscscan.com/address/',
  explorerTx: 'https://bscscan.com/tx/',
  avgBlockTime: 3,
},

bnb_testnet: {
  name: 'BNB Testnet',
  chainId: 97,
  rpc: 'https://data-seed-prebsc-1-s1.binance.org:8545',
  tokens: {
    USDC: { /* TBD */ },
    USDT: { /* TBD */ },
  },
  explorer: 'https://testnet.bscscan.com/address/',
  explorerTx: 'https://testnet.bscscan.com/tx/',
  avgBlockTime: 3,
},
```

### Phase 3: Update Types (15 min)

In `src/types/index.ts`:

```typescript
export type ChainName = 
  | 'base' 
  | 'polygon' 
  | 'base_sepolia' 
  | 'tempo_moderato'
  | 'bnb'        // NEW
  | 'bnb_testnet'; // NEW
```

### Phase 4: BNBFacilitator (3-4 hours)

Create `src/facilitators/bnb.ts`:

```typescript
import { ethers } from 'ethers';
import { CHAINS } from '../chains/index.js';

const FACILITATOR_ABI = [
  'function executePayment(address from, address to, uint256 amount, address token, string service, uint256 nonce, uint256 deadline, bytes signature)',
  'function nonces(address) view returns (uint256)',
];

const ERC20_ABI = [
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export class BNBFacilitator {
  private provider: ethers.JsonRpcProvider;
  private serverWallet: ethers.Wallet;
  private facilitatorAddress?: string; // Optional: use contract
  
  constructor(serverPrivateKey: string, facilitatorAddress?: string) {
    this.provider = new ethers.JsonRpcProvider(CHAINS.bnb.rpc);
    this.serverWallet = new ethers.Wallet(serverPrivateKey, this.provider);
    this.facilitatorAddress = facilitatorAddress;
  }
  
  /**
   * Check if client has approved spending
   */
  async checkAllowance(clientAddress: string, token: 'USDC' | 'USDT'): Promise<number> {
    const tokenConfig = CHAINS.bnb.tokens[token];
    const tokenContract = new ethers.Contract(tokenConfig.address, ERC20_ABI, this.provider);
    const spender = this.facilitatorAddress || this.serverWallet.address;
    const allowance = await tokenContract.allowance(clientAddress, spender);
    return parseFloat(ethers.formatUnits(allowance, tokenConfig.decimals));
  }
  
  /**
   * Execute payment after service success (pay-for-success)
   * Server pays gas, transfers from client to provider
   */
  async executePayment(
    intent: {
      from: string;
      to: string;
      amount: number;
      token: 'USDC' | 'USDT';
      service: string;
      nonce: number;
      deadline: number;
    },
    signature: string
  ): Promise<{ success: boolean; txHash?: string; error?: string }> {
    try {
      const tokenConfig = CHAINS.bnb.tokens[intent.token];
      const amountWei = ethers.parseUnits(intent.amount.toString(), tokenConfig.decimals);
      
      if (this.facilitatorAddress) {
        // Use facilitator contract
        const facilitator = new ethers.Contract(
          this.facilitatorAddress, 
          FACILITATOR_ABI, 
          this.serverWallet
        );
        const tx = await facilitator.executePayment(
          intent.from,
          intent.to,
          amountWei,
          tokenConfig.address,
          intent.service,
          intent.nonce,
          intent.deadline,
          signature
        );
        const receipt = await tx.wait();
        return { success: true, txHash: receipt.hash };
      } else {
        // Direct transferFrom (server wallet as spender)
        // Note: Requires client to have approved server wallet
        const tokenContract = new ethers.Contract(
          tokenConfig.address, 
          ERC20_ABI, 
          this.serverWallet
        );
        const tx = await tokenContract.transferFrom(intent.from, intent.to, amountWei);
        const receipt = await tx.wait();
        return { success: true, txHash: receipt.hash };
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Verify a completed payment on BNB chain
   */
  async verifyPayment(txHash: string, expected: {
    to: string;
    amount: number;
    token: 'USDC' | 'USDT';
  }): Promise<{ valid: boolean; error?: string }> {
    const receipt = await this.provider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) {
      return { valid: false, error: 'Transaction failed or pending' };
    }
    
    const tokenConfig = CHAINS.bnb.tokens[expected.token];
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    
    const transferLog = receipt.logs.find(log => 
      log.address.toLowerCase() === tokenConfig.address.toLowerCase() &&
      log.topics[0] === transferTopic
    );
    
    if (!transferLog) {
      return { valid: false, error: 'No token transfer found' };
    }
    
    const toTopic = transferLog.topics[2];
    const actualTo = ethers.getAddress('0x' + toTopic.slice(26));
    const actualAmount = parseFloat(
      ethers.formatUnits(transferLog.data, tokenConfig.decimals)
    );
    
    if (actualTo.toLowerCase() !== expected.to.toLowerCase()) {
      return { valid: false, error: 'Wrong recipient' };
    }
    
    if (actualAmount < expected.amount * 0.99) { // 1% tolerance
      return { valid: false, error: `Amount too low: ${actualAmount} < ${expected.amount}` };
    }
    
    return { valid: true };
  }
}
```

### Phase 5: Client Updates (1 hour)

In `src/client/index.ts`:

1. Add BNB chain detection:
```typescript
if (chainId === 56) return 'bnb';
if (chainId === 97) return 'bnb_testnet';
```

2. Handle 18 decimals:
```typescript
// When formatting amounts, use token config decimals
const decimals = chain.tokens[token].decimals; // 18 for BNB, 6 for Base
```

3. If no permit support:
```typescript
// BNB USDT may not support EIP-2612 permit
// Fall back to direct transfer (requires gas)
if (chain === 'bnb' && token === 'USDT') {
  return this.directTransfer(to, amount); // Requires ~$0.01 BNB for gas
}
```

### Phase 6: Server Updates (30 min)

In `src/routes/agent.js` (moltspay-creators):

```typescript
const supportedChains = ['base', 'polygon', 'base_sepolia', 'tempo_moderato', 'bnb'];
```

### Phase 7: Testing (2 hours)

1. **Unit tests:**
   - BNB chain config
   - 18 decimal handling
   - BNBFacilitator verification

2. **Integration tests (Testnet):**
   - Transfer USDT on BNB testnet
   - Verify payment
   - End-to-end service call

3. **Mainnet test:**
   - Small amount ($0.01) real payment
   - Verify balance updates
   - Verify service delivery

## Decimals Handling

**Critical:** BNB uses 18 decimals, Base/Polygon use 6!

| Chain | USDC Decimals | USDT Decimals |
|-------|---------------|---------------|
| Base | 6 | 6 |
| Polygon | 6 | 6 |
| BNB | 18 | 18 |

```typescript
// $1.00 USDC on Base
const amountBase = ethers.parseUnits('1.0', 6);  // 1000000

// $1.00 USDC on BNB
const amountBNB = ethers.parseUnits('1.0', 18); // 1000000000000000000
```

**Already handled:** Our code uses `chain.tokens[token].decimals` from config, so this should work automatically.

## Gas Costs

| Chain | USDC Transfer | Cost (USD) |
|-------|---------------|------------|
| Base | ~21,000 gas | ~$0.001 |
| Polygon | ~60,000 gas | ~$0.01 |
| BNB | ~65,000 gas | ~$0.01 |

BNB gas is cheap (~$0.01), acceptable for non-gasless flow.

## Permit Support Analysis

| Chain | Token | EIP-2612 Permit? | Gasless? |
|-------|-------|------------------|----------|
| Base | USDC | ✅ Yes | ✅ Yes |
| Base | USDT | ❌ No | ❌ No (needs gas) |
| BNB | USDC | ⚠️ Check | TBD |
| BNB | USDT | ❌ Likely No | ❌ No (needs gas) |

**USDT generally doesn't support permit** on any chain (legacy contract design).

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| CDP doesn't support BNB | High | BNBFacilitator fallback |
| 18 decimal bugs | Medium | Unit tests for amount conversion |
| Permit not supported | Low | Direct transfer fallback |
| RPC reliability | Low | Multiple RPC endpoints |

## Effort Estimate

| Phase | Time | Depends On |
|-------|------|------------|
| 1. Contract/Setup | 2-3h | - |
| 2. Chain config | 30m | - |
| 3. Types | 15m | - |
| 4. BNBFacilitator | 3-4h | Phase 1 |
| 5. Client (intent signing) | 2h | Phase 2, 3 |
| 6. Server integration | 1h | Phase 4 |
| 7. Testing | 3h | All above |

**Total: 12-14 hours** (~2 days)

### MVP (faster):
Skip contract deployment, use server wallet directly:
- Phase 1: Skip (no contract)
- Phase 4: Simpler (just transferFrom)
- **Total: 8-10 hours** (~1.5 days)

## File Checklist

| File | Changes | Status |
|------|---------|--------|
| `src/chains/index.ts` | Add `bnb` and `bnb_testnet` configs (18 decimals!) | ✅ Done |
| `src/types/index.ts` | Add `bnb`, `bnb_testnet` to `ChainName` type | ✅ Done |
| `src/facilitators/bnb.ts` | NEW - BNBFacilitator with pay-for-success | ✅ Done |
| `src/facilitators/index.ts` | Export BNBFacilitator | ✅ Done |
| `src/facilitators/registry.ts` | Register bnb factory | ✅ Done |
| `src/client/index.ts` | Add chainId mapping, intent signing (handleBNBPayment) | ✅ Done |
| `src/server/index.ts` | Add `bnb` to CHAIN_TO_NETWORK, TOKEN_DOMAINS, supportedChains | ✅ Done |
| `src/cli/index.ts` | Update `init` command to handle BNB approvals | ✅ Done |
| `moltspay-creators/src/routes/faucet.js` | Multi-chain faucet (base_sepolia + bnb_testnet) | ✅ Done |
| `/var/www/moltspay/schemas/services.json` | Add bnb/bnb_testnet to schema | ✅ Done |
| `contracts/BNBFacilitator.sol` | Optional - using server wallet instead | ⏭️ Skipped |

## CLI Changes

**No new commands!** Integrate into existing `init`:

```bash
# New wallet - approves all chains including BNB
moltspay init

# Existing wallet - add BNB support only
moltspay init --chain bnb

# Check approval status
moltspay status
# Shows: BNB: ✅ approved (USDT, USDC)
```

## Implementation Status

**Completed: 2026-03-21**

### Phase 1: Testnet ✅ CODE COMPLETE

1. [x] Add `bnb_testnet` chain config (chainId 97) ✅
2. [x] Use existing testnet USDC (`0x64544969ed7EBf5f083679233325356EbE738930`) ✅
3. [x] Implement BNBFacilitator (transferFrom flow) ✅
4. [x] Update `moltspay init` to handle BNB approvals ✅
5. [ ] Test full flow on testnet: **PENDING** (waiting for testnet USDC - 24h faucet cooldown)
   - `moltspay init --chain bnb_testnet` (with gas sponsorship)
   - `moltspay pay --chain bnb_testnet`
   - Verify pay-for-success works
6. [ ] Fix any issues found

### Phase 2: Mainnet

7. [x] Add `bnb` mainnet chain config (chainId 56) ✅
8. [ ] Fund server wallet with BNB for gas sponsorship
9. [ ] Test with small amounts ($0.01)
10. [ ] Full production deployment

## BNB Testnet Resources

| Resource | URL |
|----------|-----|
| Faucet (get test BNB) | https://testnet.bnbchain.org/faucet-smart |
| Explorer | https://testnet.bscscan.com |
| RPC | https://data-seed-prebsc-1-s1.binance.org:8545 |
| Chain ID | 97 |

**Test Tokens:**
- Need to deploy our own test USDT/USDC, OR
- Find existing testnet stablecoin contracts

```bash
# Get testnet BNB from faucet
# 1. Go to https://testnet.bnbchain.org/faucet-smart
# 2. Enter wallet address
# 3. Get 0.1 tBNB (enough for many tests)
```

## Open Questions

1. **Server wallet security:** If using server wallet as spender, it becomes critical infra
   - Mitigation: Use HSM or multi-sig for production
   - Or: Deploy facilitator contract (more decentralized)

2. ~~**User onboarding:** Approval step adds friction~~
   - ✅ Solved: Server sponsors ~$0.01 BNB gas for new wallets
   - Seamless UX: `moltspay init` handles everything

3. **Nonce management:** Need to track per-user nonces
   - Store in database or derive from on-chain

4. **Gas sponsorship cost:** ~$0.01 per new BNB user
   - At 10,000 users = $100 total (negligible)
   - Can add rate limiting if abused
   - Could recover via first transaction fee if needed

---

*Created: 2026-03-21*
*Author: Zen7 Assistant*
