/**
 * Custodial balance ledger (SQLite).
 *
 * Backs the balance ("password-free" / 免密支付) rail: buyers top up once and
 * subsequent purchases are deducted server-side — no signature or scan per
 * transaction. All amounts are **integer cents** (`*_sat`, 1 USD = 100) to
 * avoid floating-point drift; the dollar<->cent boundary is `toSat`/`fromSat`.
 *
 * Uses the Node built-in `node:sqlite` (zero new dependencies). That module
 * is only available on Node >= 22.5, so it is loaded lazily inside the
 * constructor: servers that don't enable the balance rail keep the package's
 * `node >= 18` floor.
 *
 * Concurrency: `DatabaseSync` is synchronous and single-connection, so every
 * ledger call is naturally serialized within the process — the
 * check-and-deduct UPDATE (`... WHERE balance_sat >= ?`) is atomic without
 * explicit transactions. WAL mode keeps concurrent readers cheap.
 *
 * @see ../../../docs/BALANCE-RAIL-DESIGN.md — data model & semantics
 */

import { randomUUID } from 'node:crypto';

/** Buyer account row (amounts in integer cents). */
export interface BuyerRow {
  buyer_id: string;
  display_name: string | null;
  balance_sat: number;
  total_topup_sat: number;
  total_spent_sat: number;
  daily_limit_sat: number;
  single_limit_sat: number;
  status: 'active' | 'frozen' | 'banned';
  created_at: string;
  updated_at: string;
}

/** Ledger transaction row (amounts in integer cents, always positive). */
export interface LedgerTxRow {
  id: string;
  buyer_id: string;
  type: 'topup' | 'deduct' | 'refund';
  amount_sat: number;
  service: string | null;
  description: string | null;
  /** Client-supplied idempotency key (deducts). Unique when present. */
  request_id: string | null;
  /** External settlement reference: on-chain tx hash / Alipay or WeChat trade no. */
  external_ref: string | null;
  /** For refunds: the deduct row being reversed. */
  refunds_tx_id: string | null;
  status: 'completed' | 'refunded';
  created_at: string;
}

export type DeductErrorCode =
  | 'buyer_not_found'
  | 'buyer_not_active'
  | 'insufficient_balance'
  | 'exceeds_single_limit'
  | 'exceeds_daily_limit';

export interface DeductResult {
  success: boolean;
  /** Ledger transaction id (also returned on an idempotent replay). */
  txId?: string;
  /** True when `request_id` matched an existing deduct — nothing was charged. */
  replayed?: boolean;
  balanceSat?: number;
  error?: DeductErrorCode;
  /** Populated for limit errors. */
  limitSat?: number;
}

export interface DeductOpts {
  buyerId: string;
  amountSat: number;
  /** Idempotency key; a replay returns the original tx without deducting. */
  requestId?: string;
  service?: string;
  description?: string;
}

export interface TopupOpts {
  buyerId: string;
  amountSat: number;
  /** On-chain tx hash / Alipay trade_no / WeChat out_trade_no. Unique — a
   *  replayed reference credits nothing and returns the original row. */
  externalRef: string;
  description?: string;
}

export interface RefundResult {
  success: boolean;
  txId?: string;
  balanceSat?: number;
  /** True when the deduct was already refunded — nothing was credited. */
  replayed?: boolean;
  error?: 'tx_not_found' | 'not_a_deduct';
}

export interface LedgerConfig {
  /** SQLite file path, or ':memory:' for tests. */
  dbPath: string;
  /** Default per-transaction limit for new buyers, integer cents. */
  defaultSingleLimitSat?: number;
  /** Default daily limit for new buyers, integer cents. */
  defaultDailyLimitSat?: number;
  /**
   * Ledger quote currency (e.g. 'USD', 'CNY'). Recorded once in `ledger_meta`
   * on first init and enforced on every subsequent open: the minor unit
   * (`*_sat`) is 1/100 of this currency, so reopening a USD ledger as CNY would
   * silently reinterpret every balance. Defaults to "USD".
   */
  currency?: string;
}

export const DEFAULT_SINGLE_LIMIT_SAT = 500; // 5.00
export const DEFAULT_DAILY_LIMIT_SAT = 1000; // 10.00

/** Convert a decimal string/number of dollars to integer cents. Throws on >2dp. */
export function toSat(amount: string | number): number {
  const s = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error(`Invalid amount "${amount}": expected a non-negative decimal with <= 2 places`);
  }
  const [whole, frac = ''] = s.split('.');
  return parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, '0') || '0', 10);
}

/** Convert integer cents back to a 2-decimal string. */
export function fromSat(sat: number): string {
  return (sat / 100).toFixed(2);
}

export class BalanceLedger {
  private readonly db: any;
  private readonly defaultSingleLimitSat: number;
  private readonly defaultDailyLimitSat: number;

  constructor(config: LedgerConfig) {
    // process.getBuiltinModule (Node >= 22.3) works under both the cjs and
    // esm builds; node:sqlite itself needs Node >= 22.5. Loaded lazily so
    // servers that don't enable the balance rail keep the node >= 18 floor.
    const getBuiltin = (process as any).getBuiltinModule as
      | ((id: string) => any)
      | undefined;
    const sqlite = getBuiltin?.('node:sqlite');
    if (!sqlite?.DatabaseSync) {
      throw new Error(
        'The balance rail requires the node:sqlite module (Node.js >= 22.5). ' +
        `Current version: ${process.version}. Upgrade Node or disable provider.balance.`
      );
    }
    const { DatabaseSync } = sqlite;
    this.db = new DatabaseSync(config.dbPath);
    this.defaultSingleLimitSat = config.defaultSingleLimitSat ?? DEFAULT_SINGLE_LIMIT_SAT;
    this.defaultDailyLimitSat = config.defaultDailyLimitSat ?? DEFAULT_DAILY_LIMIT_SAT;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS buyers (
        buyer_id TEXT PRIMARY KEY,
        display_name TEXT,
        balance_sat INTEGER NOT NULL DEFAULT 0,
        total_topup_sat INTEGER NOT NULL DEFAULT 0,
        total_spent_sat INTEGER NOT NULL DEFAULT 0,
        daily_limit_sat INTEGER NOT NULL,
        single_limit_sat INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS ledger_transactions (
        id TEXT PRIMARY KEY,
        buyer_id TEXT NOT NULL REFERENCES buyers(buyer_id),
        type TEXT NOT NULL,
        amount_sat INTEGER NOT NULL,
        service TEXT,
        description TEXT,
        request_id TEXT,
        external_ref TEXT,
        refunds_tx_id TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_request_id
        ON ledger_transactions(request_id) WHERE request_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_external_ref
        ON ledger_transactions(external_ref) WHERE external_ref IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_refunds_tx
        ON ledger_transactions(refunds_tx_id) WHERE refunds_tx_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_ledger_buyer_time
        ON ledger_transactions(buyer_id, created_at);
      CREATE TABLE IF NOT EXISTS ledger_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Record and enforce the ledger's quote currency. The minor unit (`*_sat`)
    // is 1/100 of this currency -- cents for USD, fen for CNY -- so reopening a
    // USD-funded ledger under a CNY config would silently reinterpret every
    // balance (7 sat = 0.07 USD vs 0.07 CNY). Refuse the mismatch; a different
    // currency requires a separate db_path.
    const currency = config.currency ?? 'USD';
    const existingCurrency = this.db
      .prepare(`SELECT value FROM ledger_meta WHERE key = 'currency'`)
      .get() as { value: string } | undefined;
    if (existingCurrency) {
      if (existingCurrency.value !== currency) {
        throw new Error(
          `Balance ledger currency mismatch: db=${existingCurrency.value} config=${currency}. ` +
          `Use a separate db_path for a different currency; do not reinterpret an existing ledger.`
        );
      }
    } else {
      this.db
        .prepare(`INSERT INTO ledger_meta (key, value) VALUES ('currency', ?)`)
        .run(currency);
    }
  }

  /** Fetch a buyer, or null. */
  getBuyer(buyerId: string): BuyerRow | null {
    const row = this.db
      .prepare('SELECT * FROM buyers WHERE buyer_id = ?')
      .get(buyerId);
    return (row as BuyerRow) ?? null;
  }

  /** Fetch a buyer, creating an empty active account on first sight. */
  getOrCreateBuyer(buyerId: string, displayName?: string): BuyerRow {
    const existing = this.getBuyer(buyerId);
    if (existing) return existing;
    this.db
      .prepare(
        `INSERT INTO buyers (buyer_id, display_name, daily_limit_sat, single_limit_sat)
         VALUES (?, ?, ?, ?)`
      )
      .run(buyerId, displayName ?? null, this.defaultDailyLimitSat, this.defaultSingleLimitSat);
    return this.getBuyer(buyerId)!;
  }

  /** Sum of today's (UTC) completed deducts minus refunds issued against them. */
  spentTodaySat(buyerId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(CASE type WHEN 'deduct' THEN amount_sat ELSE -amount_sat END), 0) AS spent
         FROM ledger_transactions
         WHERE buyer_id = ? AND type IN ('deduct','refund') AND date(created_at) = date('now')`
      )
      .get(buyerId) as { spent: number };
    return Math.max(0, row.spent);
  }

  /**
   * Read-only deduction precheck (the rail's `verify`). Never mutates.
   * Returns the same error codes `deduct` would.
   */
  checkDeduct(buyerId: string, amountSat: number): DeductResult {
    const buyer = this.getBuyer(buyerId);
    if (!buyer) return { success: false, error: 'buyer_not_found' };
    if (buyer.status !== 'active') return { success: false, error: 'buyer_not_active' };
    if (amountSat > buyer.single_limit_sat) {
      return { success: false, error: 'exceeds_single_limit', limitSat: buyer.single_limit_sat };
    }
    const spent = this.spentTodaySat(buyerId);
    if (spent + amountSat > buyer.daily_limit_sat) {
      return { success: false, error: 'exceeds_daily_limit', limitSat: buyer.daily_limit_sat };
    }
    if (buyer.balance_sat < amountSat) {
      return { success: false, error: 'insufficient_balance', balanceSat: buyer.balance_sat };
    }
    return { success: true, balanceSat: buyer.balance_sat };
  }

  /**
   * Atomic deduction (the rail's `settle`). Check + UPDATE run inside one
   * SQLite transaction; a `request_id` replay returns the original tx
   * without charging again.
   */
  deduct(opts: DeductOpts): DeductResult {
    if (!Number.isInteger(opts.amountSat) || opts.amountSat <= 0) {
      throw new Error(`deduct amountSat must be a positive integer, got ${opts.amountSat}`);
    }
    if (opts.requestId) {
      const prior = this.db
        .prepare(`SELECT * FROM ledger_transactions WHERE request_id = ?`)
        .get(opts.requestId) as LedgerTxRow | undefined;
      if (prior) {
        const buyer = this.getBuyer(prior.buyer_id)!;
        return { success: true, txId: prior.id, replayed: true, balanceSat: buyer.balance_sat };
      }
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const check = this.checkDeduct(opts.buyerId, opts.amountSat);
      if (!check.success) {
        this.db.exec('ROLLBACK');
        return check;
      }
      const updated = this.db
        .prepare(
          `UPDATE buyers SET
             balance_sat = balance_sat - ?,
             total_spent_sat = total_spent_sat + ?,
             updated_at = datetime('now')
           WHERE buyer_id = ? AND balance_sat >= ? AND status = 'active'`
        )
        .run(opts.amountSat, opts.amountSat, opts.buyerId, opts.amountSat);
      if (Number(updated.changes) !== 1) {
        this.db.exec('ROLLBACK');
        return { success: false, error: 'insufficient_balance' };
      }
      const txId = `btx_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO ledger_transactions (id, buyer_id, type, amount_sat, service, description, request_id)
           VALUES (?, ?, 'deduct', ?, ?, ?, ?)`
        )
        .run(txId, opts.buyerId, opts.amountSat, opts.service ?? null, opts.description ?? null, opts.requestId ?? null);
      this.db.exec('COMMIT');
      const buyer = this.getBuyer(opts.buyerId)!;
      return { success: true, txId, balanceSat: buyer.balance_sat };
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /**
   * Credit a top-up. `externalRef` is the settlement proof reference
   * (on-chain tx hash / fiat trade number) and is unique: replaying the same
   * reference returns the original row without crediting twice.
   */
  topup(opts: TopupOpts): { txId: string; balanceSat: number; replayed?: boolean } {
    if (!Number.isInteger(opts.amountSat) || opts.amountSat <= 0) {
      throw new Error(`topup amountSat must be a positive integer, got ${opts.amountSat}`);
    }
    const prior = this.db
      .prepare(`SELECT * FROM ledger_transactions WHERE external_ref = ?`)
      .get(opts.externalRef) as LedgerTxRow | undefined;
    if (prior) {
      const buyer = this.getBuyer(prior.buyer_id)!;
      return { txId: prior.id, balanceSat: buyer.balance_sat, replayed: true };
    }
    this.getOrCreateBuyer(opts.buyerId);
    const txId = `btx_${randomUUID()}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE buyers SET
             balance_sat = balance_sat + ?,
             total_topup_sat = total_topup_sat + ?,
             updated_at = datetime('now')
           WHERE buyer_id = ?`
        )
        .run(opts.amountSat, opts.amountSat, opts.buyerId);
      this.db
        .prepare(
          `INSERT INTO ledger_transactions (id, buyer_id, type, amount_sat, description, external_ref)
           VALUES (?, ?, 'topup', ?, ?, ?)`
        )
        .run(txId, opts.buyerId, opts.amountSat, opts.description ?? null, opts.externalRef);
      this.db.exec('COMMIT');
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
    const buyer = this.getBuyer(opts.buyerId)!;
    return { txId, balanceSat: buyer.balance_sat };
  }

  /**
   * Reverse a deduct (service failed after the charge). Idempotent: the
   * unique index on `refunds_tx_id` means a second refund of the same deduct
   * returns the original refund row.
   */
  refund(deductTxId: string, reason?: string): RefundResult {
    const deductRow = this.db
      .prepare(`SELECT * FROM ledger_transactions WHERE id = ?`)
      .get(deductTxId) as LedgerTxRow | undefined;
    if (!deductRow) return { success: false, error: 'tx_not_found' };
    if (deductRow.type !== 'deduct') return { success: false, error: 'not_a_deduct' };
    const priorRefund = this.db
      .prepare(`SELECT * FROM ledger_transactions WHERE refunds_tx_id = ?`)
      .get(deductTxId) as LedgerTxRow | undefined;
    if (priorRefund) {
      const buyer = this.getBuyer(deductRow.buyer_id)!;
      return { success: true, txId: priorRefund.id, balanceSat: buyer.balance_sat, replayed: true };
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `UPDATE buyers SET
             balance_sat = balance_sat + ?,
             total_spent_sat = total_spent_sat - ?,
             updated_at = datetime('now')
           WHERE buyer_id = ?`
        )
        .run(deductRow.amount_sat, deductRow.amount_sat, deductRow.buyer_id);
      this.db
        .prepare(`UPDATE ledger_transactions SET status = 'refunded' WHERE id = ?`)
        .run(deductTxId);
      const txId = `btx_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO ledger_transactions (id, buyer_id, type, amount_sat, description, refunds_tx_id)
           VALUES (?, ?, 'refund', ?, ?, ?)`
        )
        .run(txId, deductRow.buyer_id, deductRow.amount_sat, reason ?? null, deductTxId);
      this.db.exec('COMMIT');
      const buyer = this.getBuyer(deductRow.buyer_id)!;
      return { success: true, txId, balanceSat: buyer.balance_sat };
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /** Paged transaction history, newest first (rowid breaks same-second ties). */
  listTransactions(buyerId: string, limit = 20, offset = 0): LedgerTxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM ledger_transactions WHERE buyer_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
      )
      .all(buyerId, limit, offset) as LedgerTxRow[];
  }

  /** Quick integrity probe for healthCheck(). */
  integrityOk(): boolean {
    const row = this.db.prepare(`PRAGMA quick_check`).get() as { quick_check: string };
    return row.quick_check === 'ok';
  }

  close(): void {
    this.db.close();
  }
}
