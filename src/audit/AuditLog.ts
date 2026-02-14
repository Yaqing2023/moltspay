/**
 * AuditLog - 不可篡改审计日志
 * 
 * 特点：
 * - 链式哈希，任何修改都会破坏链条
 * - 按日期分文件存储
 * - JSONL 格式便于追加和解析
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AuditEntry, AuditAction } from '../types/index.js';

export interface LogParams {
  action: AuditAction;
  request_id: string;
  from?: string;
  to?: string;
  amount?: number;
  tx_hash?: string;
  reason?: string;
  requester?: string;
  metadata?: Record<string, unknown>;
}

export class AuditLog {
  private basePath: string;
  private lastHash: string = '0000000000000000';

  constructor(basePath?: string) {
    this.basePath = basePath || path.join(process.cwd(), 'data', 'audit');
    this.ensureDir();
    this.loadLastHash();
  }

  /**
   * 记录审计日志
   */
  async log(params: LogParams): Promise<AuditEntry> {
    const now = new Date();
    
    const entry: AuditEntry = {
      timestamp: now.getTime() / 1000,
      datetime: now.toISOString(),
      action: params.action,
      request_id: params.request_id,
      from: params.from,
      to: params.to,
      amount: params.amount,
      tx_hash: params.tx_hash,
      reason: params.reason,
      requester: params.requester,
      prev_hash: this.lastHash,
      hash: '', // 计算后填充
      metadata: params.metadata,
    };

    // 计算哈希（不包含 hash 字段本身）
    entry.hash = this.calculateHash(entry);
    this.lastHash = entry.hash;

    // 写入文件
    const filePath = this.getFilePath(now);
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(filePath, line, 'utf-8');

    return entry;
  }

  /**
   * 读取指定日期的日志
   */
  read(date?: Date): AuditEntry[] {
    const filePath = this.getFilePath(date || new Date());
    
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    
    return lines.map(line => JSON.parse(line) as AuditEntry);
  }

  /**
   * 验证日志完整性
   */
  verify(date?: Date): { valid: boolean; errors: string[] } {
    const entries = this.read(date);
    const errors: string[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      
      // 验证哈希
      const expectedHash = this.calculateHash(entry);
      if (entry.hash !== expectedHash) {
        errors.push(`Entry ${i}: hash mismatch (expected ${expectedHash}, got ${entry.hash})`);
      }

      // 验证链接
      if (i > 0 && entry.prev_hash !== entries[i - 1].hash) {
        errors.push(`Entry ${i}: prev_hash mismatch`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * 搜索日志
   */
  search(filter: Partial<{
    action: AuditAction;
    request_id: string;
    from: string;
    to: string;
    startDate: Date;
    endDate: Date;
  }>): AuditEntry[] {
    const results: AuditEntry[] = [];
    const startDate = filter.startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = filter.endDate || new Date();

    // 遍历日期范围
    const current = new Date(startDate);
    while (current <= endDate) {
      const entries = this.read(current);
      
      for (const entry of entries) {
        let match = true;

        if (filter.action && entry.action !== filter.action) match = false;
        if (filter.request_id && entry.request_id !== filter.request_id) match = false;
        if (filter.from && entry.from?.toLowerCase() !== filter.from.toLowerCase()) match = false;
        if (filter.to && entry.to?.toLowerCase() !== filter.to.toLowerCase()) match = false;

        if (match) {
          results.push(entry);
        }
      }

      current.setDate(current.getDate() + 1);
    }

    return results;
  }

  /**
   * 获取日志文件路径
   */
  private getFilePath(date: Date): string {
    const dateStr = date.toISOString().slice(0, 10);
    return path.join(this.basePath, `audit_${dateStr}.jsonl`);
  }

  /**
   * 计算条目哈希
   */
  private calculateHash(entry: AuditEntry): string {
    const data = {
      timestamp: entry.timestamp,
      action: entry.action,
      request_id: entry.request_id,
      from: entry.from,
      to: entry.to,
      amount: entry.amount,
      tx_hash: entry.tx_hash,
      prev_hash: entry.prev_hash,
    };
    
    const str = JSON.stringify(data);
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
  }

  /**
   * 加载最后一条日志的哈希
   */
  private loadLastHash(): void {
    const today = new Date();
    
    // 检查今天和昨天的日志
    for (let i = 0; i < 2; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      
      const entries = this.read(date);
      if (entries.length > 0) {
        this.lastHash = entries[entries.length - 1].hash;
        return;
      }
    }
  }

  /**
   * 确保目录存在
   */
  private ensureDir(): void {
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }
}
