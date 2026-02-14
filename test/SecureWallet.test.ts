/**
 * SecureWallet 单元测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SecureWallet } from '../src/wallet/SecureWallet.js';
import * as fs from 'fs';

// 注意：这些测试不会真正执行链上交易
// 主要测试限额、白名单等安全逻辑

describe('SecureWallet - Security Checks', () => {
  const testAuditDir = '/tmp/payment-agent-test-secure-wallet';
  let wallet: SecureWallet;

  beforeAll(() => {
    if (fs.existsSync(testAuditDir)) {
      fs.rmSync(testAuditDir, { recursive: true });
    }

    // 使用测试私钥（不会真正执行交易）
    process.env.PAYMENT_AGENT_PRIVATE_KEY = '0x' + '1'.repeat(64);

    wallet = new SecureWallet({
      chain: 'base_sepolia',
      limits: {
        singleMax: 100,
        dailyMax: 500,
        requireWhitelist: true,
      },
      whitelist: [
        '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
        '0x9513ed2C1E861CA4020195538FcB42654C9B3DFa',
      ],
      auditPath: testAuditDir,
    });
  });

  afterAll(() => {
    if (fs.existsSync(testAuditDir)) {
      fs.rmSync(testAuditDir, { recursive: true });
    }
  });

  describe('Whitelist', () => {
    it('should check if address is whitelisted', () => {
      expect(wallet.isWhitelisted('0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C')).toBe(true);
      expect(wallet.isWhitelisted('0x0000000000000000000000000000000000000000')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(wallet.isWhitelisted('0xB8D6F2441E8F8DFB6288A74CF73804CDD0484E0C')).toBe(true);
    });

    it('should reject transfer to non-whitelisted address', async () => {
      const result = await wallet.transfer({
        to: '0x0000000000000000000000000000000000000001',
        amount: 10,
        reason: 'test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('whitelist');
    });
  });

  describe('Limits', () => {
    it('should return current limits', () => {
      const limits = wallet.getLimits();

      expect(limits.singleMax).toBe(100);
      expect(limits.dailyMax).toBe(500);
      expect(limits.requireWhitelist).toBe(true);
    });

    it('should reject transfer exceeding single limit', async () => {
      const result = await wallet.transfer({
        to: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
        amount: 150, // 超过单笔限额 100
        reason: 'test large transfer',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('single limit');
      expect(result.error).toContain('Pending approval');
    });

    it('should track daily usage', () => {
      const used = wallet.getDailyUsed();
      expect(typeof used).toBe('number');
    });
  });

  describe('Pending Transfers', () => {
    it('should add over-limit transfers to pending queue', async () => {
      const initialCount = wallet.getPendingTransfers().length;
      
      await wallet.transfer({
        to: '0xb8d6f2441e8f8dfB6288A74Cf73804cDd0484E0C',
        amount: 200,
        reason: 'large transfer',
        requester: 'test_user',
      });

      const pending = wallet.getPendingTransfers();
      expect(pending.length).toBeGreaterThan(initialCount);
      
      // 查找金额为 200 的待处理转账
      const found = pending.find(p => p.amount === 200);
      expect(found).toBeDefined();
      expect(found?.status).toBe('pending');
    });

    it('should reject non-existent pending transfer', async () => {
      const result = await wallet.approve('non_existent_id', 'admin');

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('Address', () => {
    it('should expose wallet address', () => {
      expect(wallet.address).toBeDefined();
      expect(wallet.address.startsWith('0x')).toBe(true);
    });
  });
});

describe('SecureWallet - Whitelist Management', () => {
  const testAuditDir = '/tmp/payment-agent-test-whitelist';
  let wallet: SecureWallet;

  beforeAll(() => {
    if (fs.existsSync(testAuditDir)) {
      fs.rmSync(testAuditDir, { recursive: true });
    }

    process.env.PAYMENT_AGENT_PRIVATE_KEY = '0x' + '2'.repeat(64);

    wallet = new SecureWallet({
      chain: 'base_sepolia',
      whitelist: [],
      auditPath: testAuditDir,
    });
  });

  afterAll(() => {
    if (fs.existsSync(testAuditDir)) {
      fs.rmSync(testAuditDir, { recursive: true });
    }
  });

  it('should add address to whitelist', async () => {
    const newAddress = '0x1234567890123456789012345678901234567890';

    expect(wallet.isWhitelisted(newAddress)).toBe(false);

    await wallet.addToWhitelist(newAddress, 'admin');

    expect(wallet.isWhitelisted(newAddress)).toBe(true);
  });

  it('should remove address from whitelist', async () => {
    const address = '0xabcdef0123456789abcdef0123456789abcdef01';

    await wallet.addToWhitelist(address, 'admin');
    expect(wallet.isWhitelisted(address)).toBe(true);

    await wallet.removeFromWhitelist(address, 'admin');
    expect(wallet.isWhitelisted(address)).toBe(false);
  });
});
