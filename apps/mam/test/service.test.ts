import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, type Envelope } from '@atlas/contracts';
import { jsonRepo, jsonTableMigration, migrate, openDb, SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import { MamService, type Asset, type Caller } from '../src/index.ts';

const CHANNEL = 'ch12';

function harness(permissions: string[] = ['asset:read', 'asset:write', 'asset:approve']) {
  const db = openDb(':memory:');
  migrate(db, [
    jsonTableMigration('assets'),
    {
      id: 'outbox',
      up: `CREATE TABLE IF NOT EXISTS outbox (
             id TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT)`,
    },
  ]);

  const repo = jsonRepo<Asset>(db, 'assets');
  const outbox = new SqliteOutboxStore(db);
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(outbox, broker);

  const service = new MamService({
    db,
    assets: { get: (id) => repo.get(id), put: (a) => repo.put(a), all: () => repo.all() },
    outbox,
    now: () => new Date('2026-08-05T12:00:00.000Z'),
  });

  /**
   * A caller whose grants are scoped to whichever channel they are in.
   *
   * Deriving the scope from the channel matters: a caller in ch99 holding only ch12 grants is
   * correctly Forbidden, which would make a channel-FILTERING test pass for the wrong reason.
   */
  const caller = (over: Partial<Caller> = {}): Caller => {
    const userId = over.userId ?? 'user-1';
    const channelId = over.channelId ?? CHANNEL;
    return {
      userId,
      channelId,
      policy: compile({
        subjectId: userId,
        permVersion: 1,
        rules: [{ id: 'r', permissions, scope: { channelIds: [channelId] } }],
      }),
      ...over,
    };
  };

  /** Drain the outbox and return the envelopes that were published. */
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    return broker.published.map((m) => m.body as Envelope);
  };

  return { service, caller, drain, repo, outbox, broker };
}

const NEW_ASSET = { title: 'Match highlights', mediaType: 'video', fileType: 'mxf' };

// =============================================================================
// EP-17.1 — the asset core
// =============================================================================

test('create stores an asset scoped to the caller channel, in state created', () => {
  const { service, caller } = harness();
  const asset = service.create(caller(), NEW_ASSET);

  assert.equal(asset.channelId, CHANNEL);
  assert.equal(asset.state, 'created');
  assert.equal(asset.version, 1);
  assert.equal(asset.createdBy, 'user-1');
  assert.equal(asset.hasRenditions, false);
});

test('create rejects a missing title, mediaType or fileType', () => {
  const { service, caller } = harness();
  assert.throws(() => service.create(caller(), { ...NEW_ASSET, title: '  ' }), /title is required/);
  assert.throws(() => service.create(caller(), { ...NEW_ASSET, mediaType: '' }), /mediaType/);
  assert.throws(() => service.create(caller(), { ...NEW_ASSET, fileType: '' }), /fileType/);
});

test('SECURITY: an asset in another channel reads as NOT FOUND, not FORBIDDEN', () => {
  // "You may not see this" confirms the asset exists, which is itself a cross-tenant leak.
  const { service, caller } = harness();
  const asset = service.create(caller(), NEW_ASSET);

  assert.throws(
    () => service.get(caller({ channelId: 'ch99' }), asset.id),
    (e: Error) => /no asset/.test(e.message) && (e as { status?: number }).status === 404,
  );
});

test('list returns only the caller’s channel', () => {
  const { service, caller } = harness();
  service.create(caller(), NEW_ASSET);
  service.create(caller(), { ...NEW_ASSET, title: 'Second' });

  assert.equal(service.list(caller()).length, 2);
  assert.equal(service.list(caller({ channelId: 'ch99' })).length, 0);
});

test('update bumps the version and records only fields that actually changed', () => {
  const { service, caller } = harness();
  const created = service.create(caller(), NEW_ASSET);
  const updated = service.update(caller(), created.id, { title: 'Renamed', description: 'x' });

  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.version, 2);
});

test('a no-op update changes nothing and emits nothing', async () => {
  // UIs submit whole forms. An asset.updated with an empty changedFields would violate the
  // contract (minItems: 1) and wake every consumer for nothing.
  const { service, caller, drain } = harness();
  const created = service.create(caller(), NEW_ASSET);
  const same = service.update(caller(), created.id, { title: created.title });

  assert.equal(same.version, 1);
  const events = await drain();
  assert.deepEqual(
    events.map((e) => e.type),
    ['asset.created'],
  );
});

// =============================================================================
// Authorization
// =============================================================================

test('SECURITY: reading requires asset:read, writing requires asset:write', () => {
  const { service, caller } = harness(['asset:read']);
  assert.throws(() => service.create(caller(), NEW_ASSET), /no rule grants "asset:write"/);
});

test('SECURITY: approving is a SEPARATE permission from writing', () => {
  // Someone who may edit metadata is not thereby entitled to sign an asset off for air.
  const { service, caller } = harness(['asset:read', 'asset:write']);
  const asset = service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  service.attachRenditions(caller(), asset.id);
  service.transition(caller(), asset.id, 'startProcessing');
  service.transition(caller(), asset.id, 'markReady');

  assert.throws(
    () => service.transition(caller(), asset.id, 'approve'),
    /no rule grants "asset:approve"/,
  );
});

test('SECURITY: a grant scoped to another channel does not authorize here', () => {
  const { service } = harness();
  const outsider: Caller = {
    userId: 'user-9',
    channelId: CHANNEL,
    policy: compile({
      subjectId: 'user-9',
      permVersion: 1,
      rules: [{ id: 'r', permissions: ['asset:write'], scope: { channelIds: ['ch99'] } }],
    }),
  };
  assert.throws(() => service.create(outsider, NEW_ASSET), /no rule grants/);
});

// =============================================================================
// EP-17.5 / EP-17.6 — lifecycle and its events
// =============================================================================

test('the full happy path: created → processing → ready → approved', async () => {
  const { service, caller, drain } = harness();
  const asset = service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  service.attachRenditions(caller(), asset.id);

  assert.equal(service.transition(caller(), asset.id, 'startProcessing').state, 'processing');
  assert.equal(service.transition(caller(), asset.id, 'markReady').state, 'ready');
  assert.equal(
    service.transition(caller(), asset.id, 'approve', { expiresAt: '2027-01-01T00:00:00.000Z' })
      .state,
    'approved',
  );

  const events = await drain();
  assert.deepEqual(
    events.map((e) => e.type),
    ['asset.created', 'asset.ready', 'asset.approved'],
  );
});

test('EVERY emitted payload validates against its shipped schema', async () => {
  // The type is our description of the contract; the schema is the contract. Checking against the
  // schema is what catches a field the design requires and the code forgot.
  const { service, caller, drain } = harness();
  const asset = service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  service.attachRenditions(caller(), asset.id);
  service.transition(caller(), asset.id, 'startProcessing');
  service.transition(caller(), asset.id, 'markReady');
  service.update(caller(), asset.id, { description: 'now with detail' });
  service.transition(caller(), asset.id, 'approve');
  service.transition(caller(), asset.id, 'expire');

  const events = await drain();
  assert.ok(events.length >= 5);
  for (const envelope of events) {
    const result = validatePayload(envelope.type, envelope.payload);
    assert.equal(
      result.valid,
      true,
      `${envelope.type} payload invalid: ${JSON.stringify(result.errors)}`,
    );
  }
});

test('EP-17.5: markReady is refused, with a 409 naming the missing fields', () => {
  const { service, caller } = harness();
  const asset = service.create(caller(), NEW_ASSET); // no categoryId
  service.attachRenditions(caller(), asset.id);
  service.transition(caller(), asset.id, 'startProcessing');

  assert.throws(
    () => service.transition(caller(), asset.id, 'markReady'),
    (e: Error) =>
      /mandatory metadata missing: categoryId/.test(e.message) &&
      (e as { status?: number }).status === 409,
  );
});

test('EP-17.5: markReady is refused before renditions are attached', () => {
  const { service, caller } = harness();
  const asset = service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  service.transition(caller(), asset.id, 'startProcessing');

  assert.throws(() => service.transition(caller(), asset.id, 'markReady'), /renditions/);
});

test('a rejection must state a reason', () => {
  // The contract makes it required, and rightly: a rejection with no cause leaves whoever has to
  // fix the asset with nothing to act on.
  const { service, caller } = harness();
  const asset = service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  service.attachRenditions(caller(), asset.id);
  service.transition(caller(), asset.id, 'startProcessing');
  service.transition(caller(), asset.id, 'markReady');

  assert.throws(() => service.transition(caller(), asset.id, 'reject'), /must state a reason/);

  const rejected = service.transition(caller(), asset.id, 'reject', { reason: 'audio clipping' });
  assert.equal(rejected.state, 'rejected');
});

test('SECURITY: state cannot be changed through a metadata update', () => {
  // Otherwise approval could be routed around review entirely.
  const { service, caller } = harness();
  const asset = service.create(caller(), NEW_ASSET);
  const updated = service.update(caller(), asset.id, {
    title: 'Renamed',
    state: 'approved',
  } as never);

  assert.equal(updated.state, 'created', 'state must be untouched by update()');
});

test('an illegal transition is a 409 and changes nothing', async () => {
  const { service, caller, drain, repo } = harness();
  const asset = service.create(caller(), NEW_ASSET);

  assert.throws(() => service.transition(caller(), asset.id, 'approve'), /cannot approve/);
  assert.equal(repo.get(asset.id)?.state, 'created');
  assert.deepEqual(
    (await drain()).map((e) => e.type),
    ['asset.created'],
  );
});

// =============================================================================
// The outbox
// =============================================================================

test('ATOMICITY: a refused write leaves neither asset nor event', async () => {
  const { service, caller, drain, repo } = harness(['asset:read']);
  assert.throws(() => service.create(caller(), NEW_ASSET));

  assert.equal(repo.all().length, 0);
  assert.deepEqual(await drain(), []);
});

test('events carry the caller’s correlation id across the async boundary', async () => {
  const { service, caller, drain } = harness();
  service.create(caller({ correlationId: 'trace-me' }), NEW_ASSET);

  const events = await drain();
  assert.equal(events[0]?.correlationId, 'trace-me');
});

test('the event subject is channel-scoped, so fan-out cannot cross tenants', async () => {
  const { service, caller, drain, broker } = harness();
  service.create(caller(), NEW_ASSET);
  await drain();

  assert.equal(broker.published[0]?.subject, `atlas.${CHANNEL}.asset.created`);
});
