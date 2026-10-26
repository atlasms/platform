// EP-24.4 — the retained verdict history (review plan WS-A2/WS-C, FR-APP-5): every approval and
// rejection an asset is given is kept — by whom, when, at which review point, why, and what it
// set — written with the transition, never edited, read newest first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '@atlas/policy';
import { buildMamApp, MamService, type Caller } from '../src/index.ts';
import { seededStore } from './categories.fixture.ts';

const T0 = Date.parse('2026-08-05T12:00:00.000Z');

function harness() {
  const store = seededStore();
  let clock = T0;
  const service = new MamService({ store, now: () => new Date(clock) });
  const caller = (
    userId = 'ana',
    permissions = ['asset:read', 'asset:write', 'asset:approve'],
    channelId = 'ch12',
  ): Caller => ({
    userId,
    channelId,
    policy: compile({
      subjectId: userId,
      permVersion: 1,
      rules: [{ id: 'r', permissions, scope: { channelIds: [channelId] } }],
    }),
  });
  const ready = async (who = caller()) => {
    const a = await service.create(who, {
      title: 'Clip',
      mediaType: 'video',
      fileType: 'mxf',
      categoryId: 'cat-1',
    });
    await service.attachRenditions(who, a.id);
    await service.transition(who, a.id, 'startProcessing');
    return service.transition(who, a.id, 'markReady');
  };
  return {
    store,
    service,
    caller,
    ready,
    later: (ms: number) => {
      clock += ms;
    },
  };
}

test('an approval and a rejection are each kept as they were given — newest first', async () => {
  const h = harness();
  const a = await h.ready();
  await h.service.transition(h.caller('ben'), a.id, 'reject', {
    reason: '  audio drops at 00:12  ',
    reviewPointId: 'qc',
    retainUntil: '2026-09-05T00:00:00.000Z',
  });
  const b = await h.ready();
  await h.service.transition(h.caller('ana'), b.id, 'approve', {
    expiresAt: '2027-01-01T00:00:00.000Z',
  });

  const [rejection, ...rest] = await h.service.verdicts(h.caller(), a.id);
  assert.deepEqual(rest, []);
  assert.equal(rejection?.verdict, 'rejected');
  assert.equal(rejection?.decidedBy, 'ben');
  assert.equal(rejection?.reason, 'audio drops at 00:12', 'the reason as stated, trimmed');
  assert.equal(rejection?.reviewPointId, 'qc');
  assert.equal(rejection?.retainUntil, '2026-09-05T00:00:00.000Z');
  assert.equal(rejection?.expiresAt, undefined, 'a rejection sets no expiry');

  const [approval] = await h.service.verdicts(h.caller(), b.id);
  assert.deepEqual(
    [approval?.verdict, approval?.decidedBy, approval?.expiresAt, approval?.expirySource],
    ['approved', 'ana', '2027-01-01T00:00:00.000Z', undefined],
  );
  assert.equal(approval?.automatic, undefined, 'a person gave it');
});

test('re-review keeps the whole story: approved, expired, approved again — every verdict, newest first', async () => {
  const h = harness();
  const a = await h.ready();
  await h.service.transition(h.caller('ana'), a.id, 'approve', {
    expiresAt: '2026-08-05T12:00:30.000Z',
  });
  h.later(60_000);
  assert.equal(await h.service.expireLapsed(), 1);
  h.later(60_000);
  await h.service.transition(h.caller('ben'), a.id, 'approve', {
    expiresAt: '2027-08-05T00:00:00.000Z',
    reviewPointId: 're-review',
  });

  const history = await h.service.verdicts(h.caller(), a.id);
  assert.deepEqual(
    history.map((v) => [v.verdict, v.decidedBy, v.expiresAt, v.reviewPointId]),
    [
      ['approved', 'ben', '2027-08-05T00:00:00.000Z', 're-review'],
      ['approved', 'ana', '2026-08-05T12:00:30.000Z', undefined],
    ],
  );
  // The asset holds only its CURRENT approval; the history holds both.
  assert.equal((await h.service.get(h.caller(), a.id)).approvedBy, 'ben');
});

test('a refused transition records no verdict — the row commits with the transition or not at all', async () => {
  const h = harness();
  const a = await h.ready();
  await assert.rejects(
    h.service.transition(h.caller(), a.id, 'reject', { reason: '   ' }),
    /must state a reason/,
  );
  await assert.rejects(
    h.service.transition(h.caller('viewer', ['asset:read', 'asset:write']), a.id, 'approve'),
    /asset:approve/,
  );
  assert.deepEqual(await h.service.verdicts(h.caller(), a.id), []);
  // A step that is not a verdict writes none either.
  const created = await h.service.create(h.caller(), {
    title: 'Clip',
    mediaType: 'video',
    fileType: 'mxf',
    categoryId: 'cat-1',
  });
  await h.service.transition(h.caller(), created.id, 'startProcessing');
  assert.deepEqual(await h.service.verdicts(h.caller(), created.id), []);
});

test('the history is read under the asset’s own rule — another channel’s asset is not found', async () => {
  const h = harness();
  const a = await h.ready();
  await h.service.transition(h.caller(), a.id, 'approve');
  const reader = h.caller('rita', ['asset:read']);
  assert.equal((await h.service.verdicts(reader, a.id)).length, 1);
  await assert.rejects(
    h.service.verdicts(h.caller('ana', ['asset:read'], 'ch99'), a.id),
    (e: Error & { status?: number }) => e.status === 404,
  );
  await assert.rejects(h.service.verdicts(h.caller('nobody', []), a.id));
});

test('GET /assets/{id}/verdicts over HTTP: the page, newest first', async () => {
  const h = harness();
  const a = await h.ready();
  await h.service.transition(h.caller(), a.id, 'approve');
  const app = await buildMamApp({
    service: h.service,
    policyFor: () => h.caller().policy,
  });
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/assets/${a.id}/verdicts`,
    headers: { 'x-atlas-user': 'ana', 'x-atlas-channel': 'ch12' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{ items: { verdict: string; decidedBy: string }[] }>();
  assert.deepEqual(
    body.items.map((v) => [v.verdict, v.decidedBy]),
    [['approved', 'ana']],
  );
  await app.close();
});

test('GET /assets?state=ready,expired is the review queue; an unknown state is a 422, not an empty page', async () => {
  const h = harness();
  const waiting = await h.ready();
  const approved = await h.ready();
  await h.service.transition(h.caller(), approved.id, 'approve');
  const app = await buildMamApp({ service: h.service, policyFor: () => h.caller().policy });
  const headers = { 'x-atlas-user': 'ana', 'x-atlas-channel': 'ch12' };
  const queue = await app.inject({
    method: 'GET',
    url: '/api/v1/assets?state=ready,expired&order=desc',
    headers,
  });
  assert.equal(queue.statusCode, 200, queue.body);
  assert.deepEqual(
    queue.json<{ items: { id: string }[] }>().items.map((a) => a.id),
    [waiting.id],
  );
  const typo = await app.inject({ method: 'GET', url: '/api/v1/assets?state=redy', headers });
  assert.equal(typo.statusCode, 422);
  await app.close();
});

// Found by EP-24.9's review panel, which offers all three expiry choices.
test('an approval’s expiry: null is PERMANENT even under a category default; a date is its own; a past one is refused', async () => {
  const h = harness();
  const admin = h.caller('ana', [
    'asset:read',
    'asset:write',
    'asset:approve',
    'taxonomy:admin',
    'taxonomy:read',
  ]);
  const cat = await h.service.category(admin, 'cat-1');
  await h.service.updateCategory(admin, 'cat-1', cat.version, { defaultExpiry: 'P1D' });

  const permanent = await h.ready();
  // Before EP-24.9 this was a 422 from MAM's own event schema: `expiresAt: null` reached the payload.
  const p = await h.service.transition(h.caller(), permanent.id, 'approve', { expiresAt: null });
  assert.deepEqual([p.expiresAt, p.expirySource], [undefined, undefined]);
  assert.equal((await h.service.verdicts(h.caller(), p.id))[0]?.expiresAt, undefined);

  const dated = await h.ready();
  const d = await h.service.transition(h.caller(), dated.id, 'approve', {
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
  assert.deepEqual([d.expiresAt, d.expirySource], ['2030-01-01T00:00:00.000Z', undefined]);

  const late = await h.ready();
  await assert.rejects(
    h.service.transition(h.caller(), late.id, 'approve', { expiresAt: '2020-01-01T00:00:00.000Z' }),
    /must be in the future/,
  );
  await assert.rejects(
    h.service.transition(h.caller(), late.id, 'approve', { expiresAt: 'tomorrow' }),
    /date-time, or null/,
  );
});

test('re-review re-arms the clock: inheriting again snapshots the category default from THIS approval', async () => {
  const h = harness();
  const admin = h.caller('ana', [
    'asset:read',
    'asset:write',
    'asset:approve',
    'taxonomy:admin',
    'taxonomy:read',
  ]);
  const cat = await h.service.category(admin, 'cat-1');
  await h.service.updateCategory(admin, 'cat-1', cat.version, { defaultExpiry: 'P1D' });
  const a = await h.ready();
  const first = await h.service.transition(h.caller(), a.id, 'approve');
  assert.deepEqual([first.expiresAt, first.expirySource], ['2026-08-06T12:00:00.000Z', 'category']);
  h.later(2 * 86_400_000);
  assert.equal(await h.service.expireLapsed(), 1);
  // Before EP-24.9 the lapsed 2026-08-06 survived the re-approval, and the next sweep expired it again.
  const again = await h.service.transition(h.caller(), a.id, 'approve');
  assert.deepEqual([again.expiresAt, again.expirySource], ['2026-08-08T12:00:00.000Z', 'category']);
  assert.equal(await h.service.expireLapsed(), 0, 'not swept straight back');
});
