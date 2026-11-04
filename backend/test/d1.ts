// Minimal D1-compatible adapter over node:sqlite for integration tests (real SQL, real migrations,
// foreign keys ON as in D1). Implements the subset of the D1 API the backend uses.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Param = string | number | null | bigint | Uint8Array;

class Stmt {
  constructor(private readonly db: DatabaseSync, readonly sql: string, readonly params: Param[] = []) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : (p as Param))));
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true }> {
    return { results: (this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[]).map((r) => ({ ...r })) as T[], success: true };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
  runSync() {
    const isReturning = /\breturning\b/i.test(this.sql) || /^\s*select\b/i.test(this.sql);
    if (isReturning) return { results: this.db.prepare(this.sql).all(...this.params) };
    return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.params).changes) } };
  }
}

export class TestD1 {
  readonly db = new DatabaseSync(':memory:');
  constructor() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    const dir = resolve(__dirname, '../migrations');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) this.db.exec(readFileSync(resolve(dir, f), 'utf8'));
  }
  prepare(sql: string) { return new Stmt(this.db, sql); }
  /** Atomic like D1: all statements succeed or none are applied. */
  async batch(stmts: Stmt[]) {
    this.db.exec('BEGIN');
    try { const out = stmts.map((s) => s.runSync()); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async exec(sql: string) { this.db.exec(sql); return { count: 1, duration: 0 }; }
  /** Test helper: synchronous query. */
  q<T = Record<string, unknown>>(sql: string, ...p: Param[]): T[] { return (this.db.prepare(sql).all(...p) as Record<string, unknown>[]).map((r) => ({ ...r })) as T[]; }
}
