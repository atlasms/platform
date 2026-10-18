// EP-25.6 — a person's notification preferences, decided 2026-10-18: per type on or off, the
// channel's `defaultOn` until they choose, and a `mandatory` type cannot be turned off (the write is
// refused). Through the routes, with the pipeline and the inbox honouring them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, subjectFor, ulid, type Envelope } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { compile, type Rule } from '@atlas/policy';
import {
  buildNotificationsApp,
  INTERNAL_HEADERS,
  NotificationPipeline,
  NotificationsService,
  PreferencesService,
  sqliteInboxStore,
  type PreferenceView,
} from '../src/index.ts';

const CH = 'ch12';

async function harness() {
  const store = sqliteInboxStore();
  const rules: Record<string, Rule[]> = {
    ana: [{ id: 'r', permissions: ['asset:read', 'ops:read'] }],
    cat: [{ id: 'r', permissions: ['config:admin'] }],
  };
  const policyFor = (userId: string) =>
    compile({
      subjectId: userId,
      permVersion: 1,
      rules: rules[userId] ?? [],
      roles: [],
      groups: [],
    });
  const pipeline = new NotificationPipeline({ store, policyFor });
  const service = new NotificationsService({ store, policyFor });
  const app = await buildNotificationsApp({
    service,
    pipeline,
    preferences: new PreferencesService({ store }),
    policyFor,
  });
  const call = (userId: string, method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        [INTERNAL_HEADERS.user]: userId,
        [INTERNAL_HEADERS.channel]: CH,
        'content-type': 'application/json',
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const prefs = async (userId: string) =>
    (await call(userId, 'GET', '/api/v1/preferences')).json<{
      items: PreferenceView[];
      version: number;
    }>();
  const event = (type: string, payload: Record<string, unknown>) => {
    const e = buildEnvelope({
      type,
      channelId: CH,
      payload,
      actor: { kind: 'service', id: 'mam' },
    });
    return { id: e.messageId, subject: subjectFor(CH, type), body: e };
  };
  const approved = () =>
    pipeline.consumeAssetApproved(
      event('asset.approved', { assetId: ulid(), approver: 'cat', createdBy: 'ana' }),
    );
  return {
    call,
    prefs,
    pipeline,
    service,
    approved,
    event,
    outbox: new SqliteOutboxStore(store.db),
  };
}

test('until they choose, every type is its default; a mandatory one is on and not theirs to choose', async () => {
  const h = await harness();
  const { items, version } = await h.prefs('ana');
  assert.equal(version, 0);
  const of = (key: string) => items.find((i) => i.key === key);
  assert.deepEqual(of('asset.approved'), {
    key: 'asset.approved',
    on: true,
    defaultOn: true,
    mandatory: false,
    chosen: false,
  });
  assert.deepEqual([of('asset.re-review-due')?.mandatory, of('alert')?.mandatory], [true, true]);
});

test('turned off, a type is not raised for them — compare-and-set, audited, the rest unchanged', async () => {
  const h = await harness();
  const saved = await h.call('ana', 'PUT', '/api/v1/preferences?version=0', {
    types: { 'asset.approved': false },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const view = saved.json<{ items: PreferenceView[]; version: number }>();
  assert.deepEqual(
    [view.version, view.items.find((i) => i.key === 'asset.approved')],
    [1, { key: 'asset.approved', on: false, defaultOn: true, mandatory: false, chosen: true }],
  );
  assert.equal(await h.approved(), 'skipped', 'not raised for them');
  assert.equal(
    await h.pipeline.consumeAssetRejected(
      h.event('asset.rejected', { assetId: ulid(), reason: 'soft', createdBy: 'ana' }),
    ),
    'applied',
    'another type still is',
  );
  // Stale: someone saved in between.
  assert.equal(
    (await h.call('ana', 'PUT', '/api/v1/preferences?version=0', { types: {} })).statusCode,
    409,
  );
  const audit = (await h.outbox.listUnsent(100))
    .map((r) => r.message.body as Envelope)
    .find((e) => e.type === 'audit.recorded');
  assert.deepEqual((audit?.payload as { entityId: string }).entityId, `${CH}:ana`);
  // Back on.
  assert.equal(
    (await h.call('ana', 'PUT', '/api/v1/preferences?version=1', { types: {} })).statusCode,
    200,
  );
  assert.equal(await h.approved(), 'applied');
});

test('a mandatory type cannot be turned off; an unknown type is refused', async () => {
  const h = await harness();
  const mandatory = await h.call('ana', 'PUT', '/api/v1/preferences?version=0', {
    types: { 'asset.re-review-due': false },
  });
  assert.equal(mandatory.statusCode, 422);
  assert.match(mandatory.body, /mandatory/);
  const unknown = await h.call('ana', 'PUT', '/api/v1/preferences?version=0', {
    types: { 'asset.deleted': false },
  });
  assert.equal(unknown.statusCode, 422);
  assert.equal((await h.prefs('ana')).version, 0, 'nothing was written');
});

test('the channel’s default and mandatory decide what a person has not chosen — alerts included', async () => {
  const h = await harness();
  // The operator makes approvals opt-in, and alerts optional.
  for (const [key, body] of [
    ['asset.approved', { defaultOn: false }],
    ['alert', { mandatory: false }],
  ] as const)
    assert.equal(
      (await h.call('cat', 'PUT', `/api/v1/notification-types/${key}?version=0`, body)).statusCode,
      200,
    );
  assert.equal(await h.approved(), 'skipped', 'off by default now');

  await h.pipeline.consumeAlertRaised(
    h.event('alert.raised', {
      alertId: ulid(),
      source: 'rim',
      kind: 'recording-missed',
      severity: 'critical',
      message: 'a recording was missed',
      raisedAt: new Date().toISOString(),
    }),
  );
  const inbox = () => h.service.inbox({ userId: 'ana', channelId: CH });
  assert.equal((await inbox()).unreadCount, 1);
  // ana turns alerts off: no longer shown, nor counted.
  assert.equal(
    (await h.call('ana', 'PUT', '/api/v1/preferences?version=0', { types: { alert: false } }))
      .statusCode,
    200,
  );
  const after = await inbox();
  assert.deepEqual([after.notifications.length, after.unreadCount], [0, 0]);
});
