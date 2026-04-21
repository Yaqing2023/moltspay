import { describe, it, expect } from 'vitest';
import {
  parsePaymentRequiredHeader,
  serverAcceptedChains,
  selectChain,
  findRequirementForChain,
  buildPaymentPayload,
  encodePaymentHeader,
} from '../../../src/client/core/x402.js';
import { encodeBase64, decodeBase64 } from '../../../src/client/core/base64.js';
import {
  InvalidPaymentHeaderError,
  UnsupportedChainError,
} from '../../../src/client/core/errors.js';
import type { X402PaymentRequirements } from '../../../src/client/core/types.js';

const reqBase: X402PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '990000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x0000000000000000000000000000000000000099',
};

const reqPolygon: X402PaymentRequirements = {
  scheme: 'exact',
  network: 'eip155:137',
  amount: '990000',
  asset: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  payTo: '0x0000000000000000000000000000000000000099',
};

const reqTempo: X402PaymentRequirements = {
  scheme: 'permit',
  network: 'eip155:42431',
  amount: '990000',
  asset: '0x20c0000000000000000000000000000000000000',
  payTo: '0x0000000000000000000000000000000000000099',
};

describe('x402 — parsePaymentRequiredHeader', () => {
  it('parses v1 array shape', () => {
    const header = encodeBase64(JSON.stringify([reqBase, reqPolygon]));
    const out = parsePaymentRequiredHeader(header);
    expect(out).toHaveLength(2);
    expect(out[0].network).toBe('eip155:8453');
  });

  it('parses v2 object shape with accepts[]', () => {
    const header = encodeBase64(
      JSON.stringify({ x402Version: 2, accepts: [reqBase, reqTempo] })
    );
    const out = parsePaymentRequiredHeader(header);
    expect(out).toHaveLength(2);
    expect(out[1].scheme).toBe('permit');
  });

  it('parses single-object shape', () => {
    const header = encodeBase64(JSON.stringify(reqBase));
    const out = parsePaymentRequiredHeader(header);
    expect(out).toEqual([reqBase]);
  });

  it('throws on invalid base64 / JSON', () => {
    expect(() => parsePaymentRequiredHeader('!not-base64!')).toThrow(
      InvalidPaymentHeaderError
    );
  });
});

describe('x402 — serverAcceptedChains / findRequirementForChain', () => {
  it('maps networks to chain names', () => {
    expect(serverAcceptedChains([reqBase, reqPolygon, reqTempo])).toEqual([
      'base', 'polygon', 'tempo_moderato',
    ]);
  });

  it('silently drops requirements for unknown networks', () => {
    const unknownReq = { scheme: 'exact', network: 'eip155:99999' };
    expect(serverAcceptedChains([reqBase, unknownReq])).toEqual(['base']);
  });

  it('finds the requirement for a given chain', () => {
    const found = findRequirementForChain([reqBase, reqTempo], 'tempo_moderato');
    expect(found?.scheme).toBe('permit');
  });

  it('returns null if no requirement matches', () => {
    expect(findRequirementForChain([reqBase], 'tempo_moderato')).toBeNull();
  });
});

describe('x402 — selectChain', () => {
  it('uses the user-specified chain when accepted', () => {
    expect(selectChain([reqBase, reqPolygon], 'polygon')).toBe('polygon');
  });

  it('throws when user-specified chain is not accepted', () => {
    expect(() => selectChain([reqBase], 'polygon')).toThrow(UnsupportedChainError);
  });

  it('defaults to base when server accepts only base', () => {
    expect(selectChain([reqBase])).toBe('base');
  });

  it('requires explicit chain when server offers multiple', () => {
    expect(() => selectChain([reqBase, reqPolygon])).toThrow(UnsupportedChainError);
  });

  it('requires explicit chain even when the single accepted chain is not base', () => {
    expect(() => selectChain([reqPolygon])).toThrow(UnsupportedChainError);
  });
});

describe('x402 — build/encode payment payload', () => {
  it('assembles a v2 envelope with scheme-specific payload', () => {
    const envelope = buildPaymentPayload({
      scheme: 'permit',
      network: 'eip155:42431',
      payload: { permit: { owner: '0xabc', spender: '0xdef', v: 27, r: '0x..', s: '0x..' } },
      accepted: reqTempo,
    });
    expect(envelope.x402Version).toBe(2);
    expect(envelope.scheme).toBe('permit');
    expect(envelope.payload).toHaveProperty('permit');
    expect(envelope.accepted).toBe(reqTempo);
  });

  it('encodes to base64 that round-trips', () => {
    const envelope = buildPaymentPayload({
      scheme: 'permit',
      network: 'eip155:42431',
      payload: { hello: 'world' },
      accepted: reqTempo,
    });
    const header = encodePaymentHeader(envelope);
    const decoded = JSON.parse(decodeBase64(header));
    expect(decoded).toEqual(envelope);
  });
});
