// A behaviour suite every WorkflowStore must pass — sqlite in tests, Postgres in production.
//
// Driven through BmsService, because what has to hold on the deployed store are properties of the
// unit of work: a draft saved and audited together, compare-and-set on `revision` that lets exactly
// one of two racing writes through, a published version that nothing can write again, at most one
// draft per workflow, and every read channel-scoped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUlid, ulid, type Envelope, type EventPayloads } from '@atlas/contracts';
import type { WorkflowDefinition } from '@atlas/contracts/workflow';
import { InMemoryBroker, OutboxRelay, type OutboxStore } from '@atlas/messaging';
import { compile } from '@atlas/policy';
import type { Instance } from './instance.ts';
import { BmsRuntime } from './runtime.ts';
import { BmsService, type Caller } from './service.ts';
import type { WorkflowStore } from './store.ts';
import type { DraftInput } from './workflow.ts';

export interface WorkflowStoreHarness {
  /** A clean store, plus the outbox store the relay drains — both on the same database. */
  make: () => Promise<{
    store: WorkflowStore;
    outbox: OutboxStore;
    cleanup?: () => Promise<void>;
  }>;
}

const CH = 'ch12';
const caller = (channelId = CH): Caller => ({
  userId: 'user-1',
  channelId,
  correlationId: ulid(),
  policy: compile({
    subjectId: 'user-1',
    permVersion: 1,
    rules: [{ id: 'r', permissions: ['workflow:admin'] }],
    roles: [],
    groups: [],
  }),
});

const presets = new URL('../../../docs/architecture/workflows/presets/', import.meta.url);
/** A preset from docs/, as the designer would send it — the server's header fields dropped. */
export function presetInput(name: string): DraftInput {
  const def = JSON.parse(readFileSync(new URL(name, presets), 'utf8')) as WorkflowDefinition;
  return {
    name: def.name,
    ...(def.description !== undefined ? { description: def.description } : {}),
    ...(def.vars !== undefined ? { vars: def.vars } : {}),
    steps: def.steps,
    transitions: def.transitions,
  };
}

export function workflowStoreConformance(name: string, harness: WorkflowStoreHarness): void {
  async function withFixture(
    fn: (f: {
      service: BmsService;
      store: WorkflowStore;
      drain: () => Promise<Envelope[]>;
    }) => Promise<void>,
  ): Promise<void> {
    const { store, outbox, cleanup } = await harness.make();
    const broker = new InMemoryBroker();
    const relay = new OutboxRelay(outbox, broker);
    const service = new BmsService({ store });
    const drain = async (): Promise<Envelope[]> => {
      await relay.drain();
      return broker.published.map((m) => m.body as Envelope);
    };
    try {
      await fn({ service, store, drain });
    } finally {
      await cleanup?.();
      await store.close().catch(() => undefined);
    }
  }

  test(`[${name}] create → save → publish: versions, revisions and one audit record per write`, async () => {
    await withFixture(async ({ service, drain }) => {
      const input = presetInput('simple-approval.workflow.json');
      const created = await service.create(caller(), input);
      assert.equal(created.revision, 1);
      assert.equal(created.latestVersion, 0);
      assert.equal(created.draftVersion, 1);
      assert.equal(created.draft?.status, 'draft');
      assert.equal(created.draft?.id, created.id, 'the definition carries the server-side id');

      const saved = await service.saveDraft(caller(), created.id, 1, {
        ...input,
        description: 'edited',
      });
      assert.equal(saved.revision, 2);
      assert.equal(saved.draftVersion, 1, 'saving again edits the same draft');

      const published = await service.publish(caller(), created.id, 2);
      assert.equal(published.version, 1);
      assert.equal(published.revision, 3);
      const after = await service.get(caller(), created.id);
      assert.equal(after.latestVersion, 1);
      assert.equal(after.draftVersion, undefined, 'publishing closes the draft');
      assert.equal(after.draft, undefined);
      assert.deepEqual(
        after.versions.map((v) => v.version),
        [1],
      );
      assert.equal((await service.version(caller(), created.id, 1)).status, 'published');

      // One audit record per write, revisions 1..3, every one channel-scoped and delta-carrying.
      const audits = (await drain()).filter((e) => e.type === 'audit.recorded');
      const payloads = audits.map((e) => e.payload as unknown as EventPayloads['audit.recorded']);
      assert.deepEqual(
        payloads.map((p) => [p.action, p.revision]),
        [
          ['workflow.created', 1],
          ['workflow.draft-saved', 2],
          ['workflow.published', 3],
        ],
      );
      assert.ok(audits.every((e) => e.channelId === CH));
      assert.equal(payloads[1]?.delta['description']?.after, 'edited');
      assert.deepEqual(payloads[2]?.delta['latestVersion'], { before: 0, after: 1 });
    });
  });

  test(`[${name}] a published version is never written again; the next save opens version 2`, async () => {
    await withFixture(async ({ service, store }) => {
      const input = presetInput('simple-approval.workflow.json');
      const w = await service.create(caller(), input);
      await service.publish(caller(), w.id, 1);

      // The store itself refuses: the row is published, so the upsert matches nothing.
      const v1 = (await store.version(w.id, 1))!;
      const rewritten = await store.transaction((tx) =>
        tx.putVersion({ ...v1, status: 'draft', definition: { ...v1.definition, name: 'x' } }),
      );
      assert.equal(rewritten, false);
      assert.equal((await store.version(w.id, 1))?.definition.name, input.name);

      const next = await service.saveDraft(caller(), w.id, 2, { ...input, name: 'Second' });
      assert.equal(next.draftVersion, 2);
      assert.equal(next.latestVersion, 1);
      assert.equal(next.name, 'Second', 'the header shows what the author is working on');
      assert.equal((await service.version(caller(), w.id, 1)).name, input.name);
    });
  });

  test(`[${name}] compare-and-set on revision: of two racing saves exactly one wins`, async () => {
    await withFixture(async ({ service, drain }) => {
      const input = presetInput('simple-approval.workflow.json');
      const w = await service.create(caller(), input);
      const results = await Promise.allSettled([
        service.saveDraft(caller(), w.id, 1, { ...input, name: 'A' }),
        service.saveDraft(caller(), w.id, 1, { ...input, name: 'B' }),
      ]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
      const lost = results.find((r) => r.status === 'rejected');
      assert.match(String((lost as PromiseRejectedResult).reason), /changed under this edit/);
      const after = await service.get(caller(), w.id);
      assert.equal(after.revision, 2);
      // The loser left nothing: one created, one saved.
      const audits = (await drain()).filter((e) => e.type === 'audit.recorded');
      assert.equal(audits.length, 2);
      // A stale revision is refused outright.
      await assert.rejects(service.publish(caller(), w.id, 1), /changed under this edit/);
    });
  });

  test(`[${name}] at most one draft per workflow — the index holds it, not only the service`, async () => {
    await withFixture(async ({ service, store }) => {
      const w = await service.create(caller(), presetInput('simple-approval.workflow.json'));
      const v1 = (await store.version(w.id, 1))!;
      await assert.rejects(
        store.transaction((tx) => tx.putVersion({ ...v1, version: 2 })),
        'a second draft row violates the partial unique index',
      );
    });
  });

  test(`[${name}] reads are channel-scoped, and the list pages by id`, async () => {
    await withFixture(async ({ service }) => {
      const input = presetInput('simple-approval.workflow.json');
      const a = await service.create(caller(), { ...input, name: 'A' });
      const b = await service.create(caller(), { ...input, name: 'B' });
      await service.create(caller('ch99'), { ...input, name: 'Elsewhere' });
      await assert.rejects(service.get(caller('ch99'), a.id), { name: 'NotFound' });
      const first = await service.list(caller(), { limit: 1 });
      assert.equal(first.items.length, 1);
      assert.ok(first.nextCursor);
      const second = await service.list(caller(), { after: first.nextCursor!, limit: 1 });
      assert.deepEqual(
        [...first.items, ...second.items].map((x) => x.id).sort(),
        [a.id, b.id].sort(),
      );
    });
  });

  const instance = (over: Partial<Instance> = {}): Instance => ({
    id: ulid(),
    channelId: CH,
    workflowId: ulid(),
    version: 1,
    state: 'running',
    currentSteps: [],
    startedAt: '2026-10-12T10:00:00.000Z',
    startedBy: 'user-1',
    ...over,
  });

  test(`[${name}] an instance mirror: one row per id, its history one row per sequence number`, async () => {
    await withFixture(async ({ store }) => {
      const runtime = new BmsRuntime({ store });
      const i = instance();
      assert.equal(await store.transaction((tx) => tx.insertInstance(i)), true);
      assert.equal(
        await store.transaction((tx) => tx.insertInstance(i)),
        false,
        'a retried start is the same instance',
      );

      await runtime.recordHistory({ instanceId: i.id, seq: 1, stepId: 's_wait', event: 'entered' });
      await runtime.recordHistory({
        instanceId: i.id,
        seq: 2,
        stepId: 's_wait',
        event: 'awaiting',
      });
      // A retried activity: the same sequence number lands on the same row, and moves nothing.
      await runtime.recordHistory({
        instanceId: i.id,
        seq: 2,
        stepId: 's_wait',
        event: 'awaiting',
      });
      const waiting = await store.instance(i.id);
      assert.equal(waiting?.state, 'waiting');
      assert.deepEqual(waiting?.currentSteps, ['s_wait']);
      assert.deepEqual(
        (await store.history(i.id)).map((h) => [h.seq, h.event]),
        [
          [1, 'entered'],
          [2, 'awaiting'],
        ],
      );
      await runtime.recordHistory({
        instanceId: i.id,
        seq: 3,
        stepId: 's_wait',
        event: 'completed',
      });
      assert.equal((await store.instance(i.id))?.state, 'running');
    });
  });

  test(`[${name}] an activity retried after it committed writes nothing again`, async () => {
    await withFixture(async ({ store, drain }) => {
      const runtime = new BmsRuntime({ store });
      const i = instance();
      await store.transaction((tx) => tx.insertInstance(i));
      const req = {
        stepId: 's_cmd',
        event: 'transcode.job.create',
        payload: { assetId: ulid(), presetIds: ['proxy'], inputFile: { kind: 'original' } },
        correlationId: `${i.id}::s_cmd:1`,
        idempotencyKey: `${i.id}:s_cmd:1`,
      };
      const first = await runtime.requestStep({ key: `${i.id}:1`, instanceId: i.id, req });
      const again = await runtime.requestStep({ key: `${i.id}:1`, instanceId: i.id, req });
      assert.equal(again.correlationId, first.correlationId, 'a retry names the same command');
      const spec = {
        instanceId: i.id,
        stepId: 's_task',
        taskType: 'review',
        assignee: { role: 'editor' },
      };
      const t1 = await runtime.createTask({ key: `${i.id}:2`, spec });
      const t2 = await runtime.createTask({ key: `${i.id}:2`, spec });
      assert.equal(t1, t2, 'a retried task is the same task');
      const result = { state: 'completed' as const, vars: { ok: true } };
      await runtime.finish({ instanceId: i.id, result });
      await runtime.finish({ instanceId: i.id, result });

      const types = (await drain()).map((e) => e.type);
      assert.deepEqual(types.filter((t) => t === 'workflow.step.requested').length, 1);
      assert.deepEqual(types.filter((t) => t === 'transcode.job.create').length, 1);
      assert.deepEqual(types.filter((t) => t === 'workflow.task.created').length, 1);
      assert.deepEqual(types.filter((t) => t === 'workflow.completed').length, 1);
      assert.equal((await store.instance(i.id))?.state, 'completed');
    });
  });

  test(`[${name}] a command step issues the target's OWN command under a derived correlation id, and awaits it`, async () => {
    await withFixture(async ({ store, drain }) => {
      const runtime = new BmsRuntime({ store });
      const i = instance();
      await store.transaction((tx) => tx.insertInstance(i));
      const assetId = ulid();
      const req = (payload: Record<string, unknown>, event = 'transcode.job.create') => ({
        stepId: 's_cmd',
        event,
        payload,
        correlationId: `${i.id}::s_cmd:1`,
        idempotencyKey: `${i.id}:s_cmd:1`,
      });
      const good = { assetId, presetIds: ['broadcast'], inputFile: { kind: 'original' } };
      const { correlationId } = await runtime.requestStep({
        key: `${i.id}:1`,
        instanceId: i.id,
        req: req(good),
      });
      assert.ok(isUlid(correlationId), 'an envelope correlation id is a ULID');

      const sent = await drain();
      const command = sent.find((e) => e.type === 'transcode.job.create');
      assert.equal(command?.channelId, i.channelId);
      assert.equal(command?.correlationId, correlationId, 'what the answer will carry back');
      assert.deepEqual(command?.actor, { kind: 'service', id: 'bms' });
      assert.deepEqual(command?.payload, good);
      const requested = sent.find((e) => e.type === 'workflow.step.requested');
      assert.equal((requested?.payload as { target?: string }).target, 'mts');

      const awaited = await store.commandAwait(correlationId);
      assert.equal(awaited?.instanceId, i.id);
      assert.equal(awaited?.stepId, 's_cmd');
      assert.equal(awaited?.answeredAt, undefined);

      // The same step visited again (a loop, a retry) is a NEW command — the key is the activity's.
      const next = await runtime.requestStep({
        key: `${i.id}:2`,
        instanceId: i.id,
        req: req(good),
      });
      assert.notEqual(next.correlationId, correlationId);

      // Answered at most once.
      const answer = (by: string) =>
        store.transaction((tx) => tx.answerAwait(correlationId, new Date().toISOString(), by));
      assert.equal(await answer('m1'), true);
      assert.equal(await answer('m2'), false);
      assert.equal((await store.commandAwait(correlationId))?.answeredBy, 'm1');

      // A command off its schema, or not one a workflow may issue: refused, nothing written.
      const before = (await drain()).length;
      await assert.rejects(
        runtime.requestStep({ key: `${i.id}:3`, instanceId: i.id, req: req({ assetId }) }),
        /presetIds/,
      );
      await assert.rejects(
        runtime.requestStep({
          key: `${i.id}:4`,
          instanceId: i.id,
          req: req({ assetId }, 'asset.approved'),
        }),
        /not a command a workflow may issue/,
      );
      assert.equal((await drain()).length, before);
    });
  });

  test(`[${name}] a step waiting for an event: its keys as a row, found by type and asset, answered once`, async () => {
    await withFixture(async ({ store, drain }) => {
      const runtime = new BmsRuntime({ store });
      const assetId = ulid();
      const i = { ...instance(), assetId };
      await store.transaction((tx) => tx.insertInstance(i));
      const wait = { stepId: 's_wait', event: 'asset.ready', match: { assetId } };
      const { correlationId } = await runtime.awaitEvent({
        key: `${i.id}:1`,
        instanceId: i.id,
        wait,
      });
      // A retried activity names the same row and writes nothing new.
      const again = await runtime.awaitEvent({ key: `${i.id}:1`, instanceId: i.id, wait });
      assert.equal(again.correlationId, correlationId);
      // A wait keyed on something other than an asset is offered every asset of the type.
      await runtime.awaitEvent({
        key: `${i.id}:2`,
        instanceId: i.id,
        wait: { stepId: 's_any', event: 'asset.ready', match: { 'meta.x': 1 } },
      });

      const open = await store.openEventAwaits(CH, 'asset.ready', assetId);
      assert.deepEqual(open.map((a) => a.stepId).sort(), ['s_any', 's_wait']);
      assert.deepEqual(
        (await store.openEventAwaits(CH, 'asset.ready', ulid())).map((a) => a.stepId),
        ['s_any'],
        'another asset narrows to the unkeyed wait',
      );
      assert.equal((await store.openEventAwaits('ch99', 'asset.ready', assetId)).length, 0);
      assert.equal((await store.openEventAwaits(CH, 'asset.approved', assetId)).length, 0);

      const answer = (by: string) =>
        store.transaction((tx) =>
          tx.answerEventAwaits(correlationId, new Date().toISOString(), by),
        );
      assert.equal(await answer('m1'), true);
      assert.equal(await answer('m2'), false);
      assert.deepEqual(
        (await store.openEventAwaits(CH, 'asset.ready', assetId)).map((a) => a.stepId),
        ['s_any'],
      );
      await assert.rejects(
        runtime.awaitEvent({
          key: `${i.id}:3`,
          instanceId: i.id,
          wait: { ...wait, event: 'permissions.changed' },
        }),
        /not an event a workflow may wait for/,
      );

      // A review step's task: two verdict rows under the task's id, the point on each, answered
      // together; the task names the point.
      const taskId = await runtime.createTask({
        key: `${i.id}:4`,
        spec: {
          instanceId: i.id,
          stepId: 's_review',
          taskType: 'approve',
          assignee: { role: 'editor' },
          reviewPointId: 'pre-schedule',
        },
      });
      for (const type of ['asset.approved', 'asset.rejected']) {
        const [row] = await store.openEventAwaits(CH, type, assetId);
        assert.equal(row?.correlationId, taskId, type);
        assert.equal(row?.reviewPointId, 'pre-schedule', type);
      }
      const task = (await drain()).find((e) => e.type === 'workflow.task.created');
      assert.equal(
        (task?.payload as unknown as EventPayloads['workflow.task.created']).reviewPointId,
        'pre-schedule',
      );
      assert.equal(
        await store.transaction((tx) =>
          tx.answerEventAwaits(taskId, new Date().toISOString(), 'v'),
        ),
        true,
      );
      assert.equal((await store.openEventAwaits(CH, 'asset.rejected', assetId)).length, 0);
    });
  });

  test(`[${name}] instances list newest first, by channel, and by workflow`, async () => {
    await withFixture(async ({ store }) => {
      const wf = ulid();
      const a = instance({ workflowId: wf });
      const b = instance({ workflowId: wf });
      const c = instance();
      const elsewhere = instance({ channelId: 'ch99' });
      for (const i of [a, b, c, elsewhere]) await store.transaction((tx) => tx.insertInstance(i));
      const all = await store.instances(CH, { limit: 10 });
      assert.deepEqual(
        all.map((x) => x.id),
        [c.id, b.id, a.id].sort().reverse(),
      );
      assert.deepEqual(
        (await store.instances(CH, { workflowId: wf, limit: 10 })).map((x) => x.id).sort(),
        [a.id, b.id].sort(),
      );
      const first = await store.instances(CH, { limit: 1 });
      const next = await store.instances(CH, { after: first[0]!.id, limit: 10 });
      assert.equal(first.length + next.length, 3);
    });
  });

  test(`[${name}] a start racing a deactivation: never both — no instance runs on an inactive workflow`, async () => {
    await withFixture(async ({ store }) => {
      // A runner that accepts and does nothing: the instance stays `running` in the mirror, which
      // is exactly what deactivation must see.
      const service = new BmsService({
        store,
        runner: { start: async () => undefined, signal: async () => undefined },
      });
      const admin: Caller = {
        ...caller(),
        policy: compile({
          subjectId: 'user-1',
          permVersion: 1,
          rules: [{ id: 'r', permissions: ['workflow:admin', 'workflow:act'] }],
          roles: [],
          groups: [],
        }),
      };
      for (let round = 0; round < 5; round++) {
        const w = await service.create(admin, presetInput('simple-approval.workflow.json'));
        await service.publish(admin, w.id, 1);
        const [started, deactivated] = await Promise.allSettled([
          service.startInstance(admin, { workflowId: w.id }),
          service.deactivate(admin, w.id, 2),
        ]);
        assert.ok(
          !(started.status === 'fulfilled' && deactivated.status === 'fulfilled'),
          `round ${round}: an instance started AND the workflow was deactivated`,
        );
        assert.ok(
          started.status === 'fulfilled' || deactivated.status === 'fulfilled',
          `round ${round}: neither won: ${String((started as PromiseRejectedResult).reason)} / ${String((deactivated as PromiseRejectedResult).reason)}`,
        );
        const header = await store.get(w.id);
        const live = (await store.instances(CH, { workflowId: w.id, limit: 10 })).length;
        assert.equal(header?.state === 'inactive' ? live : 1, header?.state === 'inactive' ? 0 : 1);
      }
    });
  });
}
