# MoltsPay MCP Server

A Model Context Protocol server that lets any MCP-compatible AI assistant
(Claude Desktop, Cursor, Windsurf, etc.) browse MoltsPay services, check
wallet status, and pay for x402 services on your behalf.

It is a thin wrapper around the existing `MoltsPayClient`. Wallet custody,
spending limits, multi-chain support, and all payment protocols (x402,
MPP, Solana, BNB) are handled by the SDK.

## Prerequisites

Create a wallet first with the existing CLI:

```bash
moltspay init
```

This writes `~/.moltspay/wallet.json`, `config.json`, and
`wallet-solana.json`. The MCP server refuses to start if the wallet is
missing.

Set spending limits you're comfortable letting an AI agent spend
autonomously:

```bash
moltspay config --max-per-tx 2 --max-per-day 10
```

Fund the wallet with real USDC (`moltspay fund 5`) or grab testnet
USDC (`moltspay faucet`) before trying `moltspay_pay`.

## Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "moltspay": {
      "command": "npx",
      "args": ["-y", "moltspay-mcp"]
    }
  }
}
```

For a safer first run, enable dry-run — `moltspay_pay` will preview the
request without signing or spending anything:

```json
{
  "mcpServers": {
    "moltspay": {
      "command": "npx",
      "args": ["-y", "moltspay-mcp", "--dry-run"]
    }
  }
}
```

Restart Claude Desktop, then ask: *"Check my MoltsPay balance."*

## Cursor / Windsurf / other MCP hosts

Point the host at the `moltspay-mcp` binary over stdio. Same command, same
arguments.

## Tools

| Tool | What it does | Destructive? |
|---|---|---|
| `moltspay_status` | Wallet address, balances across all supported chains, spending limits | No |
| `moltspay_services` | Fetch services manifest from a provider URL; optional `query`/`maxPrice` filter | No |
| `moltspay_pay` | Execute an x402/MPP/SOL/BNB payment and return the service result | **Yes** |
| `moltspay_config` | Read or update `maxPerTx` / `maxPerDay` limits | Updates config file |

### moltspay_pay arguments

```ts
{
  url: string;           // Provider base URL, e.g. https://moltspay.com/a/zen7
  service: string;       // Service id from moltspay_services
  params: object;        // Service params (wrapped in { params } unless rawData: true)
  chain?: "base" | "polygon" | "base_sepolia" | "bnb" | "bnb_testnet"
         | "solana" | "solana_devnet" | "tempo_moderato";
  token?: "USDC" | "USDT";
  rawData?: boolean;     // For services with non-standard input shapes
  confirmed?: boolean;   // Required when MOLTSPAY_MCP_REQUIRE_CONFIRM=1 and amount > maxPerTx/10
}
```

## Safety layers

`moltspay_pay` is the only tool that moves money. Three guards stack on
top of the MCP host's own tool-approval prompt:

1. **SDK spending limits.** `MoltsPayClient.pay()` enforces `maxPerTx`
   and `maxPerDay` server-side before signing. Configured via
   `moltspay_config` or `moltspay config`.
2. **Dry-run mode.** Start the server with `--dry-run` and
   `moltspay_pay` returns the intended payment without signing. Good
   for first-time setup and demos.
3. **Confirmation gate.** Set `MOLTSPAY_MCP_REQUIRE_CONFIRM=1` in the
   MCP host's env for the server. Any payment whose service price
   exceeds `maxPerTx / 10` then requires the AI to pass
   `confirmed: true`, forcing a second tool call the user can refuse.

None of the tools expose the private key or mnemonic. Wallet creation is
intentionally not an MCP tool — use `moltspay init`.

## Troubleshooting

**"MoltsPay wallet not found."** — Run `moltspay init` before
launching the MCP server. Check that `~/.moltspay/wallet.json` exists.

**"Server accepts: base_sepolia, polygon — please specify: --chain …"** —
The provider accepts multiple chains. Pass `chain` explicitly in
`moltspay_pay` arguments.

**"Per-tx limit exceeded."** — Increase `maxPerTx` via `moltspay_config`,
or pick a cheaper service.

**Stdout corruption / host can't parse responses.** — Never write to
stdout from the MCP server process; all logs go to stderr. If you're
forking this server, keep `console.log` away from tool handlers.

## Related

- `docs/MCP-SERVER-DESIGN.md` — original design doc, including the
  Cloudflare Worker hosted variant (not yet implemented).
- `src/mcp/server.ts` — tool definitions.
- `src/client/index.ts` — underlying `MoltsPayClient`.
