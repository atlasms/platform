// EP-27.4 — field schemas administered: every problem placed at its path, a new schema minted,
// a replacement compare-and-set on the version read, and every write audited in its transaction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Envelope } from '@atlas/contracts';
import { compile } from '@atlas/policy';
import { buildMamApp, MamService, type Caller, type FieldSchema } from '../src/index.ts';
import { seededStore } from './categories.fixture.ts';

function harness() {
  const store = seededStore();
  const service = new MamService({ store });
  const caller = (permissions = ['asset:read', 'taxonomy:admin', 'taxonomy:read']): Caller => ({
    userId: 'ana',
    channelId: 'ch12',
    policy: compile({
      subjectId: 'ana',
      permVersion: 1,
      rules: [{ id: 'r', permissions, scope: { channelIds: ['ch12'] } }],
    }),
  });
  const audits = () =>
    (store.db.prepare('SELECT body FROM outbox ORDER BY rowid').all() as { body: string }[])
      .map((r) => JSON.parse(r.body) as Envelope)
      .filter((e) => e.type === 'audit.recorded')
      .map(
        (e) =>
          e.payload as { entityType: string; entityId: string; revision: number; action: string },
      );
  return { store, service, caller, audits };
}

const input = (overrides: Partial<FieldSchema> = {}) =>
  ({
    mediaType: 'video',
    categoryPath: '/sports/',
    fields: [
      { name: 'competition', label: 'Competition', type: 'enum', options: ['League', 'Cup'] },
      { name: 'rating', label: 'Rating', type: 'number', required: true },
    ],
    ...overrides,
  }) as FieldSchema;

test('a new schema is minted — id, version 1, the caller’s channel — and audited with it', async () => {
  const h = harness();
  const created = await h.service.putSchema(h.caller(), input());
  assert.match(created.id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(created.version, 1);
  assert.equal(created.channelId, 'ch12');
  const [stored] = await h.service.schemas(h.caller());
  assert.deepEqual(stored, created);
  assert.deepEqual(
    h.audits().map((a) => [a.entityType, a.entityId, a.revision, a.action]),
    [['field-schema', created.id, 1, 'field-schema.created']],
  );
});

test('a replacement is compare-and-set on the version read: stale is a 409, never an overwrite', async () => {
  const h = harness();
  const created = await h.service.putSchema(h.caller(), input());
  const renamed = input({
    id: created.id,
    fields: [{ name: 'competition', label: 'Tournament', type: 'string' }],
  });
  const v2 = await h.service.putSchema(h.caller(), renamed, 1);
  assert.equal(v2.version, 2);
  // A second administrator who read version 1 does not write over the first one's change.
  await assert.rejects(
    h.service.putSchema(h.caller(), input({ id: created.id }), 1),
    (e: Error & { status?: number }) =>
      e.status === 409 && /changed since version 1/.test(e.message),
  );
  // An existing id without a version is not a silent replacement either.
  await assert.rejects(
    h.service.putSchema(h.caller(), input({ id: created.id })),
    (e: Error & { status?: number }) => e.status === 409,
  );
  await assert.rejects(
    h.service.putSchema(h.caller(), input({ id: 'unknown-schema' }), 3),
    (e: Error & { status?: number }) => e.status === 404,
  );
  assert.deepEqual(
    h.audits().map((a) => [a.revision, a.action]),
    [
      [1, 'field-schema.created'],
      [2, 'field-schema.updated'],
    ],
  );
  assert.equal((await h.service.schemas(h.caller()))[0]?.fields[0]?.label, 'Tournament');
});

test('every problem is placed at its path, all at once — nothing is stored', async () => {
  const h = harness();
  const bad = {
    mediaType: 'Video Clips',
    categoryPath: 'sports',
    fields: [
      { name: 'competition', label: 'Competition', type: 'enum' },
      { name: 'competition', label: '', type: 'string', options: ['x'] },
      { name: '9lives', label: 'Lives', type: 'colour' },
      { name: 'notes', label: 'Notes', type: 'boolean', maxLength: 10 },
      { name: 'genre', label: 'Genre', type: 'vocabulary', fieldGroup: 'secret' },
      { name: 'extra', label: 'Extra', type: 'string', colour: 'red' },
    ],
  } as unknown as FieldSchema;
  await assert.rejects(
    h.service.putSchema(h.caller(), bad),
    (
      e: Error & {
        status?: number;
        details?: { problems: { path: string }[] };
      },
    ) => {
      assert.equal(e.status, 422);
      assert.deepEqual(
        e.details?.problems.map((p) => p.path),
        [
          'mediaType',
          'categoryPath',
          'fields[0].options',
          'fields[1].name',
          'fields[1].label',
          'fields[1].options',
          'fields[2].name',
          'fields[2].type',
          'fields[3].maxLength',
          'fields[4].vocabulary',
          'fields[4].fieldGroup',
          'fields[5].colour',
        ],
      );
      return true;
    },
  );
  assert.deepEqual(await h.service.schemas(h.caller()), []);
  assert.deepEqual(h.audits(), []);
});

test('PUT /field-schemas?version= over HTTP — the problem document carries details.problems', async () => {
  const h = harness();
  const app = await buildMamApp({ service: h.service, policyFor: () => h.caller().policy });
  const headers = {
    'x-atlas-user': 'ana',
    'x-atlas-channel': 'ch12',
    'content-type': 'application/json',
  };
  const created = await app.inject({
    method: 'PUT',
    url: '/api/v1/field-schemas',
    headers,
    payload: input(),
  });
  assert.equal(created.statusCode, 200, created.body);
  const { id } = created.json<{ id: string }>();
  const replaced = await app.inject({
    method: 'PUT',
    url: '/api/v1/field-schemas?version=1',
    headers,
    payload: input({ id }),
  });
  assert.equal(replaced.json<{ version: number }>().version, 2);
  const stale = await app.inject({
    method: 'PUT',
    url: '/api/v1/field-schemas?version=1',
    headers,
    payload: input({ id }),
  });
  assert.equal(stale.statusCode, 409);
  const refused = await app.inject({
    method: 'PUT',
    url: '/api/v1/field-schemas',
    headers,
    payload: { mediaType: 'video', fields: [{ name: 'x', label: 'X', type: 'enum' }] },
  });
  assert.equal(refused.statusCode, 422);
  assert.deepEqual(
    refused
      .json<{ details: { problems: { path: string }[] } }>()
      .details.problems.map((p) => p.path),
    ['fields[0].options'],
  );
  await app.close();
});
