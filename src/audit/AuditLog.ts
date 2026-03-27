/**
 * AuditLog - Stub implementation
 * TODO: Implement full audit logging with file persistence
 */

export interface AuditEntry {
  timestamp: number;
  action: string;
  request_id?: string;
  from?: string;
  to?: string;
  amount?: number;
  reason?: string;
  requester?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private auditPath?: string;

  constructor(auditPath?: string) {
    this.auditPath = auditPath;
    // TODO: Load existing entries from file if path provided
  }

  async log(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
    const fullEntry: AuditEntry = {
      ...entry,
      timestamp: Date.now(),
    } as AuditEntry;
    this.entries.push(fullEntry);
    // TODO: Persist to file if auditPath is set
  }

  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
  }
}
