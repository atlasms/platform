// The node:sqlite adapter — the test double, held to the same conformance suite as Postgres.
//
// Same tables, same columns, same statements as store-pg.ts wherever the dialects allow, so a
// behaviour proven here is the behaviour deployed. Where they differ (placeholders, upserts, the
// changes count) the difference is in one line, next to its twin.

import {
  migrate,
  openDb,
  outboxHeadersMigration,
  outboxMigration,
  SqliteOutboxStore,
  withTransactionAsync,
  type Db,
  type Migration,
} from '@atlas/data';
import { Conflict } from '@atlas/service-kit';
import type {
  Assignment,
  Credential,
  Group,
  IamStore,
  IamTx,
  LoginEvent,
  Membership,
  RefreshTokenRecord,
  StoredRole,
  User,
} from './store.ts';

export const sqliteMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'iam_identity',
    up: `CREATE TABLE IF NOT EXISTS users (
           id                   TEXT PRIMARY KEY,
           channel_id           TEXT,
           username             TEXT NOT NULL UNIQUE,
           state                TEXT NOT NULL,
           perm_version         INTEGER NOT NULL,
           data                 TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS credentials (
           user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
           hash       TEXT NOT NULL,
           updated_at TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS refresh_tokens (
           id           TEXT PRIMARY KEY,
           user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           token_hash   TEXT NOT NULL UNIQUE,
           family_id    TEXT NOT NULL,
           expires_at   TEXT NOT NULL,
           created_at   TEXT NOT NULL,
           revoked_at   TEXT,
           rotated_from TEXT
         );
         CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
         CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
         -- Append-only: the trail of who tried to sign in is evidence (EP-10.8).
         CREATE TABLE IF NOT EXISTS login_events (
           id         TEXT PRIMARY KEY,
           user_id    TEXT,
           username   TEXT NOT NULL,
           at         TEXT NOT NULL,
           result     TEXT NOT NULL,
           data       TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS login_events_user_idx ON login_events (user_id, at);
         CREATE TRIGGER IF NOT EXISTS login_events_no_update BEFORE UPDATE ON login_events
           BEGIN SELECT RAISE(ABORT, 'login_events is append-only'); END;
         CREATE TRIGGER IF NOT EXISTS login_events_no_delete BEFORE DELETE ON login_events
           BEGIN SELECT RAISE(ABORT, 'login_events is append-only'); END;`,
  },
  {
    id: 'iam_authorization',
    up: `CREATE TABLE IF NOT EXISTS roles (
           id         TEXT PRIMARY KEY,
           channel_id TEXT,
           data       TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS groups (
           id         TEXT PRIMARY KEY,
           channel_id TEXT,
           data       TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS memberships (
           user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
           PRIMARY KEY (user_id, group_id)
         );
         CREATE INDEX IF NOT EXISTS memberships_group_idx ON memberships (group_id);
         CREATE TABLE IF NOT EXISTS assignments (
           id      TEXT PRIMARY KEY,
           user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           role_id TEXT,
           data    TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS assignments_user_idx ON assignments (user_id);`,
  },
  {
    // "Who holds this role" is asked on every role edit and every role delete; without this it is
    // a scan of the assignments table.
    id: 'iam_assignments_by_role',
    up: `CREATE INDEX IF NOT EXISTS assignments_role_idx ON assignments (role_id);`,
  },
];

// `version: 1` under the document: a record written before EP-10.4 (part 2) added the field reads
// as revision 1 rather than as a record with no revision.
const parse = <T>(row: { data: string } | undefined): T | undefined =>
  row ? ({ version: 1, ...(JSON.parse(row.data) as object) } as T) : undefined;

export function sqliteIamStore(path = ':memory:'): IamStore & { db: Db } {
  const db = openDb(path);
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db, sqliteMigrations);
  const outbox = new SqliteOutboxStore(db);

  const tx: IamTx = {
    async putUser(user) {
      const taken = db
        .prepare('SELECT id FROM users WHERE username = ? AND id <> ?')
        .get(user.username, user.id) as { id: string } | undefined;
      if (taken) throw new Conflict(`username "${user.username}" is taken`);
      db.prepare(
        `INSERT INTO users (id, channel_id, username, state, perm_version, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET channel_id = excluded.channel_id, username = excluded.username,
           state = excluded.state, perm_version = excluded.perm_version, data = excluded.data`,
      ).run(
        user.id,
        user.channelId ?? null,
        user.username,
        user.state,
        user.permVersion,
        JSON.stringify(user),
      );
    },
    async deleteUser(id) {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },
    async putCredential(c) {
      db.prepare(
        `INSERT INTO credentials (user_id, hash, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET hash = excluded.hash, updated_at = excluded.updated_at`,
      ).run(c.userId, c.hash, c.updatedAt);
    },
    async putRefreshToken(r) {
      db.prepare(
        `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at, revoked_at, rotated_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        r.id,
        r.userId,
        r.tokenHash,
        r.familyId,
        r.expiresAt,
        r.createdAt,
        r.revokedAt ?? null,
        r.rotatedFrom ?? null,
      );
    },
    async revokeTokens(ids, at) {
      if (ids.length === 0) return 0;
      const result = db
        .prepare(
          `UPDATE refresh_tokens SET revoked_at = ? WHERE revoked_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
        )
        .run(at, ...ids);
      return Number(result.changes);
    },
    async appendLoginEvent(e) {
      db.prepare(
        'INSERT INTO login_events (id, user_id, username, at, result, data) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(e.id, e.userId ?? null, e.username, e.at, e.result, JSON.stringify(e));
    },
    async putGroup(g) {
      db.prepare(
        `INSERT INTO groups (id, channel_id, data) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET channel_id = excluded.channel_id, data = excluded.data`,
      ).run(g.id, g.channelId ?? null, JSON.stringify(g));
    },
    async deleteGroup(id) {
      db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    },
    async putMembership(m) {
      db.prepare('INSERT OR IGNORE INTO memberships (user_id, group_id) VALUES (?, ?)').run(
        m.userId,
        m.groupId,
      );
    },
    async deleteMembership(m) {
      db.prepare('DELETE FROM memberships WHERE user_id = ? AND group_id = ?').run(
        m.userId,
        m.groupId,
      );
    },
    async putRole(r) {
      db.prepare(
        `INSERT INTO roles (id, channel_id, data) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET channel_id = excluded.channel_id, data = excluded.data`,
      ).run(r.id, r.channelId ?? null, JSON.stringify(r));
    },
    async deleteRole(id) {
      db.prepare('DELETE FROM roles WHERE id = ?').run(id);
    },
    async putAssignment(a) {
      db.prepare(
        `INSERT INTO assignments (id, user_id, role_id, data) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET user_id = excluded.user_id, role_id = excluded.role_id, data = excluded.data`,
      ).run(a.id, a.userId, a.roleId ?? null, JSON.stringify(a));
    },
    async deleteAssignment(id) {
      db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
    },
    async enqueue(record) {
      outbox.enqueue(record);
    },
  };

  const userRows = (sql: string, ...params: (string | number)[]): User[] =>
    (db.prepare(sql).all(...params) as { data: string }[]).map((r) => parse<User>(r) as User);

  return {
    db,
    async transaction(fn) {
      return withTransactionAsync(db, () => fn(tx));
    },
    async user(id) {
      return parse<User>(db.prepare('SELECT data FROM users WHERE id = ?').get(id) as never);
    },
    async userByUsername(username) {
      return parse<User>(
        db.prepare('SELECT data FROM users WHERE username = ?').get(username) as never,
      );
    },
    async users(options = {}) {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (options.channelId !== undefined) {
        clauses.push('channel_id = ?');
        params.push(options.channelId);
      }
      if (options.after !== undefined) {
        clauses.push('id > ?');
        params.push(options.after);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      return userRows(
        `SELECT data FROM users ${where} ORDER BY id LIMIT ?`,
        ...params,
        options.limit ?? 100,
      );
    },
    async credential(userId) {
      const row = db
        .prepare('SELECT user_id, hash, updated_at FROM credentials WHERE user_id = ?')
        .get(userId) as { user_id: string; hash: string; updated_at: string } | undefined;
      return row ? { userId: row.user_id, hash: row.hash, updatedAt: row.updated_at } : undefined;
    },
    async refreshTokenByHash(tokenHash) {
      const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash) as
        TokenRow | undefined;
      return row ? toToken(row) : undefined;
    },
    async family(familyId) {
      return (
        db
          .prepare('SELECT * FROM refresh_tokens WHERE family_id = ? ORDER BY created_at, id')
          .all(familyId) as unknown as TokenRow[]
      ).map(toToken);
    },
    async userTokens(userId) {
      return (
        db
          .prepare('SELECT * FROM refresh_tokens WHERE user_id = ? ORDER BY created_at, id')
          .all(userId) as unknown as TokenRow[]
      ).map(toToken);
    },
    async loginEvents(options = {}) {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (options.userId !== undefined) {
        clauses.push('user_id = ?');
        params.push(options.userId);
      }
      if (options.username !== undefined) {
        clauses.push('username = ?');
        params.push(options.username);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      return (
        db
          .prepare(`SELECT data FROM login_events ${where} ORDER BY at DESC, id DESC LIMIT ?`)
          .all(...params, options.limit ?? 100) as { data: string }[]
      ).map((r) => JSON.parse(r.data) as LoginEvent);
    },
    async group(id) {
      return parse<Group>(db.prepare('SELECT data FROM groups WHERE id = ?').get(id) as never);
    },
    async groups(options = {}) {
      const rows = (
        options.channelId !== undefined
          ? db
              .prepare(
                'SELECT data FROM groups WHERE channel_id = ? OR channel_id IS NULL ORDER BY id',
              )
              .all(options.channelId)
          : db.prepare('SELECT data FROM groups ORDER BY id').all()
      ) as { data: string }[];
      return rows.map((r) => parse<Group>(r) as Group);
    },
    async memberships(userId) {
      return db
        .prepare('SELECT user_id, group_id FROM memberships WHERE user_id = ? ORDER BY group_id')
        .all(userId)
        .map((r) => toMembership(r as never));
    },
    async members(groupId) {
      return db
        .prepare('SELECT user_id, group_id FROM memberships WHERE group_id = ? ORDER BY user_id')
        .all(groupId)
        .map((r) => toMembership(r as never));
    },
    async role(id) {
      return parse<StoredRole>(db.prepare('SELECT data FROM roles WHERE id = ?').get(id) as never);
    },
    async roles(options = {}) {
      const rows = (
        options.channelId !== undefined
          ? db
              .prepare(
                'SELECT data FROM roles WHERE channel_id = ? OR channel_id IS NULL ORDER BY id',
              )
              .all(options.channelId)
          : db.prepare('SELECT data FROM roles ORDER BY id').all()
      ) as { data: string }[];
      return rows.map((r) => parse<StoredRole>(r) as StoredRole);
    },
    async assignments(userId) {
      return (
        db.prepare('SELECT data FROM assignments WHERE user_id = ? ORDER BY id').all(userId) as {
          data: string;
        }[]
      ).map((r) => JSON.parse(r.data) as Assignment);
    },
    async roleHolders(roleId) {
      const assignments = (
        db.prepare('SELECT data FROM assignments WHERE role_id = ? ORDER BY id').all(roleId) as {
          data: string;
        }[]
      ).map((r) => JSON.parse(r.data) as Assignment);
      // A group's roles live inside its document, and sqlite has no index into one. Scanning is
      // honest here and nowhere else: groups are an administrative set — tens per channel, not
      // the millions of rows every other query is shaped around.
      const groups = (db.prepare('SELECT data FROM groups ORDER BY id').all() as { data: string }[])
        .map((r) => JSON.parse(r.data) as Group)
        .filter((g) => g.roleIds?.includes(roleId));
      return { assignments, groups };
    },
    async close() {
      db.close();
    },
  };
}

interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  rotated_from: string | null;
}

const toToken = (r: TokenRow): RefreshTokenRecord => ({
  id: r.id,
  userId: r.user_id,
  tokenHash: r.token_hash,
  familyId: r.family_id,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  ...(r.revoked_at !== null ? { revokedAt: r.revoked_at } : {}),
  ...(r.rotated_from !== null ? { rotatedFrom: r.rotated_from } : {}),
});

const toMembership = (r: { user_id: string; group_id: string }): Membership => ({
  userId: r.user_id,
  groupId: r.group_id,
});

export type { Credential };
