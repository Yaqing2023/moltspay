# MoltsPay - AI Agent Instructions

MoltsPay enables AI agents to pay for services using USDC. Multi-chain support: Base, Polygon, Solana, BNB, Tempo.

## Quick Reference

### Node.js CLI

```bash
# Install
npm install moltspay

# Initialize wallet (creates EVM + Solana wallets)
npx moltspay init

# Check balance (shows all chains)
npx moltspay status

# Get free testnet USDC
npx moltspay faucet                        # Base Sepolia
npx moltspay faucet --chain solana_devnet  # Solana devnet
npx moltspay faucet --chain bnb_testnet    # BNB testnet (+ gas)
npx moltspay faucet --chain tempo_moderato # Tempo testnet

# Discover services
npx moltspay services https://moltspay.com/a/zen7

# Pay for a service
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --prompt "a cat dancing"

# Pay on specific chain
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --chain polygon --prompt "a cat"
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --chain solana_devnet --prompt "a cat"
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --chain bnb_testnet --prompt "a cat"
```

### Python SDK

```python
from moltspay import MoltsPay

# Initialize (auto-creates wallet)
client = MoltsPay()                        # default: base
client = MoltsPay(chain="polygon")         # polygon mainnet
client = MoltsPay(chain="solana")          # solana mainnet
client = MoltsPay(chain="bnb")             # bnb mainnet
client = MoltsPay(chain="base_sepolia")    # testnet
client = MoltsPay(chain="solana_devnet")   # solana testnet
client = MoltsPay(chain="bnb_testnet")     # bnb testnet

# Wallet
print(client.address)
print(client.balance())

# Spending limits
client.set_limits(max_per_tx=10, max_per_day=100)

# Faucet (testnet only)
result = client.faucet()                           # Base Sepolia
result = client.faucet(chain="solana_devnet")      # Solana devnet
result = client.faucet(chain="bnb_testnet")        # BNB testnet

# Fund via QR code (debit card / Apple Pay)
client.fund_qr(amount=10, chain="base")

# Discover services
services = client.discover("https://moltspay.com/a/zen7")
for svc in services:
    print(f"{svc.name}: ${svc.price} (chains: {svc.chains})")

# Pay for service
result = client.pay(
    "https://moltspay.com/a/zen7",
    "text-to-video",
    prompt="a cat dancing"
)

if result.success:
    print(f"TX: {result.tx_hash}")
    print(f"Result: {result.result}")
else:
    print(f"Error: {result.error}")
```

### Web (Browser)

Available since `moltspay@1.6.0`. Connect any EIP-1193 wallet (MetaMask, Rainbow, …) or any `@solana/wallet-adapter` wallet (Phantom, Solflare, …). No private key is ever held in browser memory.

```ts
import {
  MoltsPayWebClient,
  eip1193Signer,
  solanaSigner,
  composeSigners,
  NeedsApprovalError,
} from 'moltspay/web';

// EVM only
const client = new MoltsPayWebClient({
  signer: eip1193Signer(window.ethereum),
});

// Solana only
const solClient = new MoltsPayWebClient({
  signer: solanaSigner(phantomAdapter),  // any Pick<WalletAdapter,'publicKey'|'signTransaction'>
});

// Both (pay on any chain from one instance)
const dualClient = new MoltsPayWebClient({
  signer: composeSigners(
    eip1193Signer(window.ethereum),
    solanaSigner(phantomAdapter),
  ),
  // Solana mainnet's public RPC 403s browsers; supply an authenticated URL.
  // Devnet is unaffected — omit `solana_devnet` to keep the default.
  solanaRpc: {
    solana: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
  },
});

// Discover + pay
const manifest = await client.getServices('https://provider.example.com');
const result = await client.pay(
  'https://provider.example.com',
  'text-to-video',
  { prompt: 'a cat dancing' },
  { chain: 'base' }
);

// BNB one-time approve flow
try {
  await client.pay(url, service, params, { chain: 'bnb' });
} catch (err) {
  if (err instanceof NeedsApprovalError) {
    await client.approveBnb({
      chain: 'bnb',
      spender: err.details.spender,
      token: err.details.token,
    });
    await client.pay(url, service, params, { chain: 'bnb' });  // retry
  }
}
```

**Chains.** Same 8 chains as the CLI (`base`, `polygon`, `base_sepolia`, `tempo_moderato`, `bnb`, `bnb_testnet`, `solana`, `solana_devnet`). Tempo uses EIP-2612 permit in the browser; MPP stays CLI-only.

**Provider requirement.** Server operators must enable `cors` on `MoltsPayServer` for browser callers — without it the 402 challenge header is invisible to `fetch`. `moltspay.com/a/*` providers are already CORS-enabled.

**Runnable reference:** `examples/web/` (React + Vite). `cd examples/web && npm install && npm run dev`.

## Supported Chains

| Chain | Type | Facilitator | Gas |
|-------|------|-------------|-----|
| base | mainnet | CDP | Gasless |
| polygon | mainnet | CDP | Gasless |
| solana | mainnet | Solana | ~$0.001 SOL |
| bnb | mainnet | BNB | Sponsored |
| base_sepolia | testnet | CDP | Gasless |
| solana_devnet | testnet | Solana | Free |
| bnb_testnet | testnet | BNB | Sponsored |
| tempo_moderato | testnet | Tempo | Gas-free |

**Notes:**
- Ethereum NOT supported (gas too expensive)
- Solana uses separate ed25519 wallet (auto-created on init)
- BNB faucet includes tBNB for gas

## Common Tasks

**User wants to generate a video:**
1. Check wallet: `npx moltspay status` or `client.balance()`
2. If no balance: `npx moltspay fund` or `client.fund_qr(10, "base")`
3. Pay: `npx moltspay pay <url> text-to-video --prompt "..."` or `client.pay(...)`

**User asks about balance:**
- CLI: `npx moltspay status` (shows all chains)
- Python: `client.balance()`

**User wants testnet:**
- Base Sepolia: `npx moltspay faucet` then `--chain base_sepolia`
- Solana devnet: `npx moltspay faucet --chain solana_devnet` then `--chain solana_devnet`
- BNB testnet: `npx moltspay faucet --chain bnb_testnet` then `--chain bnb_testnet`
- Tempo: `npx moltspay faucet --chain tempo_moderato` then `--chain tempo_moderato`

**User wants Solana:**
- Solana wallet is auto-created with `npx moltspay init`
- Stored separately at `~/.moltspay/wallet-solana.json`
- Use `--chain solana` or `--chain solana_devnet`

**User wants BNB:**
- Uses same EVM wallet as Base/Polygon
- Faucet gives USDC + tBNB for gas
- Use `--chain bnb` or `--chain bnb_testnet`

## Common Errors

| Error | Fix |
|-------|-----|
| insufficient_balance | Fund wallet: `npx moltspay fund` or `client.fund_qr()` |
| already_claimed | Faucet limit - wait 24 hours |
| unsupported_chain | Check service's supported chains in `.well-known/agent-services.json` |
| insufficient_sol | Need SOL for Solana gas: fund wallet with ~0.01 SOL |
| insufficient_bnb | Need BNB for gas: use faucet (includes tBNB) or fund wallet |
| no_solana_wallet | Run `npx moltspay init` to create Solana wallet |
| `NEEDS_APPROVAL` (web only) | BNB first payment — call `client.approveBnb({...err.details})` once, then retry `pay()` |
| `PAYMENT_REJECTED` (web only) | User dismissed the wallet prompt — surface the error, let them retry |
| CORS error in browser console | Provider must set `cors: true` on `MoltsPayServer` |

## Links

- Full docs: https://moltspay.com/llms.txt
- Playground: https://moltspay.com/creators/playground
- npm: https://npmjs.com/package/moltspay
- PyPI: https://pypi.org/project/moltspay
