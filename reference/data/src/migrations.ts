import type { Db } from './db.ts';

// Ordered, once-applied SQL migrations tracked in _migrations. Idempotent: re-running applies only
// what's new. Each migration runs in its own transaction, so a failure never half-applies.
export interface Migration { id: string; up: string; }

export function migrate(db: Db, migrations: Migration[]): { applied: string[] } {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT id FROM _migrations').all() as { id: string }[]).map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
      db.exec('COMMIT');
      applied.push(m.id);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration "${m.id}" failed: ${(e as Error).message}`);
    }
  }
  return { applied };
}
