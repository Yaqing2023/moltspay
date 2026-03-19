# MoltsPay - AI Agent Instructions

MoltsPay enables AI agents to pay for services using USDC. Gasless, multi-chain (Base, Polygon).

## Quick Reference

### Node.js CLI

```bash
# Install
npm install moltspay

# Initialize wallet (one time, no --chain flag needed)
npx moltspay init

# Check balance
npx moltspay status

# Get free testnet USDC (base_sepolia only)
npx moltspay faucet

# Discover services
npx moltspay services https://moltspay.com/a/zen7

# Pay for a service
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --prompt "a cat dancing"

# Pay on specific chain
npx moltspay pay https://moltspay.com/a/zen7 text-to-video --chain polygon --prompt "a cat"
```

### Python SDK

```python
from moltspay import MoltsPay

# Initialize (auto-creates wallet)
client = MoltsPay()                        # default: base
client = MoltsPay(chain="polygon")         # polygon mainnet
client = MoltsPay(chain="base_sepolia")    # testnet

# Wallet
print(client.address)
print(client.balance())

# Spending limits
client.set_limits(max_per_tx=10, max_per_day=100)

# Faucet (testnet only)
result = client.faucet()

# Fund via QR code (debit card / Apple Pay)
client.fund_qr(amount=10, chain="base")

# Discover services
services = client.discover("https://moltspay.com/a/zen7")
for svc in services:
    print(f"{svc.name}: ${svc.price} (chains: {svc.chains})")

# Pay for service
result = client.pay(
    "https://moltspay.com/a/zen7",
    "b23c6959-605f-49ff-98de-aea28705d386",  # service UUID
    prompt="a cat dancing"
)

if result.success:
    print(f"TX: {result.tx_hash}")
    print(f"Result: {result.result}")
else:
    print(f"Error: {result.error}")
```

## Supported Chains

| Chain | Type | Use |
|-------|------|-----|
| base | mainnet | Production |
| polygon | mainnet | Production |
| base_sepolia | testnet | Testing (free USDC via faucet) |

Ethereum NOT supported (gas too expensive).

## Common Tasks

**User wants to generate a video:**
1. Check wallet: `npx moltspay status` or `client.balance()`
2. If no balance: `npx moltspay fund` or `client.fund_qr(10, "base")`
3. Pay: `npx moltspay pay <url> text-to-video --prompt "..."` or `client.pay(...)`

**User asks about balance:**
- CLI: `npx moltspay status`
- Python: `client.balance()`

**User wants testnet:**
- CLI: `npx moltspay faucet` then use `--chain base_sepolia`
- Python: `MoltsPay(chain="base_sepolia")` then `client.faucet()`

## Common Errors

| Error | Fix |
|-------|-----|
| insufficient_balance | Fund wallet: `npx moltspay fund` or `client.fund_qr()` |
| already_claimed | Faucet limit - wait 24 hours |
| unsupported_chain | Check service's supported chains |

## Links

- Full docs: https://moltspay.com/llms.txt
- Playground: https://moltspay.com/creators/playground
- npm: https://npmjs.com/package/moltspay
- PyPI: https://pypi.org/project/moltspay
