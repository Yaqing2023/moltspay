/**
 * Server-internal constants and pure helpers extracted from index.ts to keep
 * the server class focused on request handling. No `this`, no I/O beyond
 * loadEnvFile's file reads. Imported back into index.ts.
 */
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { ServiceConfig } from './types.js';

// x402 constants
export const X402_VERSION = 2;
export const PAYMENT_REQUIRED_HEADER = 'x-payment-required';
export const PAYMENT_HEADER = 'x-payment';
export const PAYMENT_RESPONSE_HEADER = 'x-payment-response';

// MPP (Machine Payments Protocol) constants
export const MPP_AUTH_HEADER = 'authorization';
export const MPP_WWW_AUTH_HEADER = 'www-authenticate';
export const MPP_RECEIPT_HEADER = 'payment-receipt';

// Alipay AI fiat rail constants (2.0.0)
// Legacy `Payment-Needed` 402 challenge header, mirror of `X-Payment-Required`,
// kept so `alipay-bot` (@alipay/agent-payment) skills work unchanged.
export const ALIPAY_PAYMENT_NEEDED_HEADER = 'payment-needed';
// Buyer's proof header: alipay-bot re-requests the resource carrying the
// Base64URL `{protocol:{payment_proof,trade_no},method:{client_session}}`
// blob here after the buyer pays. The server verifies it via the facilitator.
export const ALIPAY_PAYMENT_PROOF_HEADER = 'payment-proof';

/**
 * Make an arbitrary string safe to embed in an HTTP header value.
 *
 * HTTP header values are limited to Latin-1 (RFC 7230 3.2.6); Node's
 * `res.writeHead` throws `Invalid character in header content` on any
 * code point outside that range. Provider/service names can contain
 * non-Latin-1 characters (e.g. CJK), so we percent-encode anything
 * outside printable ASCII and escape `"` so it cannot terminate the
 * surrounding `Payment ... realm="..."` quoted-string.
 */
export function headerSafe(value: string): string {
  return String(value ?? '')
    .replace(/[^\x20-\x7E]/g, ch => encodeURIComponent(ch))
    .replace(/"/g, '%22');
}

/**
 * Deterministic JSON: object keys sorted recursively, so semantically equal
 * params hash identically regardless of key order. Used for the WeChat
 * pending-order idempotency key.
 */
export function canonicalJson(value: any): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  return '{' + Object.keys(value).sort()
    .map(k => JSON.stringify(k) + ':' + canonicalJson(value[k]))
    .join(',') + '}';
}

// Token contract addresses by network
export const TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  'eip155:8453': {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDT: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  },
  'eip155:84532': {
    USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    USDT: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Same as USDC on testnet
  },
  'eip155:137': {
    USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
  'eip155:42431': {
    // Tempo Moderato testnet - TIP-20 stablecoins
    USDC: '0x20c0000000000000000000000000000000000000', // pathUSD
    USDT: '0x20c0000000000000000000000000000000000001', // alphaUSD
  },
  // BNB Smart Chain mainnet
  'eip155:56': {
    USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    USDT: '0x55d398326f99059fF775485246999027B3197955',
  },
  // BNB Smart Chain testnet
  'eip155:97': {
    USDC: '0x64544969ed7EBf5f083679233325356EbE738930',
    USDT: '0x337610d27c682E347C9cD60BD4b3b107C9d34dDd',
  },
  // Solana networks use mint addresses (SPL tokens)
  'solana:mainnet': {
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Circle USDC
  },
  'solana:devnet': {
    USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Devnet USDC
  },
};

// Chain name to network ID mapping
export const CHAIN_TO_NETWORK: Record<string, string> = {
  'base': 'eip155:8453',
  'base_sepolia': 'eip155:84532',
  'polygon': 'eip155:137',
  'tempo_moderato': 'eip155:42431',
  'bnb': 'eip155:56',
  'bnb_testnet': 'eip155:97',
  'solana': 'solana:mainnet',
  'solana_devnet': 'solana:devnet',
};

// Helper to check if a network is Solana
export function isSolanaNetwork(network: string): boolean {
  return network.startsWith('solana:');
}

// EIP-712 domain info for tokens (per network)
// Different networks may have different domain names for the same token
export const TOKEN_DOMAINS: Record<string, Record<string, { name: string; version: string }>> = {
  // Base mainnet
  'eip155:8453': {
    USDC: { name: 'USD Coin', version: '2' },
    USDT: { name: 'Tether USD', version: '2' },
  },
  // Base Sepolia testnet - USDC uses 'USDC' not 'USD Coin'
  'eip155:84532': {
    USDC: { name: 'USDC', version: '2' },
    USDT: { name: 'USDC', version: '2' }, // Same contract as USDC on testnet
  },
  // Polygon mainnet
  'eip155:137': {
    USDC: { name: 'USD Coin', version: '2' },
    USDT: { name: '(PoS) Tether USD', version: '2' },
  },
  // Tempo Moderato testnet - TIP-20 stablecoins
  // Domain names verified against on-chain DOMAIN_SEPARATOR values on 2026-04-21.
  // See docs/TEMPO-WEB-SUPPORT.md Section 2 and test/server/tempo-domain.test.ts.
  // All 4 Tempo TIP-20 tokens (pathUSD / AlphaUSD / BetaUSD / ThetaUSD) use
  // the token symbol with first letter capitalized + version "1".
  'eip155:42431': {
    USDC: { name: 'PathUSD',  version: '1' },
    USDT: { name: 'AlphaUSD', version: '1' },
  },
  // BNB Smart Chain mainnet
  'eip155:56': {
    USDC: { name: 'USD Coin', version: '1' },
    USDT: { name: 'Tether USD', version: '1' },
  },
  // BNB Smart Chain testnet
  'eip155:97': {
    USDC: { name: 'USD Coin', version: '1' },
    USDT: { name: 'Tether USD', version: '1' },
  },
};

// Helper to get token domain for a network
export function getTokenDomain(network: string, token: string): { name: string; version: string } {
  const networkDomains = TOKEN_DOMAINS[network] || TOKEN_DOMAINS['eip155:8453']; // fallback to base mainnet
  return networkDomains[token] || { name: 'USD Coin', version: '2' };
}

// Helper to get accepted currencies with backward compatibility
export function getAcceptedCurrencies(config: ServiceConfig): string[] {
  return config.acceptedCurrencies ?? [config.currency];
}

/**
 * Load environment from .env files.
 */
export function loadEnvFile(): void {
  const envPaths = [
    path.join(process.cwd(), '.env'),
    path.join(process.env.HOME || '', '.moltspay', '.env'),
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      try {
        const content = readFileSync(envPath, 'utf-8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex === -1) continue;
          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();
          if ((value.startsWith('"') && value.endsWith('"')) ||
              (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
        console.log(`[MoltsPay] Loaded config from ${envPath}`);
        break;
      } catch {
        // Ignore errors
      }
    }
  }
}
