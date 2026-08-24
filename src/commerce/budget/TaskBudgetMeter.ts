/**
 * TaskBudgetMeter — the rail-agnostic per-task spending meter (commerce-core).
 *
 * One authoritative budget per task, keyed by `task_id` ALONE, so a task's
 * total spend is capped no matter which rail pays for it: USDC (x402), fiat
 * (Alipay / WeChat), or the custodial balance all reserve against the SAME
 * meter. This is what makes "budget $2 for this task" hold across currencies.
 *
 * Each charge is `reserve()`d before settlement and either kept (payment
 * succeeded) or `release()`d (settlement / delivery failed, so the allowance is
 * freed and the task is not billed for a failure). Reservations are idempotent
 * on a caller-supplied `ref`, so a retry never double-counts.
 *
 * Enforcement is atomic: the check-and-insert runs in one SQLite transaction.
 * `node:sqlite` is single-connection and synchronous, so charges are naturally
 * serialized within the process. Amounts are integer minor units (`*Sat`).
 *
 * Division of labour: this meter owns the TASK ceiling. A rail's own controls
 * (e.g. the balance ledger's wallet balance + single/daily limits) are separate
 * and still apply.
 */

import { randomUUID } from 'node:crypto';

export interface ReserveOpts {
  taskId: string;
  amountSat: number;
  /** Idempotency key (e.g. request id / tx hash). A replay returns the original. */
  ref: string;
  /** Rail label for reporting: 'balance' | 'usdc_base' | 'alipay' | 'wechat' | … */
  rail?: string;
  /** Optional payer scope (buyer/agent id) for reporting. */
  scope?: string;
}

export interface ReserveResult {
  ok: boolean;
  chargeId?: string;
  /** True when `ref` matched an existing reservation — nothing was re-counted. */
  replayed?: boolean;
  /** Set when refused. */
  code?: 'exceeds_task_budget';
  /** Registered budget, when the refusal was a budget breach. */
  budgetSat?: number;
}

export interface ChargeRow {
  id: string;
  task_id: string;
  amount_sat: number;
  ref: string;
  rail: string | null;
  scope: string | null;
  status: 'active' | 'released';
  created_at: string;
}

export class TaskBudgetMeter {
  private readonly db: any;

  constructor(dbPath: string) {
    const getBuiltin = (process as any).getBuiltinModule as ((id: string) => any) | undefined;
    const sqlite = getBuiltin?.('node:sqlite');
    if (!sqlite?.DatabaseSync) {
      throw new Error(
        'The task budget meter requires the node:sqlite module (Node.js >= 22.5). ' +
        `Current version: ${process.version}.`
      );
    }
    const { DatabaseSync } = sqlite;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_budgets (
        task_id TEXT PRIMARY KEY,
        budget_sat INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS task_charges (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        amount_sat INTEGER NOT NULL,
        ref TEXT NOT NULL,
        rail TEXT,
        scope TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_charges_ref ON task_charges(ref);
      CREATE INDEX IF NOT EXISTS idx_task_charges_task ON task_charges(task_id);
    `);
  }

  /** Register / update a task budget (integer minor units). Operator-set. */
  setBudget(taskId: string, budgetSat: number): { budgetSat: number } {
    if (!Number.isInteger(budgetSat) || budgetSat <= 0) {
      throw new Error(`task budget budgetSat must be a positive integer, got ${budgetSat}`);
    }
    this.db
      .prepare(
        `INSERT INTO task_budgets (task_id, budget_sat) VALUES (?, ?)
         ON CONFLICT(task_id) DO UPDATE SET budget_sat = excluded.budget_sat, updated_at = datetime('now')`
      )
      .run(taskId, budgetSat);
    return { budgetSat };
  }

  /** Registered budget in cents, or null if none set (task is uncapped). */
  getBudgetSat(taskId: string): number | null {
    const row = this.db
      .prepare(`SELECT budget_sat FROM task_budgets WHERE task_id = ?`)
      .get(taskId) as { budget_sat: number } | undefined;
    return row ? row.budget_sat : null;
  }

  /** Sum of active (non-released) charges on a task. */
  spentSat(taskId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_sat), 0) AS spent
         FROM task_charges WHERE task_id = ? AND status = 'active'`
      )
      .get(taskId) as { spent: number };
    return Math.max(0, row.spent);
  }

  /**
   * Reserve a charge against a task's budget, atomically. When a budget is set
   * and `spent + amount` would exceed it, the reservation is refused and
   * nothing is recorded. With no budget set, the charge is recorded but never
   * refused (spend is still tracked). Idempotent on `ref`.
   */
  reserve(opts: ReserveOpts): ReserveResult {
    if (!Number.isInteger(opts.amountSat) || opts.amountSat <= 0) {
      throw new Error(`reserve amountSat must be a positive integer, got ${opts.amountSat}`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db
        .prepare(`SELECT * FROM task_charges WHERE ref = ?`)
        .get(opts.ref) as ChargeRow | undefined;
      if (prior) {
        this.db.exec('COMMIT');
        return { ok: true, chargeId: prior.id, replayed: true };
      }
      const budget = this.getBudgetSat(opts.taskId);
      if (budget !== null) {
        const spent = this.spentSat(opts.taskId);
        if (spent + opts.amountSat > budget) {
          this.db.exec('ROLLBACK');
          return { ok: false, code: 'exceeds_task_budget', budgetSat: budget };
        }
      }
      const id = `chg_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO task_charges (id, task_id, amount_sat, ref, rail, scope)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(id, opts.taskId, opts.amountSat, opts.ref, opts.rail ?? null, opts.scope ?? null);
      this.db.exec('COMMIT');
      return { ok: true, chargeId: id };
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /**
   * Release a reservation (settlement or delivery failed), freeing the task's
   * allowance. Idempotent: releasing an already-released or unknown ref is a
   * no-op. Returns whether an active charge was freed.
   */
  release(ref: string): { ok: boolean; released: boolean } {
    const info = this.db
      .prepare(`UPDATE task_charges SET status = 'released' WHERE ref = ? AND status = 'active'`)
      .run(ref);
    return { ok: true, released: Number(info.changes) === 1 };
  }

  /** All charges on a task, newest first. */
  charges(taskId: string): ChargeRow[] {
    return this.db
      .prepare(`SELECT * FROM task_charges WHERE task_id = ? ORDER BY created_at DESC, rowid DESC`)
      .all(taskId) as ChargeRow[];
  }

  close(): void {
    this.db.close();
  }
}
