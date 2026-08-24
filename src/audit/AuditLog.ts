/**
 * AuditLog — append-only, hash-chained audit trail for agent commerce.
 *
 * Every payment the commerce layer makes is recorded here so a spend can be
 * explained after the fact: which agent, for which task/tool call, buying what,
 * at what price, with what result, and whether that result verified. This is
 * the "explainability" half of the commerce layer (the budget/ledger is the
 * enforcement half).
 *
 * Integrity: entries form a hash chain — each entry's `hash` covers all of its
 * own fields plus the previous entry's `hash` (`prev_hash`). Tampering with any
 * recorded field breaks the chain, which {@link verify} detects. The genesis
 * link is 64 zeros.
 *
 * Persistence: when constructed with a directory, entries are appended as JSON
 * lines to `audit_<YYYY-MM-DD>.jsonl` (one file per UTC day) and the chain is
 * resumed from the newest existing entry on startup. Without a directory the
 * log is in-memory only (chain still enforced) — used by tests and by servers
 * that have not opted into on-disk audit.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** The genesis `prev_hash` — the link before the first entry. */
const GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  /** Unix milliseconds when the entry was recorded. */
  timestamp: number;
  /** ISO-8601 form of {@link timestamp} for human reading. */
  datetime: string;
  /** Event kind, e.g. 'payment_settled', 'payment_refunded', 'whitelist_add'. */
  action: string;
  /** Client-supplied idempotency / correlation key. */
  request_id?: string;

  // ── Commerce correlation (see product doc §11: "audit data model") ──
  /** Owning organization (enterprise deployments). */
  organization_id?: string;
  /** End user the task was run for. */
  user_id?: string;
  /** Agent that spent the money. */
  agent_id?: string;
  /** Session the spend happened in. */
  session_id?: string;
  /** Commerce task the spend belongs to (ties to the per-task budget). */
  task_id?: string;
  /** Tool call that triggered the paid request. */
  tool_call_id?: string;
  /** Purchased service id. */
  service_id?: string;
  /** Service provider / payee. */
  provider_id?: string;
  /** Quote that was accepted, if any. */
  quote_id?: string;
  /** Ledger / on-chain payment id (e.g. the balance tx id). */
  payment_id?: string;
  /** Receipt id, when a signed receipt is issued. */
  receipt_id?: string;
  /** Payment channel / rail: 'balance' | 'usdc_base' | 'wechat' | 'alipay' | … */
  payment_channel?: string;
  /** Hash of the service result, so the deliverable can be tied to the spend. */
  result_hash?: string;
  /** Whether the paid-for result verified: 'fulfilled' | 'failed' | 'refunded' | 'unverified'. */
  verification_status?: string;

  // ── Legacy transfer fields (kept for the SecureWallet audit trail) ──
  from?: string;
  to?: string;
  amount?: number;
  currency?: string;
  reason?: string;
  requester?: string;
  metadata?: Record<string, unknown>;

  /** Previous entry's hash (chain link). */
  prev_hash?: string;
  /** This entry's hash (covers every field above + `prev_hash`). */
  hash?: string;
  [key: string]: unknown;
}

export interface VerifyResult {
  valid: boolean;
  errors: string[];
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly auditDir?: string;
  private prevHash: string = GENESIS_HASH;

  /**
   * @param auditDir directory for `audit_<date>.jsonl` files. Omit for an
   *   in-memory-only log (the hash chain is still enforced).
   */
  constructor(auditDir?: string) {
    this.auditDir = auditDir;
    if (auditDir) {
      fs.mkdirSync(auditDir, { recursive: true });
      // Resume the chain from whatever is already on disk.
      const existing = this.read();
      this.entries = existing;
      this.prevHash = existing.length ? existing[existing.length - 1].hash! : GENESIS_HASH;
    }
  }

  /**
   * Canonical hash over every field except `hash` itself, with keys sorted so
   * the digest is stable regardless of insertion order.
   */
  private computeHash(entry: AuditEntry): string {
    const { hash: _omit, ...rest } = entry;
    const canonical = JSON.stringify(rest, Object.keys(rest).sort());
    return createHash('sha256').update(canonical).digest('hex');
  }

  /** Path of today's (UTC) audit file. */
  private fileFor(datetime: string): string {
    const day = datetime.slice(0, 10);
    return path.join(this.auditDir!, `audit_${day}.jsonl`);
  }

  /**
   * Append an entry. Stamps `timestamp`, `datetime`, `prev_hash`, and the
   * chained `hash`, persists it (when a directory is configured), and returns
   * the full entry.
   */
  async log(entry: Omit<AuditEntry, 'timestamp' | 'datetime' | 'hash' | 'prev_hash'>): Promise<AuditEntry> {
    const timestamp = Date.now();
    const datetime = new Date(timestamp).toISOString();
    const full: AuditEntry = {
      ...entry,
      timestamp,
      datetime,
      prev_hash: this.prevHash,
    } as AuditEntry;
    full.hash = this.computeHash(full);
    this.prevHash = full.hash;
    this.entries.push(full);
    if (this.auditDir) {
      fs.appendFileSync(this.fileFor(datetime), JSON.stringify(full) + '\n');
    }
    return full;
  }

  /**
   * All entries, oldest first. Reads from disk (all `audit_*.jsonl` in name
   * order) when a directory is configured, else returns the in-memory copy.
   */
  read(): AuditEntry[] {
    if (!this.auditDir) return [...this.entries];
    if (!fs.existsSync(this.auditDir)) return [];
    const files = fs
      .readdirSync(this.auditDir)
      .filter(f => /^audit_\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    const out: AuditEntry[] = [];
    for (const f of files) {
      const content = fs.readFileSync(path.join(this.auditDir, f), 'utf-8').trim();
      if (!content) continue;
      for (const line of content.split('\n')) {
        if (line) out.push(JSON.parse(line) as AuditEntry);
      }
    }
    return out;
  }

  /**
   * Recompute the hash chain over the persisted entries and report any break.
   * Detects tampering (a changed field yields a different hash) and reordering
   * / deletion (a broken `prev_hash` link).
   */
  verify(): VerifyResult {
    const errors: string[] = [];
    const entries = this.read();
    let expectedPrev = GENESIS_HASH;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.prev_hash !== expectedPrev) {
        errors.push(`entry ${i} (${e.request_id ?? e.action}): prev_hash mismatch`);
      }
      const recomputed = this.computeHash(e);
      if (recomputed !== e.hash) {
        errors.push(`entry ${i} (${e.request_id ?? e.action}): hash mismatch (tampered)`);
      }
      expectedPrev = e.hash!;
    }
    return { valid: errors.length === 0, errors };
  }

  /** Entries matching every provided field (exact match). */
  search(filter: Partial<AuditEntry>): AuditEntry[] {
    const keys = Object.keys(filter) as (keyof AuditEntry)[];
    return this.read().filter(e => keys.every(k => e[k] === filter[k]));
  }

  /** In-memory snapshot (does not touch disk). */
  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  /** Reset the in-memory cache and chain head (does not delete files). */
  clear(): void {
    this.entries = [];
    this.prevHash = GENESIS_HASH;
  }
}
