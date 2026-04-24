/**
 * MoltsPayWebClient — integration tests with a stubbed PaymentSigner + fetch.
 *
 * The Base EIP-3009 and error-path tests do not need RPC mocking: the client
 * only calls the server via fetch, and any on-chain reads (nonces, allowance)
 * happen only on Tempo / BNB. Those paths have their own RPC-mocked tests.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MoltsPayWebClient,
  PaymentSigner,
} from '../../../src/client/web/index.js';
import { encodeBase64 } from '../../../src/client/core/base64.js';
import type { X402PaymentRequirements } from '../../../src/client/core/types.js';
import {
  ServerError,
  UnsupportedChainError,
} from '../../../src/client/core/errors.js';

const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function fakeSigner(): PaymentSigner {
  return {
    getEvmAddress: vi.fn(async () => OWNER),
    signTypedData: vi.fn(async () => '0x' + 'cd'.repeat(65)),
  };
}

function buildPaymentRequiredHeader(requirements: X402PaymentRequirements[]): string {
  return encodeBase64(JSON.stringify({ x402Version: 2, accepts: requirements }));
}

function buildFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let i = 0;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    const headers = new Map<string, string>(Object.entries(r.headers ?? {}));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: {
        get(name: string) {
          return headers.get(name.toLowerCase()) ?? headers.get(name) ?? null;
        },
      },
      json: async () => r.body,
    } as unknown as Response;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

const baseRequirement: X402PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '500000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x9999999999999999999999999999999999999999',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
};

describe('MoltsPayWebClient.pay — Base EIP-3009 happy path', () => {
  it('sends X-Payment on retry with authorization + signature payload', async () => {
    const signer = fakeSigner();
    const { fetch, calls } = buildFetch([
      // /services probe for endpoint lookup
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} },
      // 402 challenge
      {
        status: 402,
        body: { error: 'Payment required' },
        headers: {
          'x-payment-required': buildPaymentRequiredHeader([baseRequirement]),
        },
      },
      // 200 OK with payment
      { status: 200, body: { result: { ok: true, data: 'yo' } } },
    ]);

    const client = new MoltsPayWebClient({ signer, fetch });
    const result = await client.pay('https://p.example.com', 'svc-1', { q: 'hi' }, { chain: 'base' });

    expect(result).toEqual({ ok: true, data: 'yo' });
    expect(signer.signTypedData).toHaveBeenCalledTimes(1);

    // Last call must carry an X-Payment header with base64-encoded x402 envelope.
    const paidCall = calls[calls.length - 1];
    const headerObj = paidCall.init?.headers as Record<string, string> | undefined;
    expect(headerObj).toBeDefined();
    const xPayment = headerObj!['x-payment'] ?? headerObj!['X-Payment'];
    expect(xPayment).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(xPayment, 'base64').toString('utf-8'));
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('eip155:8453');
    expect(decoded.payload.authorization.from.toLowerCase()).toBe(OWNER);
    expect(decoded.payload.authorization.to).toBe(baseRequirement.payTo);
    expect(decoded.payload.authorization.value).toBe('500000');
    expect(decoded.payload.signature).toMatch(/^0x[0-9a-f]+$/);
  });
});

describe('MoltsPayWebClient.pay — error paths', () => {
  it('surfaces ServerError when 402 is missing X-Payment-Required', async () => {
    const { fetch } = buildFetch([
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 402, body: { error: 'Payment required' } }, // no headers
    ]);
    const client = new MoltsPayWebClient({ signer: fakeSigner(), fetch });
    await expect(client.pay('https://p.example.com', 'svc-1', {})).rejects.toBeInstanceOf(
      ServerError
    );
  });

  it('throws UnsupportedChainError when user picks a chain the server does not accept', async () => {
    const { fetch } = buildFetch([
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} },
      {
        status: 402,
        body: { error: 'Payment required' },
        headers: {
          'x-payment-required': buildPaymentRequiredHeader([baseRequirement]),
        },
      },
    ]);
    const client = new MoltsPayWebClient({ signer: fakeSigner(), fetch });
    await expect(
      client.pay('https://p.example.com', 'svc-1', {}, { chain: 'polygon' })
    ).rejects.toBeInstanceOf(UnsupportedChainError);
  });

  it('throws when Tempo requirement lacks tempoSpender (no settler configured)', async () => {
    const tempoReq: X402PaymentRequirements = {
      scheme: 'permit',
      network: 'eip155:42431',
      amount: '500000',
      asset: '0x20c0000000000000000000000000000000000000',
      payTo: '0x1111111111111111111111111111111111111111',
      extra: { name: 'PathUSD', version: '1' },
    };
    const { fetch } = buildFetch([
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} },
      {
        status: 402,
        body: { error: 'Payment required' },
        headers: {
          'x-payment-required': buildPaymentRequiredHeader([tempoReq]),
        },
      },
    ]);
    const client = new MoltsPayWebClient({ signer: fakeSigner(), fetch });
    await expect(
      client.pay('https://p.example.com', 'svc-1', {}, { chain: 'tempo_moderato' })
    ).rejects.toThrow(/tempoSpender/);
  });

  it('returns result directly when server does not charge (non-402 success)', async () => {
    const { fetch } = buildFetch([
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 200, body: { result: { free: true } } },
    ]);
    const client = new MoltsPayWebClient({ signer: fakeSigner(), fetch });
    const out = await client.pay('https://p.example.com', 'svc-1', {});
    expect(out).toEqual({ free: true });
  });
});

describe('MoltsPayWebClient.getServices', () => {
  it('returns the first /services endpoint that responds with JSON', async () => {
    const manifest = { services: [{ id: 'a', name: 'A', price: 0.5, currency: 'USDC', input: {}, output: {}, available: true }] };
    const { fetch } = buildFetch([
      { status: 200, body: manifest, headers: { 'content-type': 'application/json' } },
    ]);
    const client = new MoltsPayWebClient({ signer: fakeSigner(), fetch });
    const result = await client.getServices('https://p.example.com');
    expect(result.services[0].id).toBe('a');
  });

  it('throws ServerError when no endpoint returns JSON', async () => {
    const { fetch } = buildFetch([
      { status: 404, body: {} },
      { status: 404, body: {} },
      { status: 404, body: {} },
    ]);
    const client = new MoltsPayWebClient({ signer: fakeSigner(), fetch });
    await expect(client.getServices('https://p.example.com')).rejects.toBeInstanceOf(
      ServerError
    );
  });
});

