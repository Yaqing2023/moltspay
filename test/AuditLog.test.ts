/**
 * AuditLog 单元测试
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { AuditLog } from '../src/audit/AuditLog.js';
import * as fs from 'fs';
import * as path from 'path';

describe('AuditLog', () => {
  const testDir = '/tmp/payment-agent-test-audit';
  let auditLog: AuditLog;

  beforeAll(() => {
    // 清理测试目录
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    auditLog = new AuditLog(testDir);
  });

  afterAll(() => {
    // 清理
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('log', () => {
    it('should create audit entry with correct fields', async () => {
      const entry = await auditLog.log({
        action: 'transfer_request',
        request_id: 'tr_test001',
        from: '0xfrom',
        to: '0xto',
        amount: 10.0,
        reason: 'test transfer',
        requester: 'test_user',
      });

      expect(entry.action).toBe('transfer_request');
      expect(entry.request_id).toBe('tr_test001');
      expect(entry.from).toBe('0xfrom');
      expect(entry.to).toBe('0xto');
      expect(entry.amount).toBe(10.0);
      expect(entry.timestamp).toBeDefined();
      expect(entry.datetime).toBeDefined();
      expect(entry.hash).toBeDefined();
      expect(entry.prev_hash).toBeDefined();
    });

    it('should chain hashes correctly', async () => {
      const entry1 = await auditLog.log({
        action: 'transfer_executed',
        request_id: 'tr_test002',
        amount: 5.0,
      });

      const entry2 = await auditLog.log({
        action: 'transfer_executed',
        request_id: 'tr_test003',
        amount: 3.0,
      });

      expect(entry2.prev_hash).toBe(entry1.hash);
    });
  });

  describe('read', () => {
    it('should read entries from file', () => {
      const entries = auditLog.read();

      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].action).toBeDefined();
    });
  });

  describe('verify', () => {
    it('should verify log integrity', () => {
      const result = auditLog.verify();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('search', () => {
    it('should search by action', async () => {
      await auditLog.log({
        action: 'whitelist_add',
        request_id: 'wl_001',
        to: '0xnewaddress',
      });

      const results = auditLog.search({ action: 'whitelist_add' });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].action).toBe('whitelist_add');
    });

    it('should search by request_id', async () => {
      const results = auditLog.search({ request_id: 'tr_test001' });

      expect(results.length).toBe(1);
      expect(results[0].request_id).toBe('tr_test001');
    });
  });
});

describe('AuditLog - Tamper Detection', () => {
  const testDir = '/tmp/payment-agent-test-audit-tamper';
  let auditLog: AuditLog;

  beforeAll(async () => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
    auditLog = new AuditLog(testDir);

    // 创建一些日志
    await auditLog.log({ action: 'transfer_request', request_id: 'tr_001', amount: 10 });
    await auditLog.log({ action: 'transfer_executed', request_id: 'tr_001', amount: 10 });
  });

  afterAll(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('should detect tampered entries', () => {
    // 读取日志文件
    const today = new Date().toISOString().slice(0, 10);
    const filePath = path.join(testDir, `audit_${today}.jsonl`);
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    // 篡改第一条记录的金额
    const entry = JSON.parse(lines[0]);
    entry.amount = 999; // 篡改金额
    lines[0] = JSON.stringify(entry);

    // 写回文件
    fs.writeFileSync(filePath, lines.join('\n') + '\n');

    // 验证应该失败
    const result = auditLog.verify();
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
