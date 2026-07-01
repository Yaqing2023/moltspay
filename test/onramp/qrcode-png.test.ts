import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeQRCodePng } from '../../src/onramp/index.js';

describe('writeQRCodePng', () => {
  it('writes a PNG QR image for a WeChat Native code_url', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moltspay-qr-test-'));
    const path = writeQRCodePng('weixin://wxpay/bizpayurl?pr=TEST123', {
      dir,
      filename: 'wechat-test.png',
      scale: 2,
    });

    const data = readFileSync(path);
    expect(path.endsWith('/wechat-test.png')).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(100);
    expect([...data.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});
