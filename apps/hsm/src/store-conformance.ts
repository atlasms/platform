// A behaviour suite every HsmStore must pass — sqlite in tests, Postgres in production — driven
// through HsmService with REAL bytes on a filesystem target in a temporary directory. What has to
// hold on the store actually deployed (ADR-0009):
//   - a placement is referenced only after its bytes are written and its signature verified; the
//     ledger's checksum is of the bytes written; the same bytes again change nothing;
//   - a replacement keeps the file's id, bumps its version, and releases the old bytes only by an
//     operation queued in its transaction — referenced bytes are never removed;
//   - two placements of one new file race to exactly one row;
//   - copy/move/delete run leased, verify at the destination, and a corrupt source is quarantined
//     and alerted, never propagated;
//   - a failure retries with backoff, a refusal dead-letters at once, a lapsed lease is taken back,
//     and two workers never run one operation;
//   - storage targets: one default per (scope, tier), roots inside the mounted base, platform-wide
//     behind an unscoped grant, every write audited; location behind asset:read on `files`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ulid, validatePayload, type Envelope, type EventPayloads } from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type OutboxStore } from '@atlas/messaging';
import { compile, type EffectivePolicy, type Rule } from '@atlas/policy';
import type { StorageDriver } from './driver.ts';
import type { PlacementInput } from './file.ts';
import { HsmService, type Caller } from './service.ts';
import type { HsmStore } from './store.ts';
import { driverFactory, type DriverFactory, type StorageTarget } from './targets.ts';

export interface HsmStoreHarness {
  make: () => Promise<{ store: HsmStore; outbox: OutboxStore; cleanup?: () => Promise<void> }>;
}

const CH = 'ch12';
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const policyOf = (rules: Rule[]): EffectivePolicy =>
  compile({ subjectId: 'u1', permVersion: 1, rules, roles: [], groups: [] });
const caller = (
  rules: Rule[] = [{ id: 'all', permissions: ['asset:read', 'storage:admin'] }],
  channelId = CH,
): Caller => ({
  userId: 'u1',
  channelId,
  policy: policyOf(rules),
  correlationId: ulid(),
});
const placement = (over: Partial<PlacementInput> = {}): PlacementInput => ({
  channelId: CH,
  assetId: ulid(),
  kind: 'proxy',
  producedBy: 'transcode',
  ...over,
});
const bytes = (text: string): Readable => Readable.from([Buffer.from(text)]);

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}

export function hsmStoreConformance(name: string, harness: HsmStoreHarness): void {
  interface Fixture {
    service: HsmService;
    store: HsmStore;
    base: string;
    online: StorageTarget;
    clock: { now: number };
    drain: () => Promise<Envelope[]>;
    /** A second target (fs, online) for copies and moves. */
    second: () => Promise<StorageTarget>;
    /** Wrap the driver factory, to make a target misbehave. */
    faults: { onWrite?: () => void };
  }

  async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
    const { store, outbox, cleanup } = await harness.make();
    const base = await mkdtemp(join(tmpdir(), 'hsm-conf-'));
    const broker = new InMemoryBroker();
    const relay = new OutboxRelay(outbox, broker);
    const clock = { now: Date.parse('2026-10-01T10:00:00.000Z') };
    const faults: Fixture['faults'] = {};
    const real = driverFactory({ credentialsDir: join(base, 'credentials') });
    const drivers: DriverFactory = async (target) => {
      const d = await real(target);
      const wrapped: StorageDriver = {
        ...d,
        write: (key, source) => {
          faults.onWrite?.();
          return d.write(key, source);
        },
      };
      return wrapped;
    };
    const service = new HsmService({
      store,
      drivers,
      now: () => new Date(clock.now),
      leaseMs: 30_000,
    });
    await mkdir(join(base, 'online'), { recursive: true });
    const online = (await service.bootstrapTarget(join(base, 'online')))!;
    let seen = 0;
    const drain = async (): Promise<Envelope[]> => {
      await relay.drain();
      const all = broker.published.map((m) => m.body as Envelope);
      const fresh = all.slice(seen);
      seen = all.length;
      return fresh;
    };
    const second = async (): Promise<StorageTarget> => {
      await mkdir(join(base, 'second'), { recursive: true });
      return service.createTarget(
        caller(),
        {
          name: 'second',
          tier: 'near-line',
          kind: 'fs',
          root: join(base, 'second'),
          isDefault: false,
          enabled: true,
        },
        false,
      );
    };
    try {
      await fn({ service, store, base, online, clock, drain, second, faults });
    } finally {
      await cleanup?.();
      await store.close().catch(() => undefined);
      await rm(base, { recursive: true, force: true });
    }
  }

  const types = (events: Envelope[]) => events.map((e) => e.type);

  test(`[${name}] PLACE: bytes written and verified, then referenced — the checksum HSM's own, with the event and the audit`, async () => {
    await withFixture(async ({ service, store, base, drain }) => {
      await drain();
      const input = placement({ variant: 'en', technical: { container: 'mp4' }, jobId: ulid() });
      let digestSeen = '';
      const { file, outcome } = await service.place(input, bytes('proxy bytes'), (d) => {
        digestSeen = d;
        return true;
      });
      assert.equal(outcome, 'created');
      assert.equal(
        digestSeen,
        sha('proxy bytes'),
        'the signature is checked against what was written',
      );
      assert.deepEqual(file.checksum, { algorithm: 'sha256', value: sha('proxy bytes') });
      assert.equal(file.sizeBytes, 11);
      assert.equal(file.storage.path.startsWith(`${CH}/${input.assetId}/proxy.en/`), true);
      assert.deepEqual(await store.liveFile(input.assetId, 'proxy', 'en'), file);

      const events = await drain();
      assert.deepEqual(types(events), ['file.placed', 'audit.recorded']);
      const placed = events[0]!.payload as unknown as EventPayloads['file.placed'];
      assert.ok(validatePayload('file.placed', placed).valid);
      assert.deepEqual(
        [placed.fileId, placed.sizeBytes, placed.variant, placed.checksum?.value],
        [file.id, 11, 'en', sha('proxy bytes')],
      );

      const { stream } = await service.content(input.assetId, 'proxy', 'en');
      const back: Buffer[] = [];
      for await (const c of stream) back.push(c as Buffer);
      assert.equal(Buffer.concat(back).toString(), 'proxy bytes');
      assert.equal((await filesUnder(join(base, 'online'))).length, 1);
    });
  });

  test(`[${name}] PLACE: a signature that does not match the bytes is refused — nothing referenced, nothing left`, async () => {
    await withFixture(async ({ service, store, base, drain }) => {
      await drain();
      const input = placement();
      await assert.rejects(
        service.place(input, bytes('tampered'), () => false),
        /does not match/,
      );
      assert.equal(await store.liveFile(input.assetId, 'proxy'), undefined);
      assert.deepEqual(await filesUnder(join(base, 'online')), []);
      assert.deepEqual(await drain(), []);
    });
  });

  test(`[${name}] PLACE: the same bytes again change nothing; other bytes replace, and the old bytes go only by a queued release`, async () => {
    await withFixture(async ({ service, store, base, drain }) => {
      const input = placement();
      const first = await service.place(input, bytes('version one'), () => true);
      await drain();
      const again = await service.place(input, bytes('version one'), () => true);
      assert.equal(again.outcome, 'unchanged');
      assert.deepEqual(again.file, first.file);
      assert.deepEqual(await drain(), [], 'a retry announces nothing');
      assert.equal(
        (await filesUnder(join(base, 'online'))).length,
        1,
        "the retry's copy is removed",
      );

      const second = await service.place(input, bytes('version two'), () => true);
      assert.equal(second.outcome, 'replaced');
      assert.equal(second.file.id, first.file.id, 'one file, two versions');
      assert.equal(second.file.version, 2);
      assert.notEqual(second.file.storage.path, first.file.storage.path, 'never written over');
      const audit = (await drain()).find((e) => e.type === 'audit.recorded')!
        .payload as unknown as EventPayloads['audit.recorded'];
      assert.equal(audit.action, 'file.replaced');
      assert.deepEqual(audit.delta['checksum'], {
        before: first.file.checksum,
        after: second.file.checksum,
      });

      // Until the release runs, both are there; after, only the live one.
      assert.equal((await filesUnder(join(base, 'online'))).length, 2);
      assert.equal(await service.work('w1', 10), 1);
      const left = await filesUnder(join(base, 'online'));
      assert.equal(left.length, 1);
      assert.ok(left[0]!.replaceAll('\\', '/').endsWith(second.file.storage.path));
      assert.equal((await store.liveFile(input.assetId, 'proxy'))!.version, 2);
    });
  });

  test(`[${name}] PLACE: two placements of one file — whatever the interleaving, one live row, its bytes, nothing orphaned`, async () => {
    await withFixture(async ({ service, store, base }) => {
      const input = placement();
      const results = await Promise.allSettled([
        service.place(input, bytes('from worker a'), () => true),
        service.place(input, bytes('from worker b'), () => true),
      ]);
      // Sequenced, the second replaces the first; truly concurrent, the second loses its
      // compare-and-set and is a 409. Never two rows, never a lost row.
      const outcomes = results
        .map((r) => (r.status === 'fulfilled' ? r.value.outcome : 'conflict'))
        .sort();
      assert.ok(
        JSON.stringify(outcomes) === JSON.stringify(['created', 'replaced']) ||
          JSON.stringify(outcomes) === JSON.stringify(['conflict', 'created']),
        JSON.stringify(outcomes),
      );
      const live = (await store.liveFile(input.assetId, 'proxy'))!;
      await service.work('w1', 10); // any release the replacement queued
      const left = await filesUnder(join(base, 'online'));
      assert.equal(left.length, 1, 'only the live bytes remain');
      assert.ok(left[0]!.replaceAll('\\', '/').endsWith(live.storage.path));
    });
  });

  test(`[${name}] the ledger's compare-and-set: one live row per (asset, kind, variant); a stale version writes nothing`, async () => {
    await withFixture(async ({ service, store }) => {
      const input = placement();
      const { file } = await service.place(input, bytes('v1'), () => true);
      const rival = { ...file, id: ulid(), version: 1 };
      assert.equal(
        await store.transaction((tx) => tx.putFile(rival)),
        false,
        'a second live row is refused',
      );
      const stale = { ...file, sizeBytes: 999, version: 2 };
      assert.equal(await store.transaction((tx) => tx.putFile(stale, 7)), false);
      assert.equal((await store.file(file.id))!.sizeBytes, file.sizeBytes);
      assert.equal(await store.transaction((tx) => tx.putFile(stale, 1)), true);
      // A deleted row frees its (asset, kind, variant) for a new live one.
      const deleted = { ...stale, version: 3, deletedAt: '2026-10-01T11:00:00.000Z' };
      assert.equal(await store.transaction((tx) => tx.putFile(deleted, 2)), true);
      assert.equal(await store.transaction((tx) => tx.putFile(rival)), true);
    });
  });

  test(`[${name}] PLACE: no online target is a 409; an asset's files never span channels`, async () => {
    await withFixture(async ({ service, online }) => {
      const input = placement();
      await service.place(input, bytes('x'), () => true);
      await assert.rejects(
        service.place({ ...input, channelId: 'ch99' }, bytes('y'), () => true),
        /another channel/,
      );
      await service.updateTarget(
        caller([{ id: 'u', permissions: ['storage:admin'] }]),
        online.id,
        1,
        {
          name: 'online',
          tier: 'online',
          kind: 'fs',
          root: online.root!,
          isDefault: true,
          enabled: false,
        },
      );
      await assert.rejects(
        service.place(placement(), bytes('z'), () => true),
        /no online storage target/,
      );
    });
  });

  test(`[${name}] COPY and MOVE: leased, verified at the destination, recorded — and a move releases the source`, async () => {
    await withFixture(async ({ service, store, base, drain }) => {
      const input = placement({ kind: 'broadcast' });
      const { file } = await service.place(input, bytes('the master'), () => true);
      const second = await (async () => {
        await mkdir(join(base, 'second'), { recursive: true });
        return service.createTarget(
          caller(),
          {
            name: 'second',
            tier: 'near-line',
            kind: 'fs',
            root: join(base, 'second'),
            isDefault: false,
            enabled: true,
          },
          false,
        );
      })();
      await drain();

      const copyId = ulid();
      const copy = await service.requestOperation(
        { id: copyId, kind: 'copy', fileId: file.id, toTargetId: second.id },
        'test',
      );
      assert.equal(copy.state, 'queued');
      assert.equal(
        (
          await service.requestOperation(
            { id: copyId, kind: 'copy', fileId: file.id, toTargetId: second.id },
            'test',
          )
        ).id,
        copyId,
        'the same request id is the same operation',
      );
      assert.equal(await service.work('w1', 10), 1);
      assert.equal((await service.operation(copyId)).state, 'completed');
      const replicas = await store.replicasOf(file.id);
      assert.deepEqual(
        replicas.map((r) => [r.targetId, r.tier, r.sha256]),
        [[second.id, 'near-line', sha('the master')]],
      );
      assert.equal((await filesUnder(join(base, 'second'))).length, 1);

      const move = await service.requestOperation(
        { kind: 'move', fileId: file.id, toTargetId: second.id },
        'test',
      );
      await assert.rejects(
        service.requestOperation(
          { kind: 'move', fileId: file.id, toTargetId: file.storage.targetId },
          'test',
        ),
        /already on target/,
      );
      await service.work('w1', 10);
      assert.equal((await service.operation(move.id)).state, 'completed');
      const moved = (await store.file(file.id))!;
      assert.deepEqual([moved.storage.targetId, moved.storage.tier], [second.id, 'near-line']);
      const events = await drain();
      const movedEvent = events.find((e) => e.type === 'file.moved')!
        .payload as unknown as EventPayloads['file.moved'];
      assert.deepEqual(
        [movedEvent.fromTier, movedEvent.toTier, movedEvent.fileId],
        ['online', 'near-line', file.id],
      );
      // The source goes by a release queued in the move's transaction.
      await service.work('w1', 10);
      assert.deepEqual(await filesUnder(join(base, 'online')), []);
      const { stream } = await service.content(input.assetId, 'broadcast');
      const back: Buffer[] = [];
      for await (const c of stream) back.push(c as Buffer);
      assert.equal(Buffer.concat(back).toString(), 'the master');
    });
  });

  test(`[${name}] a CORRUPT source is quarantined and alerted, never copied`, async () => {
    await withFixture(async ({ service, store, base, drain, second }) => {
      const { file } = await service.place(placement(), bytes('good bytes'), () => true);
      const target = await second();
      // The bytes rot on disk behind the ledger's back.
      await writeFile(join(base, 'online', ...file.storage.path.split('/')), 'rotten bytes');
      await drain();
      const op = await service.requestOperation(
        { kind: 'copy', fileId: file.id, toTargetId: target.id },
        'test',
      );
      await service.work('w1', 10);
      const after = await service.operation(op.id);
      assert.equal(after.state, 'dead-letter', 'a corrupt source is no retry');
      assert.match(after.error!, /does not match its checksum/);
      assert.equal((await store.file(file.id))!.storage.status, 'quarantined');
      assert.deepEqual(await store.replicasOf(file.id), []);
      assert.deepEqual(await filesUnder(join(base, 'second')), [], 'the bad copy is removed');
      const alert = (await drain()).find((e) => e.type === 'alert.raised')!
        .payload as unknown as EventPayloads['alert.raised'];
      assert.deepEqual(
        [alert.kind, alert.severity, alert.subjectRef],
        ['checksum-mismatch', 'critical', { entityType: 'file', entityId: file.id }],
      );
    });
  });

  test(`[${name}] DELETE: the row stays for audit, leaves the live set, and its bytes and replicas are released`, async () => {
    await withFixture(async ({ service, store, base, second }) => {
      const input = placement();
      const { file } = await service.place(input, bytes('to be deleted'), () => true);
      const target = await second();
      await service.requestOperation(
        { kind: 'copy', fileId: file.id, toTargetId: target.id },
        'test',
      );
      await service.work('w1', 10);
      await service.requestOperation({ kind: 'delete', fileId: file.id }, 'test');
      await service.work('w1', 10); // the delete, then the two releases it queued
      await service.work('w1', 10);
      const row = (await store.file(file.id))!;
      assert.ok(row.deletedAt, 'kept, marked deleted');
      assert.equal(await store.liveFile(input.assetId, 'proxy'), undefined);
      assert.deepEqual(await service.location(caller(), input.assetId), []);
      assert.deepEqual(await filesUnder(join(base, 'online')), []);
      assert.deepEqual(await filesUnder(join(base, 'second')), []);
      // The (asset, kind) is free again.
      assert.equal((await service.place(input, bytes('reborn'), () => true)).outcome, 'created');
    });
  });

  test(`[${name}] RETRY: a failure retries with backoff and dead-letters after ${3}; a lapsed lease is taken back`, async () => {
    await withFixture(async ({ service, store, clock, faults, second }) => {
      const { file } = await service.place(placement(), bytes('flaky'), () => true);
      const target = await second();
      faults.onWrite = () => {
        throw new Error('the NAS went away');
      };
      const op = await service.requestOperation(
        { kind: 'copy', fileId: file.id, toTargetId: target.id },
        'test',
      );
      await service.work('w1', 10);
      let now = await service.operation(op.id);
      assert.deepEqual([now.state, now.attempts], ['failed', 1]);
      assert.equal(now.retryAt, new Date(clock.now + 30_000).toISOString());
      assert.equal(await service.work('w1', 10), 0, 'not before retryAt');
      clock.now += 30_000;
      await service.work('w1', 10);
      clock.now += 60_000;
      await service.work('w1', 10);
      now = await service.operation(op.id);
      assert.deepEqual([now.state, now.attempts], ['dead-letter', 3]);

      // A worker that died holding a lease: the lease lapses and the next tick takes it back.
      delete faults.onWrite;
      const op2 = await service.requestOperation(
        { kind: 'copy', fileId: file.id, toTargetId: target.id },
        'test',
      );
      await store.transaction((tx) =>
        tx.putOperation(
          {
            ...op2,
            state: 'running',
            attempts: 1,
            holder: 'w-dead',
            leaseUntil: new Date(clock.now + 30_000).toISOString(),
          },
          'queued',
        ),
      );
      assert.equal(await service.work('w1', 10), 0, 'a live lease is left alone');
      clock.now += 31_000;
      await service.work('w1', 10);
      const taken = await service.operation(op2.id);
      assert.equal(taken.state, 'failed');
      assert.match(taken.error!, /the worker holding it stopped/);
      clock.now += 30_000;
      await service.work('w1', 10);
      assert.equal((await service.operation(op2.id)).state, 'completed');
    });
  });

  test(`[${name}] LEASE: two workers never run one operation`, async () => {
    await withFixture(async ({ service, second }) => {
      const { file } = await service.place(placement(), bytes('once'), () => true);
      const target = await second();
      const op = await service.requestOperation(
        { kind: 'copy', fileId: file.id, toTargetId: target.id },
        'test',
      );
      const [a, b] = await Promise.all([service.work('w1', 1), service.work('w2', 1)]);
      assert.equal(a + b, 1);
      assert.equal((await service.operation(op.id)).state, 'completed');
    });
  });

  test(`[${name}] TARGETS: one default per scope and tier, roots inside the base, platform-wide behind an unscoped grant, audited`, async () => {
    await withFixture(async ({ service, store, base, online, drain }) => {
      await drain();
      const admin = caller([
        { id: 'a', permissions: ['storage:admin'], scope: { channelIds: [CH] } },
      ]);
      await mkdir(join(base, 'ch12-online'), { recursive: true });
      const own = await service.createTarget(
        admin,
        {
          name: 'ch12 online',
          tier: 'online',
          kind: 'fs',
          root: join(base, 'ch12-online'),
          isDefault: true,
          enabled: true,
        },
        false,
      );
      assert.equal(own.channelId, CH);
      // The channel's own default wins for its placements; the platform's stays the platform's.
      assert.equal((await store.defaultTarget(CH, 'online'))!.id, own.id);
      assert.equal((await store.defaultTarget('ch99', 'online'))!.id, online.id);

      await mkdir(join(base, 'ch12-b'), { recursive: true });
      const next = await service.createTarget(
        admin,
        {
          name: 'ch12 b',
          tier: 'online',
          kind: 'fs',
          root: join(base, 'ch12-b'),
          isDefault: true,
          enabled: true,
        },
        false,
      );
      assert.equal((await store.defaultTarget(CH, 'online'))!.id, next.id);
      assert.equal((await store.target(own.id))!.isDefault, false, 'the previous default yields');

      await assert.rejects(
        service.createTarget(
          admin,
          {
            name: 'p',
            tier: 'online',
            kind: 'fs',
            root: join(base, 'x'),
            isDefault: false,
            enabled: true,
          },
          true,
        ),
        /unscoped storage:admin/,
      );
      await assert.rejects(
        service.createTarget(
          admin,
          {
            name: 'gone',
            tier: 'online',
            kind: 'fs',
            root: join(base, 'does-not-exist'),
            isDefault: false,
            enabled: true,
          },
          false,
        ),
        /not writable/,
      );
      await assert.rejects(
        service.updateTarget(admin, next.id, 1, {
          name: 'x',
          tier: 'near-line',
          kind: 'fs',
          root: next.root!,
          isDefault: false,
          enabled: true,
        }),
        /tier cannot change/,
      );
      await assert.rejects(
        service.updateTarget(admin, next.id, 7, {
          name: 'x',
          tier: 'online',
          kind: 'fs',
          root: next.root!,
          isDefault: true,
          enabled: true,
        }),
        /not at version 7/,
      );
      await assert.rejects(
        service.target(caller(undefined, 'ch99'), own.id),
        /not found|storage target/i,
      );
      await assert.rejects(
        service.targets(caller([{ id: 'r', permissions: ['asset:read'] }])),
        /storage:admin/,
      );

      const audits = (await drain())
        .filter((e) => e.type === 'audit.recorded')
        .map((e) => e.payload as unknown as EventPayloads['audit.recorded'])
        .filter((a) => a.entityType === 'storage-target');
      assert.deepEqual(
        audits.map((a) => a.action),
        ['storage-target.created', 'storage-target.updated', 'storage-target.created'],
      );
      assert.equal(JSON.stringify(audits).includes('secret'), false);
    });
  });

  test(`[${name}] LOCATION: asset:read on files, strictly, in the caller's channel`, async () => {
    await withFixture(async ({ service }) => {
      const input = placement();
      const { file } = await service.place(input, bytes('located'), () => true);
      const found = await service.location(caller(), input.assetId);
      assert.deepEqual(
        found.map((f) => f.file.id),
        [file.id],
      );
      assert.deepEqual(await service.location(caller(undefined, 'ch99'), input.assetId), []);
      await assert.rejects(
        service.location(
          caller([{ id: 'c', permissions: ['asset:read'], fieldGroups: ['core'] }]),
          input.assetId,
        ),
        /asset:read/,
      );
      await assert.rejects(
        service.location(
          caller([
            { id: 'cat', permissions: ['asset:read'], scope: { categoryPaths: ['/news/'] } },
          ]),
          input.assetId,
        ),
        /asset:read|category/,
      );
    });
  });
}
