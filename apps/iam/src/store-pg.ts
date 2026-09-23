// The Postgres adapter — production. Same tables and statements as store-sqlite.ts; the
// differences are the dialect's.

import type { Migration } from '@atlas/data';
import {
  outboxHeadersMigration,
  outboxMigration,
  PgOutboxStore,
  withTransaction,
  type PgClient,
  type PgPool,
} from '@atlas/data-pg';
import { Conflict } from '@atlas/service-kit';
import type {
  Assignment,
  Group,
  IamStore,
  IamTx,
  LoginEvent,
  Membership,
  RefreshTokenRecord,
  StoredRole,
  User,
} from './store.ts';

export const pgMigrations: Migration[] = [
  outboxMigration,
  outboxHeadersMigration,
  {
    id: 'iam_identity',
    up: `CREATE TABLE IF NOT EXISTS users (
           id           text PRIMARY KEY,
           channel_id   text,
           username     text NOT NULL UNIQUE,
           state        text NOT NULL,
           perm_version integer NOT NULL,
           data         jsonb NOT NULL
         );
         CREATE TABLE IF NOT EXISTS credentials (
           user_id    text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
           hash       text NOT NULL,
           updated_at timestamptz NOT NULL
         );
         CREATE TABLE IF NOT EXISTS refresh_tokens (
           id           text PRIMARY KEY,
           user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           token_hash   text NOT NULL UNIQUE,
           family_id    text NOT NULL,
           expires_at   timestamptz NOT NULL,
           created_at   timestamptz NOT NULL,
           revoked_at   timestamptz,
           rotated_from text
         );
         CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);
         CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
         CREATE TABLE IF NOT EXISTS login_events (
           id       text PRIMARY KEY,
           user_id  text,
           username text NOT NULL,
           at       timestamptz NOT NULL,
           result   text NOT NULL,
           data     jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS login_events_user_idx ON login_events (user_id, at);
         -- Append-only, in the database: the sign-in trail is evidence (EP-10.8).
         CREATE OR REPLACE FUNCTION iam_append_only() RETURNS trigger AS $$
           BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END;
         $$ LANGUAGE plpgsql;
         DROP TRIGGER IF EXISTS login_events_append_only ON login_events;
         CREATE TRIGGER login_events_append_only
           BEFORE UPDATE OR DELETE ON login_events
           FOR EACH ROW EXECUTE FUNCTION iam_append_only();`,
  },
  {
    id: 'iam_authorization',
    up: `CREATE TABLE IF NOT EXISTS roles (
           id         text PRIMARY KEY,
           channel_id text,
           data       jsonb NOT NULL
         );
         CREATE TABLE IF NOT EXISTS groups (
           id         text PRIMARY KEY,
           channel_id text,
           data       jsonb NOT NULL
         );
         CREATE TABLE IF NOT EXISTS memberships (
           user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           group_id text NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
           PRIMARY KEY (user_id, group_id)
         );
         CREATE INDEX IF NOT EXISTS memberships_group_idx ON memberships (group_id);
         CREATE TABLE IF NOT EXISTS assignments (
           id      text PRIMARY KEY,
           user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           role_id text,
           data    jsonb NOT NULL
         );
         CREATE INDEX IF NOT EXISTS assignments_user_idx ON assignments (user_id);`,
  },
  {
    // The two indexes "who holds this role" needs: the assignment's own column, and a GIN index
    // over the group document, which is what makes the containment query below an index lookup
    // rather than a scan of every group in the estate.
    id: 'iam_assignments_by_role',
    up: `CREATE INDEX IF NOT EXISTS assignments_role_idx ON assignments (role_id);
         CREATE INDEX IF NOT EXISTS groups_data_gin ON groups USING gin (data jsonb_path_ops);`,
  },
];

export function pgIamStore(pool: PgPool): IamStore {
  const outbox = new PgOutboxStore(pool);

  // `version: 1` under the document: a record written before EP-10.4 (part 2) added the field
  // reads as revision 1 rather than as a record with no revision.
  const docs = async <T>(client: PgPool | PgClient, sql: string, params: unknown[]): Promise<T[]> =>
    (await client.query<{ data: T }>(sql, params)).rows.map(
      (r) => ({ version: 1, ...(r.data as object) }) as T,
    );

  return {
    async transaction(fn) {
      return withTransaction(pool, async (client) => {
        const tx: IamTx = {
          async putUser(user) {
            const taken = await client.query(
              'SELECT 1 FROM users WHERE username = $1 AND id <> $2',
              [user.username, user.id],
            );
            if (taken.rowCount) throw new Conflict(`username "${user.username}" is taken`);
            await client.query(
              `INSERT INTO users (id, channel_id, username, state, perm_version, data)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, username = EXCLUDED.username,
                 state = EXCLUDED.state, perm_version = EXCLUDED.perm_version, data = EXCLUDED.data`,
              [
                user.id,
                user.channelId ?? null,
                user.username,
                user.state,
                user.permVersion,
                JSON.stringify(user),
              ],
            );
          },
          async deleteUser(id) {
            await client.query('DELETE FROM users WHERE id = $1', [id]);
          },
          async putCredential(c) {
            await client.query(
              `INSERT INTO credentials (user_id, hash, updated_at) VALUES ($1, $2, $3)
               ON CONFLICT (user_id) DO UPDATE SET hash = EXCLUDED.hash, updated_at = EXCLUDED.updated_at`,
              [c.userId, c.hash, c.updatedAt],
            );
          },
          async putRefreshToken(r) {
            await client.query(
              `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at, created_at, revoked_at, rotated_from)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                r.id,
                r.userId,
                r.tokenHash,
                r.familyId,
                r.expiresAt,
                r.createdAt,
                r.revokedAt ?? null,
                r.rotatedFrom ?? null,
              ],
            );
          },
          async revokeTokens(ids, at) {
            if (ids.length === 0) return 0;
            const result = await client.query(
              'UPDATE refresh_tokens SET revoked_at = $1 WHERE revoked_at IS NULL AND id = ANY($2)',
              [at, ids],
            );
            return result.rowCount ?? 0;
          },
          async appendLoginEvent(e) {
            await client.query(
              'INSERT INTO login_events (id, user_id, username, at, result, data) VALUES ($1, $2, $3, $4, $5, $6)',
              [e.id, e.userId ?? null, e.username, e.at, e.result, JSON.stringify(e)],
            );
          },
          async putGroup(g) {
            await client.query(
              `INSERT INTO groups (id, channel_id, data) VALUES ($1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, data = EXCLUDED.data`,
              [g.id, g.channelId ?? null, JSON.stringify(g)],
            );
          },
          async deleteGroup(id) {
            await client.query('DELETE FROM groups WHERE id = $1', [id]);
          },
          async putMembership(m) {
            await client.query(
              'INSERT INTO memberships (user_id, group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [m.userId, m.groupId],
            );
          },
          async deleteMembership(m) {
            await client.query('DELETE FROM memberships WHERE user_id = $1 AND group_id = $2', [
              m.userId,
              m.groupId,
            ]);
          },
          async putRole(r) {
            await client.query(
              `INSERT INTO roles (id, channel_id, data) VALUES ($1, $2, $3)
               ON CONFLICT (id) DO UPDATE SET channel_id = EXCLUDED.channel_id, data = EXCLUDED.data`,
              [r.id, r.channelId ?? null, JSON.stringify(r)],
            );
          },
          async deleteRole(id) {
            await client.query('DELETE FROM roles WHERE id = $1', [id]);
          },
          async putAssignment(a) {
            await client.query(
              `INSERT INTO assignments (id, user_id, role_id, data) VALUES ($1, $2, $3, $4)
               ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, role_id = EXCLUDED.role_id, data = EXCLUDED.data`,
              [a.id, a.userId, a.roleId ?? null, JSON.stringify(a)],
            );
          },
          async deleteAssignment(id) {
            await client.query('DELETE FROM assignments WHERE id = $1', [id]);
          },
          async enqueue(record) {
            await outbox.enqueue(client, record);
          },
        };
        return fn(tx);
      });
    },
    async user(id) {
      return (await docs<User>(pool, 'SELECT data FROM users WHERE id = $1', [id]))[0];
    },
    async userByUsername(username) {
      return (await docs<User>(pool, 'SELECT data FROM users WHERE username = $1', [username]))[0];
    },
    async users(options = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (options.channelId !== undefined) {
        params.push(options.channelId);
        clauses.push(`channel_id = $${params.length}`);
      }
      if (options.after !== undefined) {
        params.push(options.after);
        clauses.push(`id > $${params.length}`);
      }
      params.push(options.limit ?? 100);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      return docs<User>(
        pool,
        `SELECT data FROM users ${where} ORDER BY id LIMIT $${params.length}`,
        params,
      );
    },
    async credential(userId) {
      const { rows } = await pool.query<{ user_id: string; hash: string; updated_at: Date }>(
        'SELECT user_id, hash, updated_at FROM credentials WHERE user_id = $1',
        [userId],
      );
      const row = rows[0];
      return row
        ? { userId: row.user_id, hash: row.hash, updatedAt: row.updated_at.toISOString() }
        : undefined;
    },
    async refreshTokenByHash(tokenHash) {
      const { rows } = await pool.query<TokenRow>(
        'SELECT * FROM refresh_tokens WHERE token_hash = $1',
        [tokenHash],
      );
      return rows[0] ? toToken(rows[0]) : undefined;
    },
    async family(familyId) {
      const { rows } = await pool.query<TokenRow>(
        'SELECT * FROM refresh_tokens WHERE family_id = $1 ORDER BY created_at, id',
        [familyId],
      );
      return rows.map(toToken);
    },
    async userTokens(userId) {
      const { rows } = await pool.query<TokenRow>(
        'SELECT * FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at, id',
        [userId],
      );
      return rows.map(toToken);
    },
    async loginEvents(options = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (options.userId !== undefined) {
        params.push(options.userId);
        clauses.push(`user_id = $${params.length}`);
      }
      if (options.username !== undefined) {
        params.push(options.username);
        clauses.push(`username = $${params.length}`);
      }
      params.push(options.limit ?? 100);
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      return docs<LoginEvent>(
        pool,
        `SELECT data FROM login_events ${where} ORDER BY at DESC, id DESC LIMIT $${params.length}`,
        params,
      );
    },
    async group(id) {
      return (await docs<Group>(pool, 'SELECT data FROM groups WHERE id = $1', [id]))[0];
    },
    async groups(options = {}) {
      return options.channelId !== undefined
        ? docs<Group>(
            pool,
            'SELECT data FROM groups WHERE channel_id = $1 OR channel_id IS NULL ORDER BY id',
            [options.channelId],
          )
        : docs<Group>(pool, 'SELECT data FROM groups ORDER BY id', []);
    },
    async memberships(userId) {
      const { rows } = await pool.query<{ user_id: string; group_id: string }>(
        'SELECT user_id, group_id FROM memberships WHERE user_id = $1 ORDER BY group_id',
        [userId],
      );
      return rows.map(toMembership);
    },
    async members(groupId) {
      const { rows } = await pool.query<{ user_id: string; group_id: string }>(
        'SELECT user_id, group_id FROM memberships WHERE group_id = $1 ORDER BY user_id',
        [groupId],
      );
      return rows.map(toMembership);
    },
    async role(id) {
      return (await docs<StoredRole>(pool, 'SELECT data FROM roles WHERE id = $1', [id]))[0];
    },
    async roles(options = {}) {
      return options.channelId !== undefined
        ? docs<StoredRole>(
            pool,
            'SELECT data FROM roles WHERE channel_id = $1 OR channel_id IS NULL ORDER BY id',
            [options.channelId],
          )
        : docs<StoredRole>(pool, 'SELECT data FROM roles ORDER BY id', []);
    },
    async assignments(userId) {
      return docs<Assignment>(pool, 'SELECT data FROM assignments WHERE user_id = $1 ORDER BY id', [
        userId,
      ]);
    },
    async roleHolders(roleId) {
      const [assignments, groups] = await Promise.all([
        docs<Assignment>(pool, 'SELECT data FROM assignments WHERE role_id = $1 ORDER BY id', [
          roleId,
        ]),
        // `@>` containment, which the GIN index above serves. Built as a parameter rather than
        // interpolated: a role id reaches this from a URL path.
        docs<Group>(pool, 'SELECT data FROM groups WHERE data @> $1::jsonb ORDER BY id', [
          JSON.stringify({ roleIds: [roleId] }),
        ]),
      ]);
      return { assignments, groups };
    },
    async close() {
      await pool.end();
    },
  };
}

interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  family_id: string;
  expires_at: Date;
  created_at: Date;
  revoked_at: Date | null;
  rotated_from: string | null;
}

const toToken = (r: TokenRow): RefreshTokenRecord => ({
  id: r.id,
  userId: r.user_id,
  tokenHash: r.token_hash,
  familyId: r.family_id,
  expiresAt: r.expires_at.toISOString(),
  createdAt: r.created_at.toISOString(),
  ...(r.revoked_at !== null ? { revokedAt: r.revoked_at.toISOString() } : {}),
  ...(r.rotated_from !== null ? { rotatedFrom: r.rotated_from } : {}),
});

const toMembership = (r: { user_id: string; group_id: string }): Membership => ({
  userId: r.user_id,
  groupId: r.group_id,
});
