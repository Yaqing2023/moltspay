import { describe, it, expect } from 'vitest';
import {
  ensureCli, semverLt, parseVersion, MIN_CLI_VERSION,
} from '../../../src/client/alipay/install.js';
import {
  AlipayCliNotFoundError, AlipayCliVersionError,
} from '../../../src/client/alipay/errors.js';

describe('semverLt', () => {
  it('compares major.minor.patch', () => {
    expect(semverLt('0.3.14', '0.3.15')).toBe(true);
    expect(semverLt('0.3.15', '0.3.15')).toBe(false);
    expect(semverLt('0.4.0', '0.3.15')).toBe(false);
    expect(semverLt('1.0.0', '0.3.15')).toBe(false);
    expect(semverLt('0.2.99', '0.3.15')).toBe(true);
  });
  it('treats missing components as 0', () => {
    expect(semverLt('0.3', '0.3.1')).toBe(true);
  });
});

describe('parseVersion', () => {
  it('extracts x.y.z with or without a leading v', () => {
    expect(parseVersion('alipay-bot v0.3.15')).toBe('0.3.15');
    expect(parseVersion('0.4.2\n')).toBe('0.4.2');
    expect(parseVersion('no version here')).toBeNull();
  });
});

describe('ensureCli', () => {
  it('resolves with the version when new enough', async () => {
    const v = await ensureCli(async () => `alipay-bot v${MIN_CLI_VERSION}`);
    expect(v).toBe(MIN_CLI_VERSION);
  });

  it('throws AlipayCliNotFoundError on ENOENT', async () => {
    const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
    await expect(ensureCli(async () => { throw enoent; }))
      .rejects.toBeInstanceOf(AlipayCliNotFoundError);
  });

  it('throws AlipayCliVersionError when too old', async () => {
    await expect(ensureCli(async () => 'alipay-bot v0.3.14'))
      .rejects.toBeInstanceOf(AlipayCliVersionError);
  });

  it('throws AlipayCliVersionError when version is unparseable', async () => {
    await expect(ensureCli(async () => 'garbage output'))
      .rejects.toBeInstanceOf(AlipayCliVersionError);
  });

  it('AlipayCliNotFoundError carries the stable code + install hint', async () => {
    const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
    await ensureCli(async () => { throw enoent; }).catch((e) => {
      expect(e.code).toBe('ALIPAY_CLI_NOT_FOUND');
      expect(e.message).toContain('install-cli');
    });
  });
});
