import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload, type Envelope, type EventPayloads } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import { MamService, sqliteAssetStore, type Caller } from '../src/index.ts';

const CHANNEL = 'ch12';

function harness(permissions: string[] = ['asset:read', 'asset:write', 'asset:approve']) {
  const store = sqliteAssetStore();
  // The relay reads the same database the service writes to — which is the point: it drains what
  // the domain transaction committed, never a copy handed to it.
  const outbox = new SqliteOutboxStore(store.db);
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(outbox, broker);

  const service = new MamService({
    store,
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

  return { service, caller, drain, store, outbox, broker };
}

const NEW_ASSET = { title: 'Match highlights', mediaType: 'video', fileType: 'mxf' };

// =============================================================================
// EP-17.1 — the asset core
// =============================================================================

test('create stores an asset scoped to the caller channel, in state created', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);

  assert.equal(asset.channelId, CHANNEL);
  assert.equal(asset.state, 'created');
  assert.equal(asset.version, 1);
  assert.equal(asset.createdBy, 'user-1');
  assert.equal(asset.hasRenditions, false);
});

test('create rejects a missing title, mediaType or fileType', async () => {
  const { service, caller } = harness();
  await assert.rejects(
    service.create(caller(), { ...NEW_ASSET, title: '  ' }),
    /title is required/,
  );
  await assert.rejects(service.create(caller(), { ...NEW_ASSET, mediaType: '' }), /mediaType/);
  await assert.rejects(service.create(caller(), { ...NEW_ASSET, fileType: '' }), /fileType/);
});

test('SECURITY: an asset in another channel reads as NOT FOUND, not FORBIDDEN', async () => {
  // "You may not see this" confirms the asset exists, which is itself a cross-tenant leak.
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);

  await assert.rejects(
    service.get(caller({ channelId: 'ch99' }), asset.id),
    (e: Error) => /no asset/.test(e.message) && (e as { status?: number }).status === 404,
  );
});

test('list returns only the caller’s channel', async () => {
  const { service, caller } = harness();
  await service.create(caller(), NEW_ASSET);
  await service.create(caller(), { ...NEW_ASSET, title: 'Second' });

  assert.equal((await service.list(caller())).items.length, 2);
  assert.equal((await service.list(caller({ channelId: 'ch99' }))).items.length, 0);
});

test('update bumps the version and records only fields that actually changed', async () => {
  const { service, caller } = harness();
  const created = await service.create(caller(), NEW_ASSET);
  const updated = await service.update(caller(), created.id, {
    title: 'Renamed',
    description: 'x',
  });

  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.version, 2);
});

test('a no-op update changes nothing and emits nothing', async () => {
  // UIs submit whole forms. An asset.updated with an empty changedFields would violate the
  // contract (minItems: 1) and wake every consumer for nothing.
  const { service, caller, drain } = harness();
  const created = await service.create(caller(), NEW_ASSET);
  const same = await service.update(caller(), created.id, { title: created.title });

  assert.equal(same.version, 1);
  const events = await drain();
  assert.deepEqual(
    events.map((e) => e.type),
    ['asset.created', 'audit.recorded'],
    'creation is announced and audited; the no-op is neither',
  );
});

// =============================================================================
// Authorization
// =============================================================================

test('SECURITY: reading requires asset:read, writing requires asset:write', async () => {
  const { service, caller } = harness(['asset:read']);
  await assert.rejects(service.create(caller(), NEW_ASSET), /no rule grants "asset:write"/);
});

test('SECURITY: approving is a SEPARATE permission from writing', async () => {
  // Someone who may edit metadata is not thereby entitled to sign an asset off for air.
  const { service, caller } = harness(['asset:read', 'asset:write']);
  const asset = await service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  await service.attachRenditions(caller(), asset.id);
  await service.transition(caller(), asset.id, 'startProcessing');
  await service.transition(caller(), asset.id, 'markReady');

  await assert.rejects(
    service.transition(caller(), asset.id, 'approve'),
    /no rule grants "asset:approve"/,
  );
});

test('SECURITY: a grant scoped to another channel does not authorize here', async () => {
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
  await assert.rejects(service.create(outsider, NEW_ASSET), /no rule grants/);
});

// =============================================================================
// EP-17.5 / EP-17.6 — lifecycle and its events
// =============================================================================

test('the full happy path: created → processing → ready → approved', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  await service.attachRenditions(caller(), asset.id);

  assert.equal(
    (await service.transition(caller(), asset.id, 'startProcessing')).state,
    'processing',
  );
  assert.equal((await service.transition(caller(), asset.id, 'markReady')).state, 'ready');
  assert.equal(
    (
      await service.transition(caller(), asset.id, 'approve', {
        expiresAt: '2027-01-01T00:00:00.000Z',
      })
    ).state,
    'approved',
  );

  const events = await drain();
  assert.deepEqual(
    events.filter((e) => e.type !== 'audit.recorded').map((e) => e.type),
    ['asset.created', 'asset.ready', 'asset.approved'],
  );
  // EP-19.2: EVERY mutation leaves an audit record — including attachRenditions and the internal
  // startProcessing step, which used to commit with a bare put that nothing could account for.
  const audits = events
    .filter((e) => e.type === 'audit.recorded')
    .map((e) => e.payload as unknown as EventPayloads['audit.recorded']);
  assert.deepEqual(
    audits.map((a) => [a.action, a.revision]),
    [
      ['asset.created', 1],
      ['asset.attachRenditions', 2],
      ['asset.startProcessing', 3],
      ['asset.ready', 4],
      ['asset.approved', 5],
    ],
    'one record per mutation, revision aligned with the asset version',
  );
  // Domain event first, then its audit — the relay publishes in outbox order.
  assert.equal(events[0]?.type, 'asset.created');
  assert.equal(events[1]?.type, 'audit.recorded');
});

/** The most recent audit record the relay has published — `drain()` is cumulative. */
const lastAudit = (events: Envelope[]): EventPayloads['audit.recorded'] => {
  const audits = events.filter((e) => e.type === 'audit.recorded');
  const last = audits[audits.length - 1];
  assert.ok(last, 'no audit record was published');
  return last.payload as unknown as EventPayloads['audit.recorded'];
};

test('EP-19.2: the audit record carries the field-level before/after, at write time', async () => {
  const { service, caller, drain } = harness();
  const created = await service.create(caller(), {
    ...NEW_ASSET,
    title: 'First',
    categoryId: 'cat-1', // markReady's metadata gate, later in the test
  });

  // A creation: every field is an `after`, nothing is a `before`.
  let audit = lastAudit(await drain());
  assert.equal(audit.entityType, 'asset');
  assert.equal(audit.entityId, created.id);
  assert.equal(audit.action, 'asset.created');
  assert.equal(audit.revision, 1);
  assert.deepEqual(audit.origin, { service: 'mam' });
  assert.deepEqual(audit.delta['title'], { after: 'First' });
  assert.deepEqual(audit.delta['id'], { after: created.id });
  assert.ok(
    Object.values(audit.delta).every((d) => d.before === undefined),
    'no befores at birth',
  );

  // A metadata change: only the fields that changed, with both sides.
  await service.update(caller(), created.id, { title: 'Second' });
  audit = lastAudit(await drain());
  assert.equal(audit.action, 'asset.updated');
  assert.equal(audit.revision, 2);
  // Checked BEFORE the deepEqual, which narrows `delta` to exactly that shape.
  const keys = Object.keys(audit.delta);
  assert.ok(!keys.includes('updatedAt'), 'always-changing fields are not noise in a diff');
  assert.ok(!keys.includes('version'), 'version IS revision, on the record');
  assert.deepEqual(audit.delta, { title: { before: 'First', after: 'Second' } });

  // A lifecycle transition: the state, and what the transition set.
  await service.attachRenditions(caller(), created.id);
  await service.transition(caller(), created.id, 'startProcessing');
  await service.transition(caller(), created.id, 'markReady');
  await service.transition(caller(), created.id, 'approve', {
    expiresAt: '2027-01-01T00:00:00.000Z',
  });
  audit = lastAudit(await drain());
  assert.equal(audit.action, 'asset.approved');
  assert.equal(audit.revision, 6);
  assert.deepEqual(audit.delta, {
    state: { before: 'ready', after: 'approved' },
    expiresAt: { after: '2027-01-01T00:00:00.000Z' },
  });
});

test('EP-19.2: side-table changes — the tag list — are in the delta', async () => {
  // `tags` (and `extended`) do not live on the Asset row, so a record diff would show only the
  // version bump. The caller holds both states and supplies the entry; this pins that it does.
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), NEW_ASSET);

  await service.setTags(caller(), asset.id, ['sport', 'live']);
  assert.deepEqual(lastAudit(await drain()).delta['tags'], {
    before: [],
    after: ['live', 'sport'],
  });

  await service.setTags(caller(), asset.id, ['live']);
  assert.deepEqual(lastAudit(await drain()).delta['tags'], {
    before: ['live', 'sport'],
    after: ['live'],
  });
});

test('EP-19.2: the audit record commits WITH the change, or neither does', async () => {
  // The dual of the outbox guarantee, and it matters more here: the record is what compliance
  // reads. If writing the audit record fails INSIDE the unit of work, the row and the domain event
  // must roll back with it — a change without its record is the one outcome this exists to prevent.
  const { service, caller, drain, store } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  const published = (await drain()).length; // cumulative: creation's two events

  // Fail the SECOND enqueue of the next transaction — the audit record, which follows the domain
  // event — by wrapping the store's unit of work.
  const real = store.transaction.bind(store);
  let enqueues = 0;
  (store as { transaction: typeof store.transaction }).transaction = (fn) =>
    real(async (tx) =>
      fn(
        new Proxy(tx, {
          get: (target, key, receiver) =>
            key === 'enqueue'
              ? async (record: Parameters<typeof tx.enqueue>[0]) => {
                  if (++enqueues === 2) throw new Error('audit write failed');
                  return target.enqueue(record);
                }
              : Reflect.get(target, key, receiver),
        }),
      ),
    );

  await assert.rejects(
    service.update(caller(), asset.id, { title: 'Changed' }),
    /audit write failed/,
  );
  assert.equal(enqueues, 2, 'the domain event was written first, then the audit failed');

  (store as { transaction: typeof store.transaction }).transaction = real;
  assert.equal((await drain()).length, published, 'the domain event rolled back with the record');
  const after = await service.get(caller(), asset.id);
  assert.equal(after.title, NEW_ASSET.title, 'and so did the change');
  assert.equal(after.version, 1);
});

test('EVERY emitted payload validates against its shipped schema', async () => {
  // The type is our description of the contract; the schema is the contract. Checking against the
  // schema is what catches a field the design requires and the code forgot.
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  await service.attachRenditions(caller(), asset.id);
  await service.transition(caller(), asset.id, 'startProcessing');
  await service.transition(caller(), asset.id, 'markReady');
  await service.update(caller(), asset.id, { description: 'now with detail' });
  await service.transition(caller(), asset.id, 'approve');
  await service.transition(caller(), asset.id, 'expire');

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

test('EP-17.5: markReady is refused, with a 409 naming the missing fields', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET); // no categoryId
  await service.attachRenditions(caller(), asset.id);
  await service.transition(caller(), asset.id, 'startProcessing');

  await assert.rejects(
    service.transition(caller(), asset.id, 'markReady'),
    (e: Error) =>
      /mandatory metadata missing: categoryId/.test(e.message) &&
      (e as { status?: number }).status === 409,
  );
});

test('EP-17.5: markReady is refused before renditions are attached', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  await service.transition(caller(), asset.id, 'startProcessing');

  await assert.rejects(service.transition(caller(), asset.id, 'markReady'), /renditions/);
});

test('a rejection must state a reason', async () => {
  // The contract makes it required, and rightly: a rejection with no cause leaves whoever has to
  // fix the asset with nothing to act on.
  const { service, caller } = harness();
  const asset = await service.create(caller(), { ...NEW_ASSET, categoryId: 'cat-1' });
  await service.attachRenditions(caller(), asset.id);
  await service.transition(caller(), asset.id, 'startProcessing');
  await service.transition(caller(), asset.id, 'markReady');

  await assert.rejects(service.transition(caller(), asset.id, 'reject'), /must state a reason/);

  const rejected = await service.transition(caller(), asset.id, 'reject', {
    reason: 'audio clipping',
  });
  assert.equal(rejected.state, 'rejected');
});

test('SECURITY: state cannot be changed through a metadata update', async () => {
  // Otherwise approval could be routed around review entirely.
  const { service, caller } = harness();
  const asset = await service.create(caller(), NEW_ASSET);
  const updated = await service.update(caller(), asset.id, {
    title: 'Renamed',
    state: 'approved',
  } as never);

  assert.equal(updated.state, 'created', 'state must be untouched by update()');
});

test('an illegal transition is a 409 and changes nothing', async () => {
  const { service, caller, drain, store } = harness();
  const asset = await service.create(caller(), NEW_ASSET);

  await assert.rejects(service.transition(caller(), asset.id, 'approve'), /cannot approve/);
  assert.equal((await store.get(asset.id))?.state, 'created');
  assert.deepEqual(
    (await drain()).map((e) => e.type),
    ['asset.created', 'audit.recorded'],
  );
});

// =============================================================================
// The outbox
// =============================================================================

test('ATOMICITY: a refused write leaves neither asset nor event', async () => {
  const { service, caller, drain, store } = harness(['asset:read']);
  await assert.rejects(service.create(caller(), NEW_ASSET));

  assert.equal((await store.listByChannel(CHANNEL)).length, 0);
  assert.deepEqual(await drain(), []);
});

test('events carry the caller’s correlation id across the async boundary', async () => {
  const { service, caller, drain } = harness();
  await service.create(caller({ correlationId: 'trace-me' }), NEW_ASSET);

  const events = await drain();
  assert.equal(events[0]?.correlationId, 'trace-me');
});

test('the event subject is channel-scoped, so fan-out cannot cross tenants', async () => {
  const { service, caller, drain, broker } = harness();
  await service.create(caller(), NEW_ASSET);
  await drain();

  assert.equal(broker.published[0]?.subject, `atlas.${CHANNEL}.asset.created`);
});
