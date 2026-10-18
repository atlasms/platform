// EP-25.5 — the event → notification pipeline and the notification-type registry, with the routing
// decided on 2026-10-18 as the assertions: who each event tells, every recipient re-checked against
// their own read access, the channel's type deciding whether and how, an operator editing a type
// under config:admin, and a person marking what they have read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, subjectFor, ulid, type Envelope } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { compile, type EffectivePolicy, type Rule } from '@atlas/policy';
import {
  buildNotificationsApp,
  fakePrincipals,
  INTERNAL_HEADERS,
  NotificationPipeline,
  NotificationsService,
  sqliteInboxStore,
  type Notification,
  type ResolvedType,
} from '../src/index.ts';

const CH = 'ch12';
const policy = (userId: string, rules: Rule[]): EffectivePolicy =>
  compile({ subjectId: userId, permVersion: 1, rules, roles: [], groups: [] });

async function harness() {
  const store = sqliteInboxStore();
  const principals = fakePrincipals({ dan: [{ kind: 'group', id: 'g-desk' }] });
  const rules: Record<string, Rule[]> = {
    ana: [{ id: 'r', permissions: ['asset:read'] }],
    ben: [{ id: 'r', permissions: ['asset:read'], scope: { categoryPaths: ['/sports/'] } }],
    cat: [{ id: 'r', permissions: ['asset:read', 'config:admin'] }],
    dan: [],
    eve: [],
  };
  const policyFor = (userId: string) => (rules[userId] ? policy(userId, rules[userId]) : undefined);
  const pipeline = new NotificationPipeline({ store, policyFor, principals });
  const service = new NotificationsService({ store, principals });
  const app = await buildNotificationsApp({ service, pipeline, policyFor });
  const call = (userId: string, method: 'GET' | 'PUT' | 'PATCH', url: string, payload?: unknown) =>
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
  const inbox = async (userId: string): Promise<Notification[]> =>
    (await service.inbox({ userId, channelId: CH })).notifications;
  const outbox = new SqliteOutboxStore(store.db);
  return { store, pipeline, service, call, inbox, outbox };
}

function event(type: string, payload: Record<string, unknown>) {
  const e = buildEnvelope({ type, channelId: CH, payload, actor: { kind: 'service', id: 'mam' } });
  return { id: e.messageId, subject: subjectFor(CH, type), body: e };
}

test("a verdict tells the asset's creator — once, in every locale — and an automatic approval tells nobody", async () => {
  const h = await harness();
  const assetId = ulid();
  const approved = event('asset.approved', {
    assetId,
    approver: 'cat',
    createdBy: 'ana',
    categoryPath: '/news/',
  });
  assert.equal(await h.pipeline.consumeAssetApproved(approved), 'applied');
  assert.equal(await h.pipeline.consumeAssetApproved(approved), 'duplicate');
  const [n] = await h.inbox('ana');
  assert.deepEqual(
    [n?.type, n?.severity, n?.subjectRef, n?.title],
    [
      'asset.approved',
      'info',
      { entityType: 'asset', entityId: assetId },
      'An asset you created was approved',
    ],
  );
  assert.equal(n?.titles?.['ar'], 'تمت الموافقة على مادة أنشأتها');
  const auto = event('asset.approved', {
    assetId,
    approver: 'mam',
    automatic: true,
    createdBy: 'ana',
  });
  assert.equal(await h.pipeline.consumeAssetApproved(auto), 'skipped');

  const rejected = event('asset.rejected', {
    assetId,
    reason: 'soft focus',
    rejectedBy: 'cat',
    createdBy: 'ana',
    categoryPath: '/news/',
  });
  assert.equal(await h.pipeline.consumeAssetRejected(rejected), 'applied');
  assert.equal((await h.inbox('ana'))[0]?.title, 'An asset you created was rejected: soft focus');
});

test('a recipient is re-checked: one who cannot read the asset, or has no policy, is told nothing', async () => {
  const h = await harness();
  // ben reads only /sports/; the asset is in /news/.
  for (const createdBy of ['ben', 'zed'])
    assert.equal(
      await h.pipeline.consumeAssetApproved(
        event('asset.approved', {
          assetId: ulid(),
          approver: 'cat',
          createdBy,
          categoryPath: '/news/',
        }),
      ),
      'skipped',
      createdBy,
    );
  assert.equal(
    await h.pipeline.consumeAssetApproved(
      event('asset.approved', {
        assetId: ulid(),
        approver: 'cat',
        createdBy: 'ben',
        categoryPath: '/sports/f/',
      }),
    ),
    'applied',
    'inside their category, they are told',
  );
});

test('a failed transcode tells the person who asked for it — a service is told nothing', async () => {
  const h = await harness();
  const failed = (requestedBy: string) =>
    event('transcode.failed', {
      assetId: ulid(),
      requestedBy,
      error: { code: 'TRANSCODE_FAILED', message: 'no video stream', retryable: false },
    });
  assert.equal(await h.pipeline.consumeTranscodeFailed(failed('ana')), 'applied');
  assert.equal(
    (await h.inbox('ana'))[0]?.title,
    'A transcode you asked for failed: no video stream',
  );
  assert.equal(await h.pipeline.consumeTranscodeFailed(failed('bms')), 'skipped');
});

test('a mention tells someone the message is to — by name or through a group they are in — and nobody else', async () => {
  const h = await harness();
  const [ana, dan, eve] = ['ana', 'dan', 'eve'];
  // Mentions name user ids; the fixture's ids are words, so they are given as ULID-shaped aliases.
  const id = (who: string) =>
    `01J0000000000000000000${who.toUpperCase().padEnd(4, 'X')}`.slice(0, 26);
  const sent = event('message.sent', {
    id: ulid(),
    from: 'cat',
    to: [
      { kind: 'user', id: id(ana) },
      { kind: 'group', id: 'g-desk' },
    ],
    body: `@${id(ana)} @${id(dan)} @${id(eve)} see the rundown`,
    sentAt: new Date().toISOString(),
  });
  // The aliases' policies and groups.
  const pipeline = new NotificationPipeline({
    store: h.store,
    policyFor: (userId) => policy(userId, []),
    principals: fakePrincipals({ [id(dan)]: [{ kind: 'group', id: 'g-desk' }] }),
  });
  assert.equal(await pipeline.consumeMessageSent(sent), 'applied');
  const told = (await h.outbox.listUnsent(100))
    .map((r) => r.message.body as Envelope)
    .filter((e) => e.type === 'notification.raised')
    .map((e) => (e.payload as { userId: string }).userId)
    .sort();
  assert.deepEqual(told, [id(ana), id(dan)].sort(), 'eve is not a reader of it');
  const self = event('message.sent', {
    id: ulid(),
    from: id(ana),
    to: [{ kind: 'user', id: id(ana) }],
    body: `note to @${id(ana)}`,
    sentAt: new Date().toISOString(),
  });
  assert.equal(await pipeline.consumeMessageSent(self), 'skipped', 'a self-mention tells nobody');
});

test('the registry: every user reads the types; config:admin changes one — compare-and-set, audited, applied', async () => {
  const h = await harness();
  const list = await h.call('dan', 'GET', '/api/v1/notification-types');
  assert.equal(list.statusCode, 200, list.body);
  const types = list.json<{ items: ResolvedType[] }>().items;
  assert.deepEqual(types.map((t) => t.key).sort(), [
    'asset.approved',
    'asset.re-review-due',
    'asset.rejected',
    'message.mention',
    'transcode.failed',
  ]);
  assert.equal(types.find((t) => t.key === 'asset.re-review-due')?.mandatory, true);

  const put = (who: string, key: string, version: number, body: unknown) =>
    h.call(who, 'PUT', `/api/v1/notification-types/${key}?version=${version}`, body);
  assert.equal((await put('ana', 'asset.rejected', 0, { severity: 'critical' })).statusCode, 403);
  const unknown = await put('cat', 'asset.deleted', 0, {});
  assert.equal(unknown.statusCode, 422);
  assert.match(unknown.body, /not a notification type this platform raises/);
  const badSlot = await put('cat', 'asset.rejected', 0, {
    title: { en: 'Rejected by {{nobody}}' },
  });
  assert.equal(badSlot.statusCode, 422);
  const ok = await put('cat', 'asset.rejected', 0, {
    severity: 'critical',
    title: { en: 'Rejected ({{reason}}) by {{rejectedBy}}' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(
    [ok.json<ResolvedType>().origin, ok.json<ResolvedType>().version],
    ['channel', 1],
  );
  assert.equal((await put('cat', 'asset.rejected', 0, { severity: 'info' })).statusCode, 409);

  await h.pipeline.consumeAssetRejected(
    event('asset.rejected', {
      assetId: ulid(),
      reason: 'soft',
      rejectedBy: 'cat',
      createdBy: 'ana',
    }),
  );
  const [n] = await h.inbox('ana');
  assert.deepEqual([n?.severity, n?.title], ['critical', 'Rejected (soft) by cat']);
  assert.equal(
    n?.titles?.['ar'],
    'رُفضت مادة أنشأتها: soft',
    'the locale not overridden keeps its own',
  );

  // Disabled in the channel: nothing raised.
  assert.equal((await put('cat', 'asset.approved', 0, { enabled: false })).statusCode, 200);
  assert.equal(
    await h.pipeline.consumeAssetApproved(
      event('asset.approved', { assetId: ulid(), approver: 'cat', createdBy: 'ana' }),
    ),
    'skipped',
  );
  const audits = (await h.outbox.listUnsent(100))
    .map((r) => r.message.body as Envelope)
    .filter((e) => e.type === 'audit.recorded')
    .map((e) => (e.payload as { entityId: string; action: string }).entityId);
  assert.deepEqual(audits, [`${CH}:asset.rejected`, `${CH}:asset.approved`]);
});

test('a person marks their own notification read; another’s is not found', async () => {
  const h = await harness();
  await h.pipeline.consumeAssetApproved(
    event('asset.approved', { assetId: ulid(), approver: 'cat', createdBy: 'ana' }),
  );
  const [n] = await h.inbox('ana');
  assert.equal(
    (await h.call('cat', 'PATCH', `/api/v1/notifications/${n!.id}`, { read: true })).statusCode,
    404,
  );
  assert.equal(
    (await h.call('ana', 'PATCH', `/api/v1/notifications/${n!.id}`, { read: true })).statusCode,
    204,
  );
  const after = await h.service.inbox({ userId: 'ana', channelId: CH });
  assert.deepEqual([after.unreadCount, after.notifications[0]?.read], [0, true]);
});
