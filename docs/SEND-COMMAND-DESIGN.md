# CLI `send` Command — Design

> **Target**: `moltspay@2.4.0`
> **Status**: Proposed (2026-07-12)
> **Scope**: Expose the existing SDK `Wallet.transfer()` as a CLI command so CLI/skill users can send USDC/USDT out of their MoltsPay wallet to any address (e.g. an exchange deposit address). EVM chains only in v1.

## 1. Motivation

The SDK already has `Wallet.transfer(to, amount, token)` — a standard on-chain ERC20 transfer to an arbitrary address (`src/wallet/Wallet.ts`). The CLI never exposed it, so a CLI/skill user has no way to move funds out of the wallet (e.g. "transfer USDC from MoltsPay to Binance"). The only workaround today is exporting the private key from `~/.moltspay/wallet.json` into a third-party wallet — poor UX and a key-handling hazard.

This adds a thin CLI command wrapping the existing SDK method. No new payment logic; it surfaces a capability that already exists.

## 2. Command specification

```
moltspay transfer <to> <amount> [options]
```

| Arg / option | Required | Description |
|---|---|---|
| `<to>` | yes | Destination address (EVM `0x...`). Validated via `ethers.getAddress` (checksum). |
| `<amount>` | yes | Amount to send, decimal (e.g. `5` or `5.25`). |
| `--token <USDC\|USDT>` | — | Token to send. Default `USDC`. |
| `--chain <chain>` | — | EVM chain to send on: `base` (default), `polygon`, `bnb`, `base_sepolia`, `bnb_testnet`, `tempo_moderato`. |
| `--yes` | — | Skip the confirmation prompt (for scripts/agents). |
| `--json` | — | Output raw JSON only. |
| `--config-dir <dir>` | — | Config directory with `wallet.json` (default `~/.moltspay`). |

Examples:
```bash
# Send 5 USDC on Base to an exchange deposit address (interactive confirm)
moltspay transfer 0xBinanceDepositAddr... 5

# Send 10 USDT on BNB Chain, no prompt (agent/script)
moltspay transfer 0x... 10 --token USDT --chain bnb --yes
```

## 3. Behavior / flow

```
1. Load wallet (private key) from --config-dir; error if not initialized.
2. Resolve chain (--chain, default base) and token (--token, default USDC).
3. Validate <to> (ethers.getAddress) and <amount> (> 0, <= 2 places is NOT required;
   ERC20 has 6 decimals for USDC/USDT — allow up to 6dp).
4. Preflight (read-only):
   - token balance >= amount  (else fail with the shortfall)
   - native gas balance > 0    (warn/estimate; a plain transfer needs gas)
5. Show a summary and ask to confirm (unless --yes / --json):
      Send 5 USDC on Base
      From: 0xabc...  To: 0xdef...
      Network: Base (chain id 8453)   Gas token: ETH
      Type "yes" to confirm:
6. Call wallet.transfer(to, amount, token) on the chosen chain.
7. Print the result: tx hash + explorer URL (+ gas used).
```

## 4. Chain & token scope

- **EVM only in v1** — `Wallet.transfer()` is an ethers ERC20 transfer. Supported chains come from `src/chains` (`CHAINS`): `base`, `polygon`, `bnb`, `base_sepolia`, `bnb_testnet`, `tempo_moderato`. Tokens: `USDC`, `USDT` (6 decimals).
- **Solana out of scope for v1** — the Solana wallet is a separate keypair (`loadSolanaWallet`) with a separate SPL transfer path. If `--chain solana*` is given, fail with a clear "Solana send is not supported yet; use --chain <evm>".
- The wallet is constructed for the chosen chain (`new Wallet({ chain, privateKey })`), mirroring how `status` builds a per-chain provider today.

## 5. Safety

This command moves real funds irreversibly — treat it accordingly.

1. **Address checksum validation** — `ethers.getAddress(to)` rejects malformed / bad-checksum addresses before sending.
2. **Balance preflight** — refuse if token balance < amount (report the shortfall), so we don't broadcast a doomed tx.
3. **Gas awareness** — a plain transfer is NOT gasless (unlike x402 pay). Preflight the native balance; if it's zero, fail with "no gas: fund a little ETH/BNB/POL on <chain>". (BNB first-tx nuance already handled elsewhere in the CLI.)
4. **Confirmation prompt** — interactive by default; `--yes` to bypass for agents/scripts. `--json` implies non-interactive.
5. **Network-mismatch guidance** — the summary names the network explicitly (e.g. "Network: Base") so the user can match it to the exchange's deposit network. Copy in the success output: "make sure the receiving side expects <token> on <network>".
6. **No key exposure** — the private key stays in `wallet.json`; the command never prints it.

## 6. Output

Success (human):
```
✅ Sent 5 USDC on Base
   From: 0xabc…   To: 0xdef…
   Tx:   0x1234…   (https://basescan.org/tx/0x1234…)
   Gas:  0.0000123 ETH
   ⚠️  Ensure the receiver expects USDC on Base.
```

Success (`--json`): the `TransferResult` verbatim —
```json
{ "success": true, "tx_hash": "0x…", "from": "0x…", "to": "0x…",
  "amount": 5, "token": "USDC", "gas_used": 12345, "block_number": 987654,
  "explorer_url": "https://basescan.org/tx/0x…" }
```

Failure: `{ "success": false, "error": "<reason>" }` and a non-zero exit code.

## 7. Implementation plan

| Step | File | Change |
|---|---|---|
| 1 | `src/cli/index.ts` | Add the `send <to> <amount>` command (commander): parse args/options, load wallet, preflight, confirm, call transfer, format output. Reuse the existing `CHANGE[chain]` / provider pattern used by `status`. |
| 2 | `src/wallet/Wallet.ts` | No change — `transfer()` already returns `TransferResult`. (Confirm it validates `to` and checks balance — it does.) |
| 3 | Wallet construction | Build `new Wallet({ chain, privateKey })` for the chosen chain (private key from the loaded `wallet.json`), matching existing per-chain construction. |
| 4 | Tests | `test/cli` (or a unit around the send action): address validation rejects bad input; insufficient balance fails preflight; Solana chain rejected; `--json` shape; a mocked-provider success path. |
| 5 | Docs | `README.md` (wallet section: a "Send / withdraw" subsection); `CHANGELOG.md` [2.4.0]; skill `SKILL.md` (a `send` command row + a "withdraw to an exchange" FAQ). |

Verification gate: `typecheck` + tests; a dry `send --help` shows the command; a testnet send (`--chain base_sepolia`) lands on-chain.

## 8. Errors (surface, don't leak)

| Case | Message |
|---|---|
| Wallet not initialized | `Wallet not initialized. Run: moltspay init` |
| Bad address | `Invalid destination address: <to>` |
| Amount ≤ 0 / malformed | `Invalid amount: must be a positive number` |
| Insufficient token balance | `Insufficient USDC on base: have X, need Y` |
| No gas | `No gas on base: fund a little ETH to cover the transfer` |
| Solana chain | `Solana send is not supported yet; use --chain base|polygon|bnb` |
| Tx reverted | `Transfer failed (tx 0x…): reverted` |

## 9. Out of scope (later)

- Solana / SPL send (`--chain solana`).
- Native-coin send (ETH/BNB itself), non-USDC/USDT tokens.
- Address book / ENS resolution.
- Batch send, scheduled send.
- A gasless withdrawal (would need a relayer/paymaster; the point of `send` is a plain transfer).

---
*Authored 2026-07-12. Wraps the existing `Wallet.transfer()`; EVM USDC/USDT in v1.*
