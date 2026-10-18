// The inbox store's conformance suite, driven THROUGH the service — the behaviour lifted from
// reference/notifications-service, held on node:sqlite and on a real Postgres alike. Add a
// behaviour here, not to one adapter (AGENTS.md §3).

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, subjectFor, ulid, type Envelope } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type Message, type OutboxStore } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import { fakePrincipals } from './principals.ts';
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
      await fn({ service: new NotificationsService({ store }), store, drain });
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
    await withFixture(async ({ service, drain }) => {
      const assetId = ulid();
      const msg = event('asset.expired', {
        assetId,
        expiredAt: '2026-10-16T00:00:00.000Z',
        priorApprover: 'user-3',
      });
      assert.equal(await service.consumeAssetExpired(msg), 'applied');
      assert.equal(await service.consumeAssetExpired(msg), 'duplicate');
      assert.equal(
        await service.consumeAssetExpired(
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
    await withFixture(async ({ service, store }) => {
      await assert.rejects(
        service.consumeTaskCreated({ id: ulid(), subject: 's', body: { not: 'an envelope' } }),
        /not an envelope/,
      );
      await assert.rejects(
        service.consumeTaskCreated(event('workflow.task.created', { assignee: 'user-1' })),
        /taskId/,
      );
      await assert.rejects(
        service.consumeAssetExpired(
          event('workflow.task.created', { taskId: ulid(), assignee: 'u' }),
        ),
        /not a asset.expired/,
      );
      assert.deepEqual(await store.openTasks(CH, [{ kind: 'user', id: 'user-1' }], 10), []);
    });
  });
}
