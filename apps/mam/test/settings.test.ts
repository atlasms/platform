// EP-33.2 — MAM's Tier-3 settings: the view, a write per level and what it commits with, the
// compare-and-set, the reset, and the first setting that does something — a rejection's retention
// (FR-APP-8; decided 2026-11-27: unset keeps rejected media, exactly as before).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvelope,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import { compile, type Rule } from '@atlas/policy';
import { SettingsCache } from '@atlas/settings';
import { buildMamApp, isMamConfigChange, MamService, type Caller } from '../src/index.ts';
import { seededStore } from './categories.fixture.ts';

const T0 = Date.parse('2026-11-27T10:00:00.000Z');
const ADMIN = '01JDQX00000000000000000AD1';

function harness() {
  const store = seededStore();
  let clock = T0;
  const settingsCache = new SettingsCache({ ttlMs: 60_000, now: () => clock });
  const service = new MamService({ store, now: () => new Date(clock), settingsCache });
  const as = (rules: Rule[], userId = ADMIN, channelId = 'ch12'): Caller => ({
    userId,
    channelId,
    policy: compile({ subjectId: userId, permVersion: 1, rules }),
  });
  const channelAdmin = as([
    {
      id: 'c',
      permissions: ['config:admin', 'asset:read', 'asset:write', 'asset:approve', 'taxonomy:read'],
      scope: { channelIds: ['ch12'] },
    },
  ]);
  const platformAdmin = as([{ id: 'p', permissions: ['config:admin'] }]);
  const reviewer = as(
    [
      {
        id: 'r',
        permissions: ['asset:read', 'asset:write', 'asset:approve'],
        scope: { channelIds: ['ch12'] },
      },
    ],
    'ben',
  );
  const events = <T extends keyof EventPayloads>(type: T) =>
    (store.db.prepare('SELECT body FROM outbox ORDER BY rowid').all() as { body: string }[])
      .map((r) => JSON.parse(r.body) as Envelope<EventPayloads[T]>)
      .filter((e) => e.type === type);
  const ready = async () => {
    const a = await service.create(channelAdmin, {
      title: 'Clip',
      mediaType: 'video',
      fileType: 'mxf',
      categoryId: 'cat-1',
    });
    await service.attachRenditions(channelAdmin, a.id);
    await service.transition(channelAdmin, a.id, 'startProcessing');
    return service.transition(channelAdmin, a.id, 'markReady');
  };
  return {
    store,
    service,
    channelAdmin,
    platformAdmin,
    reviewer,
    as,
    events,
    ready,
    later: (ms: number) => {
      clock += ms;
    },
  };
}

const RETENTION = 'review.rejectedRetention';

test('the view: the descriptor, unset by default, and the level a channel admin may write', async () => {
  const h = harness();
  const view = await h.service.settingsView(h.channelAdmin);
  assert.equal(view.area, 'mam');
  const retention = view.settings.find((s) => s.key === RETENTION);
  assert.ok(retention);
  assert.equal(retention.descriptor.type, 'duration');
  assert.equal(retention.descriptor.scope, 'channel');
  // No default — the decision: unset keeps rejected media.
  assert.deepEqual(retention.resolved, { value: null, origin: 'default', overridable: true });
  assert.deepEqual(retention.levels, {});
  assert.deepEqual(retention.writable, ['channel']);
  // A reviewer without config:* does not read the settings.
  await assert.rejects(
    h.service.settingsView(h.reviewer),
    (e: Error & { status?: number }) => e.status === 403,
  );
});

test('a channel value commits with its audit and config.changed, and bumps the snapshot', async () => {
  const h = harness();
  const before = await h.store.configVersion();
  const one = await h.service.putSetting(
    h.channelAdmin,
    RETENTION,
    { level: 'channel', value: 'P30D' },
    undefined,
  );
  assert.equal(one.resolved.value, 'P30D');
  assert.equal(one.resolved.origin, 'channel');
  assert.equal(one.levels.channel?.version, 1);
  assert.equal(await h.store.configVersion(), before + 1);

  const [audit] = h.events('audit.recorded').filter((e) => e.payload.entityType === 'setting');
  assert.ok(audit);
  assert.deepEqual(audit.payload, {
    entityType: 'setting',
    entityId: 'mam.review.rejectedRetention@channel:ch12',
    revision: 1,
    action: 'setting.set',
    origin: { service: 'mam' },
    delta: { value: { after: 'P30D' } },
  });
  const [changed] = h.events('config.changed');
  assert.ok(changed);
  assert.equal(changed.channelId, 'ch12');
  assert.deepEqual(changed.payload, {
    area: 'mam',
    tier: 'setting',
    keys: [RETENTION],
    scopeLevel: 'channel',
    scopeId: 'ch12',
    configVersion: before + 1,
    actorId: ADMIN,
  });
  assert.equal(validatePayload('config.changed', changed.payload).valid, true);
});

test('a change is compare-and-set on the level’s version; a stale write is a 409', async () => {
  const h = harness();
  await h.service.putSetting(
    h.channelAdmin,
    RETENTION,
    { level: 'channel', value: 'P30D' },
    undefined,
  );
  const v2 = await h.service.putSetting(
    h.channelAdmin,
    RETENTION,
    { level: 'channel', value: 'P7D' },
    1,
  );
  assert.equal(v2.levels.channel?.version, 2);
  for (const version of [undefined, 1, 3]) {
    await assert.rejects(
      h.service.putSetting(h.channelAdmin, RETENTION, { level: 'channel', value: 'P1D' }, version),
      (e: Error & { status?: number }) => e.status === 409,
      String(version),
    );
  }
  const audits = h.events('audit.recorded').filter((e) => e.payload.entityType === 'setting');
  assert.deepEqual(
    audits.map((a) => a.payload.delta),
    [{ value: { after: 'P30D' } }, { value: { before: 'P30D', after: 'P7D' } }],
  );
});

test('the descriptor decides: a bad value is a 422 by key; a deployment value needs an unscoped grant', async () => {
  const h = harness();
  await assert.rejects(
    h.service.putSetting(
      h.channelAdmin,
      RETENTION,
      { level: 'channel', value: 'thirty days' },
      undefined,
    ),
    (e: Error & { status?: number; details?: unknown }) =>
      e.status === 422 && JSON.stringify(e.details).includes('mam.review.rejectedRetention'),
  );
  await assert.rejects(
    h.service.putSetting(
      h.channelAdmin,
      'review.nope',
      { level: 'channel', value: 'P1D' },
      undefined,
    ),
    (e: Error & { status?: number }) => e.status === 404,
  );
  await assert.rejects(
    h.service.putSetting(
      h.channelAdmin,
      RETENTION,
      { level: 'deployment', value: 'P1D' },
      undefined,
    ),
    (e: Error & { status?: number; message: string }) =>
      e.status === 403 && /unscoped config:admin/.test(e.message),
  );
  await assert.rejects(
    h.service.putSetting(
      h.channelAdmin,
      RETENTION,
      { level: 'channel', scopeId: 'ch99', value: 'P1D' },
      undefined,
    ),
    (e: Error & { status?: number }) => e.status === 403,
  );
  await assert.rejects(
    h.service.putSetting(h.reviewer, RETENTION, { level: 'channel', value: 'P1D' }, undefined),
    (e: Error & { status?: number }) => e.status === 403,
  );
  // Nothing was written by any of them.
  assert.equal(h.events('config.changed').length, 0);
});

test('nearest wins: the platform sets a floor, the channel overrides it, a reset falls back', async () => {
  const h = harness();
  await h.service.putSetting(
    h.platformAdmin,
    RETENTION,
    { level: 'deployment', value: 'P365D' },
    undefined,
  );
  let view = await h.service.settingsView(h.channelAdmin);
  let r = view.settings.find((s) => s.key === RETENTION)!;
  assert.equal(r.resolved.value, 'P365D');
  assert.equal(r.resolved.origin, 'deployment');

  await h.service.putSetting(
    h.channelAdmin,
    RETENTION,
    { level: 'channel', value: 'P30D' },
    undefined,
  );
  view = await h.service.settingsView(h.channelAdmin);
  r = view.settings.find((s) => s.key === RETENTION)!;
  assert.equal(r.resolved.value, 'P30D');
  assert.deepEqual(Object.keys(r.levels).sort(), ['channel', 'deployment']);

  const reset = await h.service.resetSetting(h.channelAdmin, RETENTION, 'channel', 1);
  assert.equal(reset.resolved.value, 'P365D');
  assert.equal(reset.resolved.origin, 'deployment');
  assert.equal(reset.levels.channel?.set, false);
  assert.equal(reset.levels.channel?.version, 2);
  const lastAudit = h
    .events('audit.recorded')
    .filter((e) => e.payload.entityType === 'setting')
    .at(-1)!;
  assert.equal(lastAudit.payload.action, 'setting.reset');
  assert.equal(lastAudit.payload.revision, 2);
  // Reset again: already inherited — no write, no event.
  const changes = h.events('config.changed').length;
  await h.service.resetSetting(h.channelAdmin, RETENTION, 'channel', 2);
  assert.equal(h.events('config.changed').length, changes);
  // The deployment row's audit identity is the platform's, not the channel's.
  const deploymentAudit = h
    .events('audit.recorded')
    .find((e) => e.payload.entityId.endsWith('@deployment'));
  assert.equal(deploymentAudit?.payload.entityId, 'mam.review.rejectedRetention@deployment');
});

test('FR-APP-8: unset, a rejection keeps its media — no retainUntil, exactly as before', async () => {
  const h = harness();
  const a = await h.ready();
  const rejected = await h.service.transition(h.reviewer, a.id, 'reject', { reason: 'soft focus' });
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.retainUntil, undefined);
  const [event] = h.events('asset.rejected');
  assert.equal('retainUntil' in event!.payload, false);
});

test('FR-APP-8: with a channel retention, a rejection is kept for that long', async () => {
  const h = harness();
  await h.service.putSetting(
    h.channelAdmin,
    RETENTION,
    { level: 'channel', value: 'P30D' },
    undefined,
  );
  const a = await h.ready();
  const rejected = await h.service.transition(h.reviewer, a.id, 'reject', { reason: 'soft focus' });
  assert.equal(rejected.retainUntil, '2026-12-27T10:00:00.000Z');
  assert.equal(h.events('asset.rejected').at(-1)?.payload.retainUntil, '2026-12-27T10:00:00.000Z');
  // A rejection that states its own date keeps it.
  const b = await h.ready();
  const own = await h.service.transition(h.reviewer, b.id, 'reject', {
    reason: 'wrong cut',
    retainUntil: '2027-06-01T00:00:00.000Z',
  });
  assert.equal(own.retainUntil, '2027-06-01T00:00:00.000Z');
  // And an approval is untouched by it.
  const c = await h.ready();
  const approved = await h.service.transition(h.reviewer, c.id, 'approve', {});
  assert.equal(approved.retainUntil, undefined);
});

test('a write here is seen by the next rejection here at once — not after the cache expires', async () => {
  const h = harness();
  const a = await h.ready();
  // Warm the cache with "unset".
  await h.service.transition(h.reviewer, a.id, 'reject', { reason: 'x' });
  await h.service.putSetting(
    h.channelAdmin,
    RETENTION,
    { level: 'channel', value: 'P1D' },
    undefined,
  );
  const b = await h.ready();
  const rejected = await h.service.transition(h.reviewer, b.id, 'reject', { reason: 'y' });
  assert.equal(rejected.retainUntil, '2026-11-28T10:00:00.000Z');
});

test("another replica's write: config.changed clears this replica's cache; nothing else does", async () => {
  const h = harness();
  // A second MAM over the SAME database, with its own cache — another replica.
  const other = new MamService({ store: h.store, now: () => new Date(T0) });
  const a = await h.ready();
  await h.service.transition(h.reviewer, a.id, 'reject', { reason: 'warm the cache' });
  await other.putSetting(h.channelAdmin, RETENTION, { level: 'channel', value: 'P2D' }, undefined);

  // Until this replica hears of it, it serves what it cached (bounded by the TTL).
  const b = await h.ready();
  assert.equal(
    (await h.service.transition(h.reviewer, b.id, 'reject', { reason: 'stale' })).retainUntil,
    undefined,
  );

  const changed = h.events('config.changed').at(-1)!;
  assert.equal(
    isMamConfigChange({
      id: changed.messageId,
      subject: 'atlas.ch12.config.changed',
      body: changed,
    }),
    true,
  );
  h.service.onConfigChanged();
  const c = await h.ready();
  assert.equal(
    (await h.service.transition(h.reviewer, c.id, 'reject', { reason: 'fresh' })).retainUntil,
    '2026-11-29T10:00:00.000Z',
  );
  // Another area's change is not MAM's to act on.
  const hsm = buildEnvelope({
    type: 'config.changed',
    channelId: 'ch12',
    payload: { area: 'hsm', tier: 'setting', configVersion: 4 },
  });
  assert.equal(
    isMamConfigChange({ id: hsm.messageId, subject: 'atlas.ch12.config.changed', body: hsm }),
    false,
  );
});

test('the reference snapshot carries the resolved settings for the channel', async () => {
  const h = harness();
  const reader = h.as([
    { id: 't', permissions: ['taxonomy:read'], scope: { channelIds: ['ch12'] } },
  ]);
  assert.deepEqual((await h.service.referenceSnapshot(reader)).settings, {
    'mam.review.rejectedRetention': null,
  });
  await h.service.putSetting(
    h.channelAdmin,
    RETENTION,
    { level: 'channel', value: 'P90D' },
    undefined,
  );
  const snapshot = await h.service.referenceSnapshot(reader);
  assert.deepEqual(snapshot.settings, { 'mam.review.rejectedRetention': 'P90D' });
});

test('HTTP: GET, PUT with ?version=, DELETE ?level= — and the problems a client can make', async () => {
  const h = harness();
  const app = await buildMamApp({ service: h.service, policyFor: () => h.channelAdmin.policy });
  const headers = { 'x-atlas-user': ADMIN, 'x-atlas-channel': 'ch12' };
  try {
    const got = await app.inject({ headers, method: 'GET', url: '/api/v1/settings/mam' });
    assert.equal(got.statusCode, 200, got.body);
    assert.equal(got.json().area, 'mam');

    const put = await app.inject({
      headers,
      method: 'PUT',
      url: `/api/v1/settings/mam/${RETENTION}`,
      payload: { level: 'channel', value: 'P30D' },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().levels.channel.version, 1);

    const stale = await app.inject({
      headers,
      method: 'PUT',
      url: `/api/v1/settings/mam/${RETENTION}`,
      payload: { level: 'channel', value: 'P7D' },
    });
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().details.version, 1);

    const again = await app.inject({
      headers,
      method: 'PUT',
      url: `/api/v1/settings/mam/${RETENTION}?version=1`,
      payload: { level: 'channel', value: 'P7D' },
    });
    assert.equal(again.statusCode, 200, again.body);

    for (const [url, payload] of [
      [`/api/v1/settings/mam/${RETENTION}?version=x`, { level: 'channel', value: 'P1D' }],
      [`/api/v1/settings/mam/${RETENTION}`, { value: 'P1D' }],
      [`/api/v1/settings/mam/${RETENTION}`, { level: 'channel' }],
      [`/api/v1/settings/mam/${RETENTION}`, { level: 'category', value: 'P1D' }],
    ] as const) {
      const bad = await app.inject({ headers, method: 'PUT', url, payload });
      assert.equal(bad.statusCode, 422, `${url} ${JSON.stringify(payload)}: ${bad.body}`);
    }
    const noLevel = await app.inject({
      headers,
      method: 'DELETE',
      url: `/api/v1/settings/mam/${RETENTION}`,
    });
    assert.equal(noLevel.statusCode, 422);
    const reset = await app.inject({
      headers,
      method: 'DELETE',
      url: `/api/v1/settings/mam/${RETENTION}?level=channel&version=2`,
    });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(reset.json().resolved.origin, 'default');
  } finally {
    await app.close();
  }
});
