/**
 * Unit tests for TaskBudgetMeter — the rail-agnostic per-task budget meter.
 * In-memory SQLite; covers atomic reserve, idempotency, release, and the
 * cross-rail unified-budget property (one task, many rails, one ceiling).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TaskBudgetMeter } from '../../src/commerce/index.js';

let m: TaskBudgetMeter;
beforeEach(() => { m = new TaskBudgetMeter(':memory:'); });

describe('TaskBudgetMeter', () => {
  it('caps cumulative reservations at the budget', () => {
    m.setBudget('t1', 300); // 3.00
    expect(m.reserve({ taskId: 't1', amountSat: 200, ref: 'r1' }).ok).toBe(true);
    const over = m.reserve({ taskId: 't1', amountSat: 200, ref: 'r2' });
    expect(over.ok).toBe(false);
    expect(over.code).toBe('exceeds_task_budget');
    expect(over.budgetSat).toBe(300);
    expect(m.reserve({ taskId: 't1', amountSat: 100, ref: 'r3' }).ok).toBe(true); // fits the remaining 1.00
    expect(m.spentSat('t1')).toBe(300);
  });

  it('is idempotent on ref (a replay never double-counts)', () => {
    m.setBudget('t1', 300);
    const a = m.reserve({ taskId: 't1', amountSat: 200, ref: 'r1' });
    const b = m.reserve({ taskId: 't1', amountSat: 200, ref: 'r1' });
    expect(b.replayed).toBe(true);
    expect(b.chargeId).toBe(a.chargeId);
    expect(m.spentSat('t1')).toBe(200); // counted once
  });

  it('release frees the allowance and is idempotent', () => {
    m.setBudget('t1', 300);
    m.reserve({ taskId: 't1', amountSat: 300, ref: 'r1' });
    expect(m.reserve({ taskId: 't1', amountSat: 1, ref: 'r2' }).code).toBe('exceeds_task_budget');
    expect(m.release('r1').released).toBe(true);
    expect(m.spentSat('t1')).toBe(0);
    expect(m.release('r1').released).toBe(false); // already released
    expect(m.reserve({ taskId: 't1', amountSat: 300, ref: 'r3' }).ok).toBe(true); // freed
  });

  it('tracks spend but never refuses an unbudgeted task', () => {
    expect(m.reserve({ taskId: 'no-budget', amountSat: 9999, ref: 'r1' }).ok).toBe(true);
    expect(m.spentSat('no-budget')).toBe(9999);
    expect(m.getBudgetSat('no-budget')).toBeNull();
  });

  it('unifies one budget across rails: balance + USDC + fiat all count together', () => {
    m.setBudget('job-1', 500); // 5.00 total for the task
    // pay 2.00 on the custodial balance rail
    expect(m.reserve({ taskId: 'job-1', amountSat: 200, ref: 'bal-1', rail: 'balance' }).ok).toBe(true);
    // pay 2.00 on USDC (x402) toward the SAME task
    expect(m.reserve({ taskId: 'job-1', amountSat: 200, ref: 'usdc-1', rail: 'usdc_base' }).ok).toBe(true);
    // a 2.00 WeChat charge would push the task to 6.00 > 5.00 → refused across rails
    const wx = m.reserve({ taskId: 'job-1', amountSat: 200, ref: 'wx-1', rail: 'wechat' });
    expect(wx.ok).toBe(false);
    expect(wx.code).toBe('exceeds_task_budget');
    // 1.00 fits the remaining
    expect(m.reserve({ taskId: 'job-1', amountSat: 100, ref: 'wx-2', rail: 'wechat' }).ok).toBe(true);
    expect(m.spentSat('job-1')).toBe(500);
    // charges carry their rail for reporting
    const rails = m.charges('job-1').map(c => c.rail).sort();
    expect(rails).toEqual(['balance', 'usdc_base', 'wechat']);
  });

  it('setBudget upserts and rejects non-positive budgets', () => {
    m.setBudget('t1', 100);
    m.setBudget('t1', 250);
    expect(m.getBudgetSat('t1')).toBe(250);
    expect(() => m.setBudget('t1', 0)).toThrow();
  });
});
