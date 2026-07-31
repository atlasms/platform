import type { Db } from './db.ts';

// A pragmatic JSON-row repository: `CREATE TABLE <t>(id TEXT PRIMARY KEY, data TEXT)`. Enough to
// persist an entity; a real service uses typed columns for what it queries and JSON for the rest.
export interface JsonRepo<T extends { id: string }> {
  put(entity: T): void;
  get(id: string): T | undefined;
  all(): T[];
  delete(id: string): void;
}

export const jsonTableMigration = (table: string) => ({
  id: `table_${table}`,
  up: `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
});

export function jsonRepo<T extends { id: string }>(db: Db, table: string): JsonRepo<T> {
  return {
    put: (e) => {
      db.prepare(
        `INSERT INTO ${table}(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      ).run(e.id, JSON.stringify(e));
    },
    get: (id) => {
      const r = db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as
        { data: string } | undefined;
      return r ? (JSON.parse(r.data) as T) : undefined;
    },
    all: () =>
      (db.prepare(`SELECT data FROM ${table}`).all() as { data: string }[]).map(
        (r) => JSON.parse(r.data) as T,
      ),
    delete: (id) => {
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    },
  };
}
