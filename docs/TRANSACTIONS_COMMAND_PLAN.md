# Plan: Unified `moltspay transactions` Command

## Goal

Combine on-chain USDC transfers and x402 service purchases into one unified command.

---

## Data Sources

| Source | What it shows | Speed | Notes |
|--------|--------------|-------|-------|
| Blockscout API | On-chain USDC transfers (in/out) | Fast | ~30 min indexing delay |
| MoltsPay Creators DB | x402 service purchases (orders) | Instant | Local database |

---

## Command Design

```bash
npx moltspay transactions [options]

Options:
  --days <n>        Days to look back (default: 7)
  --chain <chain>   base, polygon, or all (default: all)
  --limit <n>       Max transactions (default: 20)
  --db <path>       Path to MoltsPay Creators DB (optional)
  --source <src>    onchain, db, or all (default: all)
  --json            Output as JSON
```

---

## Output Format

### Default (grouped by source):

```
[SCROLL] Transactions (last 7 days)

ON-CHAIN:
  +$4.88 USDC | [BASE] from 0xd86cAdB4... | 03-13 02:43
  -$0.99 USDC | [BASE] to 0xb8d6f244...   | 03-12 17:45
  +$1.00 USDC | [POLYGON] from 0xD94D14... | 03-12 02:02

SERVICES (x402):
  03-12 17:45 | delivered | $0.99 | text-to-video | "give me cat"
  03-12 02:20 | delivered | $0.99 | text-to-video | "polygon test"
  03-11 22:14 | delivered | $0.99 | text-to-video | "test"

[STATS] Summary:
   On-chain: +$5.88 in, -$0.99 out
   Services: 48 delivered, $5.98 spent
```

### Alternative (chronological with icons):

```
[SCROLL] Transactions (last 7 days)

  [CHAIN]  +$4.88 USDC | [BASE] from 0xd86cAdB4... | 03-13 02:43
  [PKG] -$0.99 USDC | text-to-video | "give me cat" | 03-12 17:45
  [CHAIN]  +$1.00 USDC | [POLYGON] from 0xD94D14... | 03-12 02:02
  [PKG] -$0.99 USDC | text-to-video | "polygon test" | 03-12 02:20

[STATS] 20 transactions | +$5.88 in | -$6.97 out
```

---

## Implementation Phases

### Phase 1: Rename & Consolidate
- Rename `list` command to `transactions`
- Add `list` as alias for backward compatibility
- Keep existing Blockscout API logic for on-chain data

### Phase 2: Add Database Integration
- Add `--db` option to specify DB path
- Query `transactions` table:
  ```sql
  SELECT * FROM transactions 
  WHERE buyer_address = ? 
  ORDER BY created_at DESC
  ```
- Extract: timestamp, status, amount, service_id, prompt, tx_hash

### Phase 3: Deduplication
- x402 payments create BOTH a DB record AND an on-chain transfer
- Match by `tx_hash` to identify service payments
- Classification:
  - Has matching tx_hash in DB -> "service payment"
  - Only on-chain -> "direct transfer"
  - Only in DB (no tx_hash) -> "pending/failed service"

### Phase 4: Unified Display
- Merge both sources into single list
- Sort by timestamp (descending)
- Apply limit after merge
- Color coding:
  - Green: incoming
  - Red: outgoing
  - Blue/Purple: service payment

### Phase 5: Auto-detect DB (optional enhancement)
- If `--db auto` or no `--db` specified:
  - Check `$MOLTSPAY_DB` env var
  - Check `~/clawd/projects/moltspay-creators/data/creators.db`
  - Check `./data/creators.db`
  - Check `./creators.db`
- If found, include DB data automatically
- If not found, silently continue with on-chain only

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No `--db` specified | On-chain only |
| `--db` path not found | Warn and continue with on-chain only |
| Wallet not in DB | No service transactions, on-chain only |
| Same tx in both sources | Show once, mark as service payment |
| DB query fails | Warn and continue with on-chain only |
| Blockscout API fails | Warn and show DB only (if available) |

---

## JSON Output Format

```json
{
  "wallet": "0xEBB45208D806A0c73F9673E0c5713FF720DD6b79",
  "period": "7 days",
  "transactions": [
    {
      "source": "onchain",
      "chain": "base",
      "type": "in",
      "amount": 4.88,
      "currency": "USDC",
      "counterparty": "0xd86cAdB4...",
      "timestamp": "2026-03-13T02:43:00Z",
      "txHash": "0xedf3f557..."
    },
    {
      "source": "service",
      "chain": "base",
      "type": "out",
      "amount": 0.99,
      "currency": "USDC",
      "service": "text-to-video",
      "prompt": "give me cat",
      "status": "delivered",
      "timestamp": "2026-03-12T17:45:00Z",
      "txHash": "0x4f8d6982..."
    }
  ],
  "summary": {
    "onchain": { "in": 5.88, "out": 0.99 },
    "services": { "count": 48, "spent": 5.98 }
  }
}
```

---

## Open Questions

### 1. Display format preference?
- **Option A**: Grouped (ON-CHAIN section + SERVICES section)
- **Option B**: Single chronological list with type icons

### 2. Default DB behavior?
- **Option A**: On-chain only unless `--db` explicitly specified
- **Option B**: Auto-detect and include DB if found

### 3. Keep `list` alias?
- **Option A**: Yes, `moltspay list` = `moltspay transactions`
- **Option B**: No, deprecate `list` with warning message

### 4. Service payment deduplication?
- **Option A**: Show as single "service payment" entry
- **Option B**: Show both with visual link (e.g., indented)

---

## Dependencies

- `better-sqlite3` - for DB queries (already in project)
- Blockscout API - no API key needed
- No new dependencies required

---

## Estimated Effort

| Phase | Effort |
|-------|--------|
| Phase 1: Rename | 15 min |
| Phase 2: DB integration | 30 min |
| Phase 3: Deduplication | 20 min |
| Phase 4: Display | 20 min |
| Phase 5: Auto-detect | 15 min |
| **Total** | **~2 hours** |

---

## Notes

- Current `moltspay list` uses Blockscout API (fast, free, no API key)
- Basescan V1 API is deprecated (returns error)
- Blockscout has ~30 min indexing delay for very recent transactions
- Consider adding RPC fallback for last 5 min if real-time needed
