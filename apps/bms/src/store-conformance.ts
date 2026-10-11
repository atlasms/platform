// A behaviour suite every WorkflowStore must pass — sqlite in tests, Postgres in production.
//
// Driven through BmsService, because what has to hold on the deployed store are properties of the
// unit of work: a draft saved and audited together, compare-and-set on `revision` that lets exactly
// one of two racing writes through, a published version that nothing can write again, at most one
// draft per workflow, and every read channel-scoped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ulid, type Envelope, type EventPayloads } from '@atlas/contracts';
import type { WorkflowDefinition } from '@atlas/contracts/workflow';
import { InMemoryBroker, OutboxRelay, type OutboxStore } from '@atlas/messaging';
import { compile } from '@atlas/policy';
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
}
