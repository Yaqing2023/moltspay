/**
 * Unit tests for MoltsPayServer.applyCorsHeaders.
 *
 * Covers all four `cors` option shapes:
 *   - undefined / true (default): wildcard `*`
 *   - false: no CORS headers emitted
 *   - string[]: allowlist — only echoes back matching origins
 *   - CorsOptions: full control (origins + credentials + maxAge)
 */

import { describe, it, expect } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';

// Reach into the class privately through a minimal fake HTTP request/response.
import { MoltsPayServer } from '../../src/server/index.js';

function mockReq(origin?: string): IncomingMessage {
  return { headers: origin ? { origin } : {} } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { _headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    _headers: headers,
    setHeader(name: string, value: string | number | readonly string[]) {
      headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
      return this as unknown as ServerResponse;
    },
  } as unknown as ServerResponse & { _headers: Record<string, string> };
}

// Build a bare server stub whose only purpose is exercising applyCorsHeaders.
// We avoid loading a manifest; the method only reads this.options.cors.
function buildStub(cors: unknown) {
  const stub = Object.create(MoltsPayServer.prototype);
  stub.options = { cors };
  return stub;
}

describe('MoltsPayServer CORS', () => {
  const EXPOSE_HEADERS =
    'X-Payment-Required, X-Payment-Response, WWW-Authenticate, Payment-Receipt';

  it('default (cors undefined) → wildcard Access-Control-Allow-Origin: *', () => {
    const stub = buildStub(undefined);
    const res = mockRes();
    stub.applyCorsHeaders(mockReq('https://app.example.com'), res);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
    expect(res._headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    expect(res._headers['Access-Control-Expose-Headers']).toBe(EXPOSE_HEADERS);
  });

  it('cors=true → wildcard', () => {
    const stub = buildStub(true);
    const res = mockRes();
    stub.applyCorsHeaders(mockReq('https://app.example.com'), res);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
  });

  it('cors=false → no CORS headers emitted at all', () => {
    const stub = buildStub(false);
    const res = mockRes();
    stub.applyCorsHeaders(mockReq('https://app.example.com'), res);
    expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(res._headers['Access-Control-Expose-Headers']).toBeUndefined();
  });

  it('cors=allowlist → echoes origin when listed, adds Vary: Origin', () => {
    const stub = buildStub(['https://app.example.com', 'https://admin.example.com']);
    const res = mockRes();
    stub.applyCorsHeaders(mockReq('https://app.example.com'), res);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(res._headers['Vary']).toBe('Origin');
    expect(res._headers['Access-Control-Expose-Headers']).toBe(EXPOSE_HEADERS);
  });

  it('cors=allowlist → omits headers when origin not listed', () => {
    const stub = buildStub(['https://app.example.com']);
    const res = mockRes();
    stub.applyCorsHeaders(mockReq('https://evil.example.com'), res);
    expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('cors=CorsOptions with credentials + maxAge', () => {
    const stub = buildStub({
      origins: ['https://app.example.com'],
      credentials: true,
      maxAge: 86400,
    });
    const res = mockRes();
    stub.applyCorsHeaders(mockReq('https://app.example.com'), res);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('https://app.example.com');
    expect(res._headers['Access-Control-Allow-Credentials']).toBe('true');
    expect(res._headers['Access-Control-Max-Age']).toBe('86400');
  });

  it('cors=CorsOptions with predicate function', () => {
    const stub = buildStub({
      origins: (origin: string) => origin.endsWith('.example.com'),
    });
    const res = mockRes();
    stub.applyCorsHeaders(mockReq('https://sub.example.com'), res);
    expect(res._headers['Access-Control-Allow-Origin']).toBe('https://sub.example.com');

    const res2 = mockRes();
    stub.applyCorsHeaders(mockReq('https://other.com'), res2);
    expect(res2._headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});
