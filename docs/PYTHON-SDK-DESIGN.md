# MoltsPay Python SDK Design

## Overview

Python SDK for MoltsPay, focused on **client-side** functionality (paying for services). Server-side remains Node.js.

**Package name:** `moltspay`
**PyPI:** `pip install moltspay`

---

## Goals

1. Python developers can pay for agent services
2. Share wallet with Node.js CLI (`~/.moltspay/wallet.json`)
3. Minimal dependencies
4. Async-first (with sync wrapper)

---

## Non-Goals

1. Server-side payment receiving (use Node.js)
2. Smart contract deployment

---

## API Design

### Installation

```bash
pip install moltspay
```

### Basic Usage

```python
from moltspay import MoltsPay

# Initialize - auto-creates wallet if not exists
client = MoltsPay()
# Checks ~/.moltspay/wallet.json
# If exists -> load it
# If not -> create new wallet automatically

# Or specify custom path
client = MoltsPay(wallet_path="~/my-agent/wallet.json")

# Or provide private key directly
client = MoltsPay(private_key="0x...")

# Pay for a service
result = client.pay(
    service_url="https://juai8.com/zen7",
    service_id="text-to-video",
    prompt="a cat dancing on the beach"
)

print(result)
# {"video_url": "https://...", "duration": 5}
```

### Async Usage

```python
import asyncio
from moltspay import AsyncMoltsPay

async def main():
    client = AsyncMoltsPay()
    
    result = await client.pay(
        "https://juai8.com/zen7",
        "text-to-video",
        prompt="a cat dancing"
    )
    print(result)

asyncio.run(main())
```

### Service Discovery

```python
# List available services
services = client.discover("https://juai8.com/zen7")

for svc in services:
    print(f"{svc.id}: {svc.price} {svc.currency}")
    # text-to-video: 0.99 USDC
    # image-to-video: 1.49 USDC
```

### Check Balance

```python
balance = client.balance()
print(f"USDC: {balance.usdc}")
print(f"Address: {balance.address}")
```

### Wallet Auto-Creation

```python
from moltspay import MoltsPay

# First run - creates new wallet
client = MoltsPay()
print(f"New wallet created: {client.address}")
# Wallet saved to ~/.moltspay/wallet.json

# Second run - loads existing wallet
client = MoltsPay()
print(f"Loaded wallet: {client.address}")
# Same address as before
```

**Auto-creation flow:**
1. Check if `~/.moltspay/wallet.json` exists
2. If yes -> load and validate
3. If no -> generate new keypair, save to file
4. Return initialized client

**Wallet file is compatible with Node.js CLI** - same format, same location.

### Spending Limits

```python
# Check limits
limits = client.limits()
print(f"Max per tx: {limits.max_per_tx}")
print(f"Max per day: {limits.max_per_day}")
print(f"Spent today: {limits.spent_today}")

# Limits are set via CLI (npx moltspay config)
```

---

## Architecture

```
+----------------------------------------------------------------------------------------------------------------------+
|                    Python SDK                           |
+--------------------------------------------------------------------------------------------------------------------|
|  MoltsPay / AsyncMoltsPay                               |
|    +------ discover(url) -> List[Service]                   |
|    +------ pay(url, service_id, **params) -> Result         |
|    +------ balance() -> Balance                              |
|    +------ limits() -> Limits                                |
+--------------------------------------------------------------------------------------------------------------------|
|  x402 Client                                            |
|    +------ Request service                                  |
|    +------ Parse 402 response                               |
|    +------ Sign permit (EIP-712)                            |
|    +------ Retry with payment header                        |
+--------------------------------------------------------------------------------------------------------------------|
|  Wallet                                                 |
|    +------ Load from ~/.moltspay/wallet.json               |
|    +------ Sign messages (eth_account)                      |
|    +------ Check spending limits                            |
+----------------------------------------------------------------------------------------------------------------------+
```

---

## Dependencies

```toml
[project]
dependencies = [
    "httpx>=0.24",        # HTTP client (async support)
    "eth-account>=0.9",   # Wallet signing
    "pydantic>=2.0",      # Data validation
]
```

**Why these:**
- `httpx`: Modern async HTTP, similar API to requests
- `eth-account`: Ethereum signing without heavy web3.py
- `pydantic`: Clean data models, good DX

**Total size:** ~5MB (lightweight)

---

## Wallet File Format

Shared with Node.js CLI:

```json
{
  "address": "0x...",
  "privateKey": "0x...",
  "chain": "base",
  "limits": {
    "maxPerTx": 10,
    "maxPerDay": 100
  },
  "spending": {
    "today": "2026-03-06",
    "amount": 5.50
  }
}
```

Python SDK reads this file, does NOT write (except spending tracking).

---

## x402 Protocol Flow

```
1. Client: GET /services
   Server: 200 OK [{id, price, currency}]

2. Client: POST /service-id {params}
   Server: 402 Payment Required
           X-Payment-Required: {"amount": "0.99", "currency": "USDC", "payTo": "0x..."}

3. Client: Sign EIP-712 permit
           POST /service-id {params}
           X-Payment: {permit signature}
   
4. Server: Verify permit, settle via CDP, execute service
           200 OK {result}
```

---

## Error Handling

```python
from moltspay import MoltsPay, PaymentError, InsufficientFunds, LimitExceeded

client = MoltsPay()

try:
    result = client.pay(...)
except InsufficientFunds as e:
    print(f"Need {e.required} USDC, have {e.balance}")
except LimitExceeded as e:
    print(f"Would exceed {e.limit_type}: {e.limit} USDC")
except PaymentError as e:
    print(f"Payment failed: {e.message}")
```

---

## CLI Compatibility

**Option A: Python-first (no Node.js needed)**
```python
from moltspay import MoltsPay

# Auto-creates wallet on first run
client = MoltsPay()
print(client.address)  # New wallet created

# Set limits
client.set_limits(max_per_tx=10, max_per_day=100)
```

**Option B: Use existing Node.js wallet**
```bash
# If you already have a wallet from Node CLI
npx moltspay init --chain base
npx moltspay config --max-per-tx 10
```

```python
# Python loads the same wallet
from moltspay import MoltsPay
client = MoltsPay()  # Loads ~/.moltspay/wallet.json
```

**Wallet file format is identical** - either tool can create/read it.

---

## Project Structure

```
moltspay-python/
+------ pyproject.toml
+------ README.md
+------ src/
|   +------ moltspay/
|       +------ __init__.py
|       +------ client.py        # MoltsPay, AsyncMoltsPay
|       +------ wallet.py        # Wallet loading, signing
|       +------ x402.py          # x402 protocol implementation
|       +------ models.py        # Pydantic models
|       +------ exceptions.py    # Custom exceptions
+------ tests/
    +------ test_client.py
    +------ test_wallet.py
    +------ test_x402.py
```

---

## Example: Agent Integration

```python
# In your agent's skill
from moltspay import MoltsPay

client = MoltsPay()

def generate_video(prompt: str) -> str:
    """Generate a video using Zen7 service."""
    
    # Check if we can afford it
    if client.balance().usdc < 1.0:
        raise Exception("Insufficient funds for video generation")
    
    # Pay and get result
    result = client.pay(
        "https://juai8.com/zen7",
        "text-to-video",
        prompt=prompt
    )
    
    return result["video_url"]
```

---

## Timeline

| Phase | Task | Days |
|-------|------|------|
| 1 | Project setup, models | 1 |
| 2 | Wallet loading, signing | 1 |
| 3 | x402 client implementation | 2 |
| 4 | MoltsPay class, discovery | 1 |
| 5 | Tests, documentation | 1 |
| 6 | PyPI publish | 0.5 |
| **Total** | | **~7 days** |

---

## Open Questions

1. **Sync vs Async default?**
   - Proposal: Sync by default (`MoltsPay`), async opt-in (`AsyncMoltsPay`)

2. **Support other chains?**
   - Proposal: Base only initially. Match Node.js CLI.

3. **Package name conflict?**
   - Need to check if `moltspay` is available on PyPI

## Resolved

1. ~~**Wallet creation in Python?**~~
   - [OK] Yes. Auto-create if not exists. Compatible with Node.js CLI wallet format.

---

## Success Metrics

- PyPI downloads
- GitHub stars on python repo
- Issues/PRs from Python users
- Usage in popular agent frameworks (LangChain, AutoGPT, etc.)

---

*Last updated: 2026-03-06*
