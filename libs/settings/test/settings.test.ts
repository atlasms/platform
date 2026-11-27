import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePayload } from '@atlas/contracts';
import type { StoredSetting } from '@atlas/data';
import { compile, type Rule } from '@atlas/policy';
import { defineSettings } from '@atlas/reference';
import { Conflict, Forbidden, NotFound, ValidationError } from '@atlas/service-kit';
import { SettingsAdmin, SettingsCache, entityIdOf, type SettingsCaller } from '../src/index.ts';

const USER = '01JDQX0000000000000000AB12';
const NOW = new Date('2026-11-27T10:00:00.000Z');

const registry = defineSettings('mam', {
  'review.rejectedRetention': {
    type: 'duration',
    scope: 'channel',
    description: 'How long rejected media is kept before it may be purged.',
  },
  'sweep.batch': {
    type: 'int',
    default: 100,
    min: 1,
    max: 1000,
    scope: 'deployment',
    restart: true,
  },
  'ui.density': {
    type: 'oneOf',
    default: 'comfortable',
    options: [{ value: 'comfortable' }, { value: 'compact' }],
    scope: 'user',
  },
  'export.token': { type: 'string', scope: 'channel', sensitive: true },
});
const admin = new SettingsAdmin(registry);

const as = (rules: Rule[], over: Partial<SettingsCaller> = {}): SettingsCaller => ({
  userId: USER,
  channelId: 'ch12',
  policy: compile({ subjectId: USER, permVersion: 1, rules }),
  ...over,
});
const channelAdmin = as([
  { id: 'c', permissions: ['config:admin'], scope: { channelIds: ['ch12'] } },
]);
const platformAdmin = as([{ id: 'p', permissions: ['config:admin'] }]);
const reader = as([{ id: 'r', permissions: ['config:read'], scope: { channelIds: ['ch12'] } }]);
const nobody = as([{ id: 'n', permissions: ['asset:read'], scope: { channelIds: ['ch12'] } }]);

const stored = (over: Partial<StoredSetting> = {}): StoredSetting => ({
  area: 'mam',
  key: 'review.rejectedRetention',
  level: 'channel',
  scopeId: 'ch12',
  channelId: 'ch12',
  value: 'P30D',
  set: true,
  version: 1,
  updatedBy: USER,
  updatedAt: NOW.toISOString(),
  ...over,
});

test('a channel admin sets their channel; the write carries its audit and config.changed', () => {
  const scope = admin.scopeOf(channelAdmin, 'channel');
  const w = admin.planSet(
    channelAdmin,
    'review.rejectedRetention',
    scope,
    'P30D',
    undefined,
    undefined,
    NOW,
  );
  assert.deepEqual(w.row, stored());
  assert.equal(w.ifVersion, undefined);
  assert.deepEqual(w.audit, {
    entityType: 'setting',
    entityId: 'mam.review.rejectedRetention@channel:ch12',
    revision: 1,
    action: 'setting.set',
    origin: { service: 'mam' },
    delta: { value: { after: 'P30D' } },
  });
  const changed = w.changed(7);
  assert.deepEqual(changed, {
    area: 'mam',
    tier: 'setting',
    keys: ['review.rejectedRetention'],
    scopeLevel: 'channel',
    scopeId: 'ch12',
    configVersion: 7,
    actorId: USER,
  });
  // Both payloads are what their schemas say, or the outbox would refuse them later.
  assert.equal(validatePayload('audit.recorded', w.audit).valid, true);
  assert.equal(validatePayload('config.changed', changed).valid, true);
});

test('an update names the version it read; anything else is a 409', () => {
  const scope = admin.scopeOf(channelAdmin, 'channel');
  const existing = stored();
  const w = admin.planSet(channelAdmin, 'review.rejectedRetention', scope, 'P7D', existing, 1, NOW);
  assert.equal(w.ifVersion, 1);
  assert.equal(w.row.version, 2);
  assert.deepEqual(w.audit.delta, { value: { before: 'P30D', after: 'P7D' } });
  // No version over a row, a wrong version, a version for a row that does not exist.
  for (const [row, version] of [
    [existing, undefined],
    [existing, 3],
    [undefined, 1],
  ] as const) {
    assert.throws(
      () =>
        admin.planSet(channelAdmin, 'review.rejectedRetention', scope, 'P7D', row, version, NOW),
      Conflict,
    );
  }
});

test('a value is validated from the descriptor — the same rule Studio applies', () => {
  const scope = admin.scopeOf(channelAdmin, 'channel');
  assert.throws(
    () =>
      admin.planSet(
        channelAdmin,
        'review.rejectedRetention',
        scope,
        '30 days',
        undefined,
        undefined,
        NOW,
      ),
    (e: unknown) =>
      e instanceof ValidationError &&
      JSON.stringify(e.details).includes('mam.review.rejectedRetention'),
  );
  assert.throws(
    () => admin.planSet(channelAdmin, 'nope', scope, 1, undefined, undefined, NOW),
    NotFound,
  );
});

test('a level deeper than the descriptor allows is refused', () => {
  const scope = admin.scopeOf(platformAdmin, 'channel');
  assert.throws(
    () => admin.planSet(platformAdmin, 'sweep.batch', scope, 5, undefined, undefined, NOW),
    /cannot be set at "channel"/,
  );
});

test('deployment needs an UNSCOPED config:admin; a channel grant cannot reach it', () => {
  const scope = admin.scopeOf(channelAdmin, 'deployment');
  assert.throws(
    () =>
      admin.planSet(
        channelAdmin,
        'review.rejectedRetention',
        scope,
        'P1D',
        undefined,
        undefined,
        NOW,
      ),
    (e: unknown) => e instanceof Forbidden && /unscoped config:admin/.test(e.message),
  );
  const w = admin.planSet(
    platformAdmin,
    'review.rejectedRetention',
    scope,
    'P365D',
    undefined,
    undefined,
    NOW,
  );
  assert.equal(w.row.channelId, null);
  assert.equal(w.row.scopeId, '');
  assert.equal(w.audit.entityId, 'mam.review.rejectedRetention@deployment');
  const changed = w.changed(2);
  assert.equal(changed.scopeLevel, 'deployment');
  assert.equal('scopeId' in changed, false);
  // A restart-only knob says so on its event.
  const knob = admin.planSet(platformAdmin, 'sweep.batch', scope, 50, undefined, undefined, NOW);
  assert.equal(knob.changed(3).restartRequired, true);
});

test('a reader cannot write, and a caller without config:* cannot read', () => {
  const scope = admin.scopeOf(reader, 'channel');
  assert.throws(
    () =>
      admin.planSet(reader, 'review.rejectedRetention', scope, 'P1D', undefined, undefined, NOW),
    Forbidden,
  );
  assert.doesNotThrow(() => admin.view(reader, [], 1));
  assert.throws(() => admin.view(nobody, [], 1), Forbidden);
});

test("a channel value is the caller's own channel, a user value the caller's own", () => {
  assert.throws(() => admin.scopeOf(channelAdmin, 'channel', 'ch99'), Forbidden);
  assert.throws(() => admin.scopeOf(channelAdmin, 'user', 'someone-else'), Forbidden);
  assert.throws(() => admin.scopeOf(channelAdmin, 'deployment', 'ch12'), ValidationError);
  assert.throws(() => admin.scopeOf(channelAdmin, 'category', 'cat1'), ValidationError);
  assert.throws(() => admin.scopeOf(channelAdmin, 'galaxy'), ValidationError);
  // A user value needs no permission — but only at a descriptor that reaches `user`.
  const mine = admin.scopeOf(nobody, 'user');
  const w = admin.planSet(nobody, 'ui.density', mine, 'compact', undefined, undefined, NOW);
  assert.equal(w.row.scopeId, USER);
  assert.equal(w.row.channelId, 'ch12');
  assert.throws(
    () => admin.planSet(nobody, 'review.rejectedRetention', mine, 'P1D', undefined, undefined, NOW),
    /cannot be set at "user"/,
  );
});

test('a reset keeps the row (its version is the audit revision) and says what was there', () => {
  const scope = admin.scopeOf(channelAdmin, 'channel');
  const w = admin.planReset(
    channelAdmin,
    'review.rejectedRetention',
    scope,
    stored({ version: 4 }),
    4,
    NOW,
  );
  assert.ok(w);
  assert.equal(w.row.set, false);
  assert.equal(w.row.value, undefined);
  assert.equal(w.row.version, 5);
  assert.equal(w.ifVersion, 4);
  assert.equal(w.audit.action, 'setting.reset');
  assert.deepEqual(w.audit.delta, { value: { before: 'P30D' } });
  assert.equal(validatePayload('audit.recorded', w.audit).valid, true);
  // Nothing set at this level: already inherited, nothing to write.
  assert.equal(
    admin.planReset(channelAdmin, 'review.rejectedRetention', scope, undefined, undefined, NOW),
    undefined,
  );
  assert.equal(
    admin.planReset(
      channelAdmin,
      'review.rejectedRetention',
      scope,
      stored({ set: false, value: undefined }),
      1,
      NOW,
    ),
    undefined,
  );
  // And a reader may not reset.
  assert.throws(
    () => admin.planReset(reader, 'review.rejectedRetention', scope, stored(), 1, NOW),
    Forbidden,
  );
});

test('the view: what each setting resolves to, from where, the rows behind it, what is writable', () => {
  const rows = [
    stored({ level: 'deployment', scopeId: '', channelId: null, value: 'P365D' }),
    stored({ version: 3 }),
    stored({ key: 'ui.density', level: 'user', scopeId: USER, value: 'compact' }),
    // Another user's preference in the same channel is not this reader's to see.
    stored({ key: 'ui.density', level: 'user', scopeId: 'u-other', value: 'comfortable' }),
    stored({ key: 'export.token', value: 's3cr3t' }),
  ];
  const view = admin.view(channelAdmin, rows, 9);
  assert.equal(view.area, 'mam');
  assert.equal(view.configVersion, 9);
  const byKey = Object.fromEntries(view.settings.map((s) => [s.key, s]));

  const retention = byKey['review.rejectedRetention']!;
  assert.deepEqual(retention.resolved, {
    value: 'P30D',
    origin: 'channel',
    scopeId: 'ch12',
    overridable: false,
  });
  assert.deepEqual(Object.keys(retention.levels).sort(), ['channel', 'deployment']);
  assert.equal(retention.levels.channel?.version, 3);
  // A channel admin may write the channel level, not the platform's.
  assert.deepEqual(retention.writable, ['channel']);
  assert.deepEqual(
    admin.view(platformAdmin, rows, 9).settings.find((s) => s.key === 'review.rejectedRetention')!
      .writable,
    ['deployment', 'channel'],
  );

  const density = byKey['ui.density']!;
  assert.equal(density.resolved.value, 'compact');
  assert.equal(density.resolved.origin, 'user');
  assert.deepEqual(Object.keys(density.levels), ['user']);
  assert.equal(density.levels.user?.value, 'compact');

  // Nothing set: the code default, and nothing to show by level.
  const batch = byKey['sweep.batch']!;
  assert.deepEqual(batch.resolved, { value: 100, origin: 'default', overridable: true });
  assert.deepEqual(batch.levels, {});

  // A sensitive value is never shown — not resolved, not by level.
  const token = byKey['export.token']!;
  assert.equal(token.resolved.redacted, true);
  assert.equal('value' in token.resolved, false);
  assert.equal(token.levels.channel?.redacted, true);
  assert.equal('value' in token.levels.channel!, false);
  assert.equal(JSON.stringify(view).includes('s3cr3t'), false);
});

test('a reset row is not a value: resolution falls through to the next level', () => {
  const rows = [
    stored({ level: 'deployment', scopeId: '', channelId: null, value: 'P365D' }),
    stored({ set: false, value: undefined, version: 2 }),
  ];
  const r = admin.resolve('review.rejectedRetention', rows, { channel: 'ch12' });
  assert.equal(r.value, 'P365D');
  assert.equal(r.origin, 'deployment');
  // With no default and no row, the value is null — "not set", which a caller reads as such.
  assert.equal(admin.resolve('review.rejectedRetention', [], { channel: 'ch12' }).value, null);
});

test('a sensitive value is redacted in the audit diff: THAT it changed, never what to', () => {
  const scope = admin.scopeOf(channelAdmin, 'channel');
  const w = admin.planSet(
    channelAdmin,
    'export.token',
    scope,
    'new-secret',
    stored({ key: 'export.token', value: 'old' }),
    1,
    NOW,
  );
  assert.deepEqual(w.audit.delta, { value: { before: '(changed)', after: '(changed)' } });
  assert.equal(w.row.value, 'new-secret');
});

test('an actor id that is not a ULID is left off config.changed rather than failing it', () => {
  const svc = { ...platformAdmin, userId: 'mam-service' };
  const w = admin.planSet(
    svc,
    'review.rejectedRetention',
    admin.scopeOf(svc, 'deployment'),
    'P1D',
    undefined,
    undefined,
    NOW,
  );
  const changed = w.changed(1);
  assert.equal('actorId' in changed, false);
  assert.equal(validatePayload('config.changed', changed).valid, true);
});

test('entity ids keep the level apart: the platform and a channel are two histories', () => {
  assert.equal(entityIdOf('mam', 'k', { level: 'deployment', scopeId: '' }), 'mam.k@deployment');
  assert.equal(entityIdOf('mam', 'k', { level: 'channel', scopeId: 'ch12' }), 'mam.k@channel:ch12');
});

test('the cache loads a miss once, serves the TTL, forgets a failure and clears on demand', async () => {
  let t = 0;
  let loads = 0;
  const cache = new SettingsCache({ ttlMs: 100, now: () => t });
  const load = async (): Promise<StoredSetting[]> => {
    loads++;
    return [stored()];
  };
  await Promise.all([cache.get('ch12', load), cache.get('ch12', load)]);
  assert.equal(loads, 1);
  t = 99;
  await cache.get('ch12', load);
  assert.equal(loads, 1);
  t = 100;
  await cache.get('ch12', load);
  assert.equal(loads, 2);
  cache.clear();
  await cache.get('ch12', load);
  assert.equal(loads, 3);
  // A failed load is not cached: the next read tries again.
  await assert.rejects(
    cache.get('ch99', async () => Promise.reject(new Error('db down'))),
    /db down/,
  );
  assert.deepEqual(await cache.get('ch99', load), [stored()]);
});
