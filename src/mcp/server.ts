/**
 * MoltsPay MCP Server — wraps MoltsPayClient as MCP tools so AI
 * assistants can browse services, check wallet status, and pay for
 * x402 services. Wallet custody is delegated to MoltsPayClient, which
 * reads ~/.moltspay/.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { MoltsPayClient, type PayOptions } from '../client/index.js';
import { CHAINS } from '../chains/index.js';
import { SOLANA_CHAINS } from '../chains/solana.js';
import type { ChainName, TokenSymbol } from '../types/index.js';

const CHAIN_NAMES = [
  ...Object.keys(CHAINS),
  ...Object.keys(SOLANA_CHAINS),
] as [ChainName, ...ChainName[]];

const TOKEN_SYMBOLS = ['USDC', 'USDT'] as [TokenSymbol, ...TokenSymbol[]];

export interface MoltsPayMcpOptions {
  /** Dry-run: moltspay_pay returns payment requirements without signing. */
  dryRun?: boolean;
  /** Override ~/.moltspay config directory (mainly for tests). */
  configDir?: string;
}

function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function err(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Error: ${message}` }],
  };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type ToolHandler<A> = (args: A) => Promise<CallToolResult>;

function wrap<A>(fn: ToolHandler<A>): ToolHandler<A> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return err(errorMessage(e));
    }
  };
}

function getPackageVersion(): string {
  const candidates = [
    join(__dirname, '../../package.json'),
    join(__dirname, '../package.json'),
    join(process.cwd(), 'node_modules/moltspay/package.json'),
  ];
  for (const loc of candidates) {
    try {
      if (existsSync(loc)) {
        const pkg = JSON.parse(readFileSync(loc, 'utf-8'));
        if (pkg.name === 'moltspay') return pkg.version;
      }
    } catch {
      /* ignored */
    }
  }
  return '0.0.0';
}

export function createMoltsPayMcpServer(options: MoltsPayMcpOptions = {}): McpServer {
  const client = new MoltsPayClient({ configDir: options.configDir });

  if (!client.isInitialized) {
    throw new Error(
      'MoltsPay wallet not found. Run `moltspay init` before starting the MCP server.'
    );
  }

  const dryRun = options.dryRun === true;
  const requireConfirm = process.env.MOLTSPAY_MCP_REQUIRE_CONFIRM === '1';

  const server = new McpServer({
    name: 'moltspay',
    version: getPackageVersion(),
  });

  server.registerTool(
    'moltspay_status',
    {
      title: 'Wallet Status',
      description:
        'Return the MoltsPay wallet address, balances across all supported chains, and current spending limits.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async () => {
      const config = client.getConfig();
      const balances = await client.getAllBalances();
      return ok({
        address: client.address,
        defaultChain: config.chain,
        balances,
        limits: config.limits,
      });
    })
  );

  server.registerTool(
    'moltspay_services',
    {
      title: 'List Provider Services',
      description:
        'Fetch the services manifest from a MoltsPay provider URL (e.g. https://moltspay.com/a/zen7). Returns service IDs, prices, input schemas, and accepted chains.',
      inputSchema: {
        url: z.url().describe('Provider base URL.'),
        maxPrice: z
          .number()
          .positive()
          .optional()
          .describe('Only return services priced at or below this amount.'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring match on service id / name / description.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(async ({ url, maxPrice, query }) => {
      const res = await client.getServices(url);
      let services = res.services ?? [];

      if (typeof maxPrice === 'number') {
        services = services.filter((s) => typeof s.price !== 'number' || s.price <= maxPrice);
      }
      if (query) {
        const q = query.toLowerCase();
        services = services.filter((s) =>
          [s.id, s.name, s.description].some((f) => f?.toLowerCase().includes(q))
        );
      }

      return ok({ provider: res.provider, services });
    })
  );

  server.registerTool(
    'moltspay_pay',
    {
      title: 'Pay For Service',
      description:
        'Execute an x402/MPP/SOL/BNB payment and call a provider service. Honors SDK-level spending limits. When MOLTSPAY_MCP_REQUIRE_CONFIRM=1, the caller must pass confirmed: true.',
      inputSchema: {
        url: z.url().describe('Provider base URL.'),
        service: z.string().min(1).describe('Service id from moltspay_services.'),
        params: z
          .record(z.string(), z.unknown())
          .describe('Service parameters. Wrapped as { params } unless rawData is true.'),
        chain: z
          .enum(CHAIN_NAMES)
          .optional()
          .describe('Chain to pay on. Required unless the provider only accepts one chain.'),
        token: z.enum(TOKEN_SYMBOLS).optional().describe('Token symbol. Default USDC.'),
        rawData: z
          .boolean()
          .optional()
          .describe('Send params at top level instead of wrapped in { params }.'),
        confirmed: z
          .boolean()
          .optional()
          .describe('Required when MOLTSPAY_MCP_REQUIRE_CONFIRM=1 is set on the server.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    wrap(async ({ url, service, params, chain, token, rawData, confirmed }) => {
      if (dryRun) {
        return ok({
          dryRun: true,
          message:
            'Dry-run mode: no payment will be executed. Inspect moltspay_services for prices.',
          intent: { url, service, params, chain, token, rawData },
        });
      }

      if (requireConfirm && confirmed !== true) {
        return err(
          'Confirmation required: server was started with MOLTSPAY_MCP_REQUIRE_CONFIRM=1. Re-call with confirmed: true after reviewing the price via moltspay_services.'
        );
      }

      const result = await client.pay(url, service, params, { chain, token, rawData } as PayOptions);
      return ok({ success: true, result });
    })
  );

  server.registerTool(
    'moltspay_config',
    {
      title: 'Wallet Config',
      description:
        'Read or update MoltsPay wallet spending limits (maxPerTx, maxPerDay). Pass no arguments to read.',
      inputSchema: {
        maxPerTx: z.number().positive().optional().describe('New per-transaction USD limit.'),
        maxPerDay: z.number().positive().optional().describe('New daily USD limit.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    wrap(async ({ maxPerTx, maxPerDay }) => {
      if (maxPerTx !== undefined || maxPerDay !== undefined) {
        client.updateConfig({ maxPerTx, maxPerDay });
      }
      const config = client.getConfig();
      return ok({
        address: client.address,
        defaultChain: config.chain,
        limits: config.limits,
      });
    })
  );

  return server;
}
