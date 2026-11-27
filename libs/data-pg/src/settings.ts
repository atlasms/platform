// Tier-3 settings rows on Postgres (EP-33.2) — the deployed half of @atlas/data's
// `SqliteSettingsTable`, held to the same conformance suite (`settingsConformance`).

import { StaleSetting, type Migration, type SettingFilter, type StoredSetting } from '@atlas/data';
import type { PgClient, PgPool } from './db.ts';

export const settingsMigration: Migration = {
  id: 'core_settings',
  up: `CREATE TABLE IF NOT EXISTS settings (
         area       text NOT NULL,
         key        text NOT NULL,
         level      text NOT NULL,
         scope_id   text NOT NULL,
         channel_id text,
         value      jsonb,
         is_set     boolean NOT NULL,
         version    integer NOT NULL,
         updated_by text NOT NULL,
         updated_at timestamptz NOT NULL,
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
  value: unknown;
  is_set: boolean;
  version: number;
  updated_by: string;
  updated_at: Date;
}

const fromRow = (r: Row): StoredSetting => ({
  area: r.area,
  key: r.key,
  level: r.level,
  scopeId: r.scope_id,
  channelId: r.channel_id,
  // jsonb comes back parsed. A stored JSON `null` is a real value only while the row is set.
  value: r.is_set ? r.value : undefined,
  set: r.is_set,
  version: Number(r.version),
  updatedBy: r.updated_by,
  updatedAt: r.updated_at.toISOString(),
});

/** See `SqliteSettingsTable` — the same predicate, the same compare-and-set. */
export class PgSettingsTable {
  async list(db: PgClient | PgPool, filter: SettingFilter): Promise<StoredSetting[]> {
    const { rows } = await db.query<Row>(
      `SELECT * FROM settings
        WHERE area = $1
          AND (level = 'deployment'
            OR (level = 'channel' AND scope_id = $2)
            OR (level = 'category' AND channel_id = $2)
            OR (level = 'user' AND scope_id = $3 AND channel_id = $2))
        ORDER BY key, level, scope_id`,
      // A user id that cannot match when none is given — NULL would make the comparison unknown,
      // which is false too, but a sentinel says what is meant.
      [filter.area, filter.channelId, filter.userId ?? '\u0001'],
    );
    return rows.map(fromRow);
  }

  async get(
    db: PgClient | PgPool,
    area: string,
    key: string,
    level: string,
    scopeId: string,
  ): Promise<StoredSetting | undefined> {
    const { rows } = await db.query<Row>(
      'SELECT * FROM settings WHERE area = $1 AND key = $2 AND level = $3 AND scope_id = $4',
      [area, key, level, scopeId],
    );
    return rows[0] ? fromRow(rows[0]) : undefined;
  }

  /**
   * Compare-and-set, as on sqlite. Under READ COMMITTED a second writer on the same version blocks
   * on the first's row lock, re-evaluates `version = $n` against the committed row and updates
   * nothing — that zero is the {@link StaleSetting}. Two first writes race on the primary key
   * instead: the loser's `ON CONFLICT DO NOTHING` inserts nothing.
   */
  async put(client: PgClient, row: StoredSetting, ifVersion?: number): Promise<void> {
    // jsonb from a JSON TEXT parameter: pg would otherwise send a JS string as a JSON string and a
    // JS array as a Postgres array literal.
    const value = row.set ? JSON.stringify(row.value ?? null) : null;
    const result =
      ifVersion === undefined
        ? await client.query(
            `INSERT INTO settings (area, key, level, scope_id, channel_id, value, is_set, version, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
             ON CONFLICT (area, key, level, scope_id) DO NOTHING`,
            [
              row.area,
              row.key,
              row.level,
              row.scopeId,
              row.channelId,
              value,
              row.set,
              row.version,
              row.updatedBy,
              row.updatedAt,
            ],
          )
        : await client.query(
            `UPDATE settings SET value = $1::jsonb, is_set = $2, version = $3, updated_by = $4, updated_at = $5
              WHERE area = $6 AND key = $7 AND level = $8 AND scope_id = $9 AND version = $10`,
            [
              value,
              row.set,
              row.version,
              row.updatedBy,
              row.updatedAt,
              row.area,
              row.key,
              row.level,
              row.scopeId,
              ifVersion,
            ],
          );
    if ((result.rowCount ?? 0) === 0) {
      throw new StaleSetting(row.area, row.key, row.level, row.scopeId);
    }
  }
}
