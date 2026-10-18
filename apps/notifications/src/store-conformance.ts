// The inbox store's conformance suite, driven THROUGH the service — the behaviour lifted from
// reference/notifications-service, held on node:sqlite and on a real Postgres alike. Add a
// behaviour here, not to one adapter (AGENTS.md §3).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, subjectFor, ulid, type Envelope } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type Message, type OutboxStore } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import { fakePrincipals } from './principals.ts';
import { NotificationPipeline } from './pipeline.ts';
import { NotificationsService } from './service.ts';
import { TaskActions } from './task-actions.ts';
import type { InboxStore } from './store.ts';

export interface InboxStoreHarness {
  make: () => Promise<{ store: InboxStore; outbox: OutboxStore; cleanup?: () => Promise<void> }>;
}

const CH = 'ch12';

function event(
  type: string,
  payload: Record<string, unknown>,
  options: { channelId?: string; correlationId?: string } = {},
): Message {
  const channelId = options.channelId ?? CH;
  const envelope = buildEnvelope({
    type,
    channelId,
    payload,
    actor: { kind: 'service', id: type.startsWith('workflow.') ? 'bms' : 'mam' },
    ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}),
  });
  return { id: envelope.messageId, subject: subjectFor(channelId, type), body: envelope };
}

export function inboxStoreConformance(name: string, harness: InboxStoreHarness): void {
  async function withFixture(
    fn: (f: {
      service: NotificationsService;
      pipeline: NotificationPipeline;
      store: InboxStore;
      drain: () => Promise<Envelope[]>;
    }) => Promise<void>,
  ): Promise<void> {
    const { store, outbox, cleanup } = await harness.make();
    const broker = new InMemoryBroker();
    const relay = new OutboxRelay(outbox, broker);
    let sent = 0;
    const drain = async (): Promise<Envelope[]> => {
      await relay.drain();
      const fresh = broker.published.slice(sent).map((m) => m.body as Envelope);
      sent = broker.published.length;
      return fresh;
    };
    try {
      // Every recipient may read everything: the re-check is the pipeline tests' business.
      const pipeline = new NotificationPipeline({
        store,
        policyFor: (userId) =>
          compile({
            subjectId: userId,
            permVersion: 1,
            rules: [{ id: 'all', permissions: ['*:*'] }],
          }),
      });
      await fn({ service: new NotificationsService({ store }), pipeline, store, drain });
    } finally {
      await cleanup?.();
      await store.close().catch(() => undefined);
    }
  }

  test(`[${name}] a workflow task becomes ONE task: announced, audited, in its assignee's inbox`, async () => {
    await withFixture(async ({ service, store, drain }) => {
      const taskId = ulid();
      const instanceId = ulid();
      const assetId = ulid();
      const correlationId = ulid();
      const msg = event(
        'workflow.task.created',
        {
          taskId,
          workflowInstanceId: instanceId,
          assignee: 'user-7',
          assigneeKind: 'user',
          assetId,
          kind: 'approve',
          dueAt: '2026-10-20T12:00:00.000Z',
        },
        { correlationId },
      );
      assert.equal(await service.consumeTaskCreated(msg), 'applied');
      assert.equal(await service.consumeTaskCreated(msg), 'duplicate', 'a redelivery');
      // The same task in another message (a retried BMS activity) is still one task.
      const again = event('workflow.task.created', {
        taskId,
        assignee: 'user-7',
        assigneeKind: 'user',
      });
      assert.equal(await service.consumeTaskCreated(again), 'duplicate');

      const task = await store.task(taskId);
      assert.deepEqual(
        [task?.channelId, task?.state, task?.kind, task?.subjectRef],
        [CH, 'open', 'approve', { entityType: 'asset', entityId: assetId }],
      );
      assert.equal(task?.workflowInstanceId, instanceId);

      const sent = await drain();
      assert.deepEqual(
        sent.map((e) => e.type),
        ['task.created', 'audit.recorded'],
      );
      for (const e of sent) {
        assert.equal(e.correlationId, correlationId, "the workflow's chain continues");
        assert.equal(e.causationId, (msg.body as Envelope).messageId);
      }
      const audit = sent[1]?.payload as { entityType: string; entityId: string; action: string };
      assert.deepEqual(
        [audit.entityType, audit.entityId, audit.action],
        ['task', taskId, 'task.created'],
      );

      const mine = await service.inbox({ userId: 'user-7', channelId: CH });
      assert.deepEqual(
        mine.tasks.map((t) => t.id),
        [taskId],
      );
      assert.deepEqual(
        (await service.inbox({ userId: 'user-8', channelId: CH })).tasks,
        [],
        "nobody else's",
      );
      assert.deepEqual(
        (await service.inbox({ userId: 'user-7', channelId: 'ch99' })).tasks,
        [],
        "not another channel's",
      );
    });
  });

  test(`[${name}] a task offered to a ROLE is one row, held for whoever holds the role`, async () => {
    await withFixture(async ({ service, store }) => {
      const taskId = ulid();
      await service.consumeTaskCreated(
        event('workflow.task.created', { taskId, assignee: 'editor', assigneeKind: 'role' }),
      );
      assert.equal((await store.task(taskId))?.assigneeKind, 'role');
      // Resolved at READ time (decided 2026-10-16) — the store answers by principal…
      const forEditors = await store.openTasks(CH, [{ kind: 'role', id: 'editor' }], 10);
      assert.deepEqual(
        forEditors.map((t) => t.id),
        [taskId],
      );
      // …and a user id that happens to be spelt like the role is not the role.
      assert.deepEqual(await store.openTasks(CH, [{ kind: 'user', id: 'editor' }], 10), []);
      // Before BMS said which kind (EP-25.1), an assignee was a user.
      const legacy = ulid();
      await service.consumeTaskCreated(
        event('workflow.task.created', { taskId: legacy, assignee: 'user-1' }),
      );
      assert.equal((await store.task(legacy))?.assigneeKind, 'user');
    });
  });

  test(`[${name}] messages: a reader's own, by name and through their groups, newest first, channel-scoped`, async () => {
    await withFixture(async ({ store }) => {
      const msg = (
        id: string,
        from: string,
        to: { kind: 'user' | 'group'; id: string }[],
        channelId = 'ch12',
      ) => ({
        id,
        channelId,
        from,
        to,
        body: `body of ${id}`,
        sentAt: '2026-10-18T10:00:00.000Z',
      });
      // Ids in sending order — ulid() within one millisecond is not monotonic.
      const [ia, ib, ic, id] = [ulid(), ulid(), ulid(), ulid()].sort();
      const a = msg(ia!, 'ana', [{ kind: 'user', id: 'ben' }]);
      const b = msg(ib!, 'cat', [{ kind: 'group', id: 'g-desk' }]);
      const c = msg(ic!, 'cat', [
        { kind: 'group', id: 'g-other' },
        { kind: 'user', id: 'ben' },
      ]);
      const elsewhere = msg(id!, 'ana', [{ kind: 'user', id: 'ben' }], 'ch99');
      await store.transaction(async (tx) => {
        for (const m of [a, b, c, elsewhere]) await tx.insertMessage(m);
      });
      const ids = async (userId: string, groups: string[], after?: string) =>
        (
          await store.messagesFor(
            'ch12',
            { userId, groups },
            { ...(after !== undefined ? { after } : {}), limit: 10 },
          )
        ).map((m) => m.id);
      assert.deepEqual(await ids('ben', []), [c.id, a.id], 'by name, newest first, this channel');
      assert.deepEqual(await ids('dan', ['g-desk']), [b.id], 'through a group');
      assert.deepEqual(await ids('cat', []), [c.id, b.id], 'what they sent');
      assert.deepEqual(await ids('ben', ['g-desk', 'g-other'], c.id), [b.id, a.id], 'keyset');
      assert.deepEqual(await ids('eve', []), []);
      const [read] = await store.messagesFor('ch12', { userId: 'ben', groups: [] }, { limit: 1 });
      assert.deepEqual(read, c, 'the message as sent');
    });
  });

  test(`[${name}] a type override is a compare-and-set per channel; a notification is marked read by its own`, async () => {
    await withFixture(async ({ store }) => {
      const o = (version: number, channelId = CH) => ({
        key: 'asset.rejected',
        channelId,
        severity: 'critical' as const,
        version,
        updatedBy: 'cat',
        updatedAt: '2026-10-18T10:00:00.000Z',
      });
      assert.equal(await store.transaction((tx) => tx.putTypeOverride(o(1), 0)), true);
      assert.equal(
        await store.transaction((tx) => tx.putTypeOverride(o(1), 0)),
        false,
        'one first',
      );
      assert.equal(await store.transaction((tx) => tx.putTypeOverride(o(2), 1)), true);
      assert.equal(await store.transaction((tx) => tx.putTypeOverride(o(3), 1)), false, 'stale');
      assert.equal(await store.transaction((tx) => tx.putTypeOverride(o(1, 'ch99'), 0)), true);
      assert.deepEqual(
        (await store.typeOverrides(CH)).map((x) => [x.key, x.version]),
        [['asset.rejected', 2]],
      );

      const id = ulid();
      await store.transaction((tx) =>
        tx.insertNotification({
          id,
          channelId: CH,
          userId: 'ana',
          type: 'asset.approved',
          severity: 'info',
          read: false,
          createdAt: '2026-10-18T10:00:00.000Z',
        }),
      );
      assert.equal(await store.transaction((tx) => tx.markRead(CH, 'ben', id, true)), false);
      assert.equal(await store.transaction((tx) => tx.markRead(CH, 'ana', id, true)), true);
      assert.equal(await store.unreadCount(CH, 'ana'), 0);
      assert.equal((await store.notifications(CH, 'ana', 5))[0]?.read, true);
    });
  });

  test(`[${name}] a shared notification: one row, each reader's read state their own, only for its audience`, async () => {
    await withFixture(async ({ store }) => {
      const [older, newer] = [ulid(), ulid()].sort();
      for (const id of [older!, newer!])
        await store.transaction((tx) =>
          tx.insertShared({
            id,
            channelId: CH,
            type: 'alert',
            severity: 'critical',
            title: `alert ${id}`,
            createdAt: '2026-10-18T10:00:00.000Z',
            audience: { permission: 'ops:read' },
          }),
        );
      const seen = await store.sharedFor(CH, ['ops:read'], 'ops1', 10);
      assert.deepEqual(
        seen.map((n) => [n.id, n.userId, n.read]),
        [
          [newer, 'ops1', false],
          [older, 'ops1', false],
        ],
      );
      assert.equal(
        await store.transaction((tx) => tx.markSharedRead(CH, 'ops1', newer!, true, [])),
        false,
        'not their audience',
      );
      assert.equal(
        await store.transaction((tx) => tx.markSharedRead(CH, 'ops1', newer!, true, ['ops:read'])),
        true,
      );
      assert.equal(await store.sharedUnread(CH, ['ops:read'], 'ops1'), 1);
      assert.equal(await store.sharedUnread(CH, ['ops:read'], 'ops2'), 2, 'their own state');
      assert.deepEqual(await store.sharedFor(CH, [], 'ops1', 10), []);
      assert.deepEqual(await store.sharedFor('ch99', ['ops:read'], 'ops1', 10), []);
    });
  });

  test(`[${name}] preferences: one row per person per channel, a compare-and-set`, async () => {
    await withFixture(async ({ store }) => {
      const p = (version: number, on: boolean, channelId = CH) => ({
        channelId,
        userId: 'ana',
        types: { 'asset.approved': on },
        version,
        updatedAt: '2026-10-18T10:00:00.000Z',
      });
      assert.equal(await store.preferences(CH, 'ana'), undefined);
      assert.equal(await store.transaction((tx) => tx.putPreferences(p(1, false), 0)), true);
      assert.equal(await store.transaction((tx) => tx.putPreferences(p(1, true), 0)), false);
      assert.equal(await store.transaction((tx) => tx.putPreferences(p(2, true), 1)), true);
      assert.equal(await store.transaction((tx) => tx.putPreferences(p(3, false), 1)), false);
      assert.deepEqual((await store.preferences(CH, 'ana'))?.types, { 'asset.approved': true });
      assert.equal(await store.preferences('ch99', 'ana'), undefined, 'per channel');
    });
  });

  test(`[${name}] open tasks come oldest-due first, undated last`, async () => {
    await withFixture(async ({ service }) => {
      const ids: string[] = [];
      for (const dueAt of ['2026-10-30T00:00:00.000Z', undefined, '2026-10-20T00:00:00.000Z']) {
        const taskId = ulid();
        ids.push(taskId);
        await service.consumeTaskCreated(
          event('workflow.task.created', {
            taskId,
            assignee: 'user-7',
            assigneeKind: 'user',
            ...(dueAt !== undefined ? { dueAt } : {}),
          }),
        );
      }
      const { tasks } = await service.inbox({ userId: 'user-7', channelId: CH });
      assert.deepEqual(
        tasks.map((t) => t.id),
        [ids[2], ids[0], ids[1]],
      );
    });
  });

  test(`[${name}] an expired approval tells its approver, once — and nobody when there was none`, async () => {
    await withFixture(async ({ service, pipeline, drain }) => {
      const assetId = ulid();
      const msg = event('asset.expired', {
        assetId,
        expiredAt: '2026-10-16T00:00:00.000Z',
        priorApprover: 'user-3',
      });
      assert.equal(await pipeline.consumeAssetExpired(msg), 'applied');
      assert.equal(await pipeline.consumeAssetExpired(msg), 'duplicate');
      assert.equal(
        await pipeline.consumeAssetExpired(
          event('asset.expired', { assetId, expiredAt: '2026-10-16T00:00:00.000Z' }),
        ),
        'skipped',
      );

      const inbox = await service.inbox({ userId: 'user-3', channelId: CH });
      assert.equal(inbox.unreadCount, 1);
      assert.deepEqual(
        inbox.notifications.map((n) => [n.type, n.severity, n.read, n.subjectRef?.entityId]),
        [['asset.re-review-due', 'warning', false, assetId]],
      );
      assert.equal((await service.inbox({ userId: 'user-4', channelId: CH })).unreadCount, 0);
      const raised = (await drain()).filter((e) => e.type === 'notification.raised');
      assert.equal(raised.length, 1);
      assert.equal((raised[0]?.payload as { userId: string }).userId, 'user-3');
    });
  });

  test(`[${name}] RACE: two holders claim one role task at once — the version lets exactly one win`, async () => {
    await withFixture(async ({ service, store }) => {
      const taskId = ulid();
      await service.consumeTaskCreated(
        event('workflow.task.created', { taskId, assignee: 'editor', assigneeKind: 'role' }),
      );
      const actions = new TaskActions({
        store,
        principals: fakePrincipals({
          ana: [{ kind: 'role', id: 'editor' }],
          ben: [{ kind: 'role', id: 'editor' }],
        }),
      });
      const as = (userId: string) => ({
        userId,
        channelId: CH,
        policy: compile({ subjectId: userId, permVersion: 1, rules: [], roles: [], groups: [] }),
      });
      const outcomes = await Promise.allSettled([
        actions.claim(as('ana'), taskId),
        actions.claim(as('ben'), taskId),
      ]);
      assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
      const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
      assert.equal((rejected.reason as { status?: number }).status, 409);
      const task = await store.task(taskId);
      assert.equal(task?.version, 2, 'one write, not two');
      assert.ok(['ana', 'ben'].includes(task?.assignee ?? ''));
    });
  });

  test(`[${name}] what is not the event it claims is thrown to the broker, never skipped`, async () => {
    await withFixture(async ({ service, pipeline, store }) => {
      await assert.rejects(
        service.consumeTaskCreated({ id: ulid(), subject: 's', body: { not: 'an envelope' } }),
        /not an envelope/,
      );
      await assert.rejects(
        service.consumeTaskCreated(event('workflow.task.created', { assignee: 'user-1' })),
        /taskId/,
      );
      await assert.rejects(
        pipeline.consumeAssetExpired(
          event('workflow.task.created', { taskId: ulid(), assignee: 'u' }),
        ),
        /not a asset.expired/,
      );
      assert.deepEqual(await store.openTasks(CH, [{ kind: 'user', id: 'user-1' }], 10), []);
    });
  });
}
