import type { Db } from './db.ts';
import type { Migration } from './migrations.ts';

// Tier-3 settings rows (EP-33.2): the VALUE of a setting at one level, against a descriptor that
// ships in code (`@atlas/reference`). configuration-and-reference-data.md §2.4: "declare the setting
// in code; store only the value" — so this table knows nothing about types, bounds or defaults.
// Validation and resolution happen above it, from the descriptor; this is storage and its rules.
//
// One table per service schema, like `outbox` and `seen`: the service that ACTS on a setting owns
// its rows (§4), and every service is given the same table rather than inventing one.

/** One stored value of one setting, at one level. */
export interface StoredSetting {
  /** The owning service/module, e.g. `mam`. Keys are unique per area. */
  area: string;
  /** The setting's key within its area, e.g. `review.rejectedRetention`. */
  key: string;
  /** `deployment` | `channel` | `category` | `user` — the descriptor library's `ScopeLevel`. */
  level: string;
  /** The scope instance (a channel, category or user id); `''` at `deployment`. */
  scopeId: string;
  /**
   * The channel the row belongs to: the channel itself at `channel`, the owner's channel at
   * `category`/`user`, and `null` at `deployment` — a platform-wide value (tables.json).
   */
  channelId: string | null;
  /**
   * The value — or, when `set` is false, nothing: the row was RESET to inherited.
   *
   * A reset keeps the row rather than deleting it, because its `version` is the setting's audit
   * revision at that level. Delete it and the next write starts again at 1, a revision the audit
   * sink already holds — so it refuses the record, and the change has no history.
   */
  value: unknown;
  set: boolean;
  /** +1 per write, the compare-and-set token and the audit revision. Starts at 1. */
  version: number;
  updatedBy: string;
  updatedAt: string;
}

/** Which rows a reader may see: the platform's, its channel's and (optionally) its own. */
export interface SettingFilter {
  area: string;
  channelId: string;
  userId?: string;
}

/** A compare-and-set that lost: the row is not at the version the write read. */
export class StaleSetting extends Error {
  constructor(area: string, key: string, level: string, scopeId: string) {
    super(
      `setting ${area}.${key} at ${level}${scopeId ? `:${scopeId}` : ''} changed underneath this write`,
    );
    this.name = 'StaleSetting';
  }
}

export const settingsMigration: Migration = {
  id: 'core_settings',
  up: `CREATE TABLE IF NOT EXISTS settings (
         area       TEXT NOT NULL,
         key        TEXT NOT NULL,
         level      TEXT NOT NULL,
         scope_id   TEXT NOT NULL,
         channel_id TEXT,
         value      TEXT,
         is_set     INTEGER NOT NULL,
         version    INTEGER NOT NULL,
         updated_by TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         PRIMARY KEY (area, key, level, scope_id)
       );
       CREATE INDEX IF NOT EXISTS settings_channel_idx ON settings (area, channel_id);`,
};

interface Row {
  area: string;
  key: string;
  level: string;
  scope_id: string;
  channel_id: string | null;
  value: string | null;
  is_set: number;
  version: number;
  updated_by: string;
  updated_at: string;
}

const fromRow = (r: Row): StoredSetting => ({
  area: r.area,
  key: r.key,
  level: r.level,
  scopeId: r.scope_id,
  channelId: r.channel_id,
  value: r.is_set === 1 && r.value !== null ? (JSON.parse(r.value) as unknown) : undefined,
  set: r.is_set === 1,
  version: Number(r.version),
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

/**
 * The rows a filter selects — the same predicate on both adapters, written once in words:
 * every `deployment` row of the area; the `channel` row for the reader's channel; `category`
 * rows in the reader's channel; and, with a `userId`, that user's `user` rows.
 */
const LIST_SQL = `SELECT * FROM settings
  WHERE area = ?
    AND (level = 'deployment'
      OR (level = 'channel' AND scope_id = ?)
      OR (level = 'category' AND channel_id = ?)
      OR (level = 'user' AND scope_id = ? AND channel_id = ?))
  ORDER BY key, level, scope_id`;

/**
 * Settings rows on `node:sqlite`. Every method takes the handle to write through, so a write
 * composes inside the service's own unit of work with its outbox records — the setting, its
 * `config.changed` and its `audit.recorded` commit together or not at all (AGENTS.md §5.4).
 */
export class SqliteSettingsTable {
  list(db: Db, filter: SettingFilter): StoredSetting[] {
    return (
      db.prepare(LIST_SQL).all(
        filter.area,
        filter.channelId,
        filter.channelId,
        // A user id that cannot match when none is given.
        filter.userId ?? '\u0001',
        filter.channelId,
      ) as unknown as Row[]
    ).map(fromRow);
  }

  get(
    db: Db,
    area: string,
    key: string,
    level: string,
    scopeId: string,
  ): StoredSetting | undefined {
    const row = db
      .prepare('SELECT * FROM settings WHERE area = ? AND key = ? AND level = ? AND scope_id = ?')
      .get(area, key, level, scopeId) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  /**
   * Write a row — COMPARE-AND-SET. Without `ifVersion` the row must not exist yet (a first value
   * at this level); with it, only that version is replaced. Anything else is a {@link StaleSetting}
   * and the caller's transaction must not commit.
   */
  put(db: Db, row: StoredSetting, ifVersion?: number): void {
    const value = row.set ? JSON.stringify(row.value ?? null) : null;
    const result =
      ifVersion === undefined
        ? db
            .prepare(
              `INSERT INTO settings (area, key, level, scope_id, channel_id, value, is_set, version, updated_by, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (area, key, level, scope_id) DO NOTHING`,
            )
            .run(
              row.area,
              row.key,
              row.level,
              row.scopeId,
              row.channelId,
              value,
              row.set ? 1 : 0,
              row.version,
              row.updatedBy,
              row.updatedAt,
            )
        : db
            .prepare(
              `UPDATE settings SET value = ?, is_set = ?, version = ?, updated_by = ?, updated_at = ?
               WHERE area = ? AND key = ? AND level = ? AND scope_id = ? AND version = ?`,
            )
            .run(
              value,
              row.set ? 1 : 0,
              row.version,
              row.updatedBy,
              row.updatedAt,
              row.area,
              row.key,
              row.level,
              row.scopeId,
              ifVersion,
            );
    if (Number(result.changes) === 0) {
      throw new StaleSetting(row.area, row.key, row.level, row.scopeId);
    }
  }
}
