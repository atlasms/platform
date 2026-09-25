// A behaviour suite every JobStore must pass — sqlite in tests, Postgres in production.
//
// Driven through MtsService with a real work directory and the fake encoder, because what has to
// hold on the store actually deployed are properties of the whole job: a lease that exactly one
// of two workers wins, a completion that commits the renditions with the event announcing them,
// a failure retried after its backoff and not before, a refusal dead-lettered at once, an
// interrupted job put back with its attempt returned, a dead worker's job swept back, and a
// redelivered command that creates nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildEnvelope,
  ulid,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import { InMemoryBroker, OutboxRelay, type Message, type OutboxStore } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import type { ProfileInput } from './profile.ts';
import { MtsService, type Caller } from './service.ts';
import type { JobStore } from './store.ts';
import { fakeTranscoder } from './transcoder-fake.ts';

export interface JobStoreHarness {
  /** A clean store, plus the outbox store the relay drains — both on the same database. */
  make: () => Promise<{ store: JobStore; outbox: OutboxStore; cleanup?: () => Promise<void> }>;
}

const CH = 'ch12';
const writer = (channelId: string) =>
  compile({
    subjectId: 'user-1',
    permVersion: 1,
    rules: [
      { id: 'r', permissions: ['asset:read', 'asset:write'], scope: { channelIds: [channelId] } },
    ],
  });
const caller: Caller = { userId: 'user-1', channelId: CH, policy: writer(CH) };

export function jobStoreConformance(name: string, harness: JobStoreHarness): void {
  async function withService(
    fn: (h: {
      service: MtsService;
      store: JobStore;
      root: string;
      input: (name: string) => Promise<string>;
      drain: () => Promise<Envelope[]>;
      clock: { now: number };
      transcoder: ReturnType<typeof fakeTranscoder>;
    }) => Promise<void>,
    options: { maxAttempts?: number; retryBaseMs?: number } = {},
  ): Promise<void> {
    const { store, outbox, cleanup } = await harness.make();
    const root = await mkdtemp(join(tmpdir(), 'mts-spec-'));
    const clock = { now: Date.parse('2026-09-24T12:00:00.000Z') };
    const transcoder = fakeTranscoder();
    const service = new MtsService({
      store,
      transcoder,
      workRoot: root,
      workerId: 'worker-a',
      maxAttempts: options.maxAttempts ?? 3,
      retryBaseMs: options.retryBaseMs ?? 60_000,
      now: () => new Date(clock.now),
    });
    const bus = new InMemoryBroker();
    const relay = new OutboxRelay(outbox, bus);
    let seen = 0;
    const drain = async (): Promise<Envelope[]> => {
      await relay.drain();
      const fresh = bus.published.slice(seen).map((m) => m.body as Envelope);
      seen = bus.published.length;
      return fresh;
    };
    const input = async (file: string): Promise<string> => {
      const path = join(root, 'inputs', file);
      await mkdir(join(root, 'inputs'), { recursive: true });
      await writeFile(path, `master ${file}`);
      return path;
    };
    try {
      await fn({ service, store, root, input, drain, clock, transcoder });
    } finally {
      await rm(root, { recursive: true, force: true });
      await cleanup?.();
    }
  }

  const types = (events: Envelope[]): string[] => events.map((e) => e.type);
  const audits = (events: Envelope[]): string[] =>
    events
      .filter((e) => e.type === 'audit.recorded')
      .map((e) => (e.payload as unknown as EventPayloads['audit.recorded']).action);

  test(`[${name}] enqueue: a queued row and its audit; what can never run is refused before it is written`, async () => {
    await withService(async ({ service, store, input, drain, root }) => {
      const path = await input('clip.mxf');
      const job = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy', 'thumbnail'],
        inputPath: path,
      });
      assert.equal(job.state, 'queued');
      assert.equal(job.attempts, 0);
      assert.equal(job.version, 1);
      assert.deepEqual((await store.job(job.id))?.presetIds, ['proxy', 'thumbnail']);
      assert.deepEqual(audits(await drain()), ['transcode.queued']);

      // Refused, and nothing written: an unknown preset, no presets, a path outside the root —
      // including the ones that only LOOK inside it.
      const refuse = async (
        input: Partial<Parameters<MtsService['enqueue']>[1]>,
        pattern: RegExp,
      ) =>
        assert.rejects(
          service.enqueue(caller, {
            assetId: ulid(),
            presetIds: ['proxy'],
            inputPath: path,
            ...input,
          }),
          pattern,
        );
      await refuse({ presetIds: ['proxy', 'hologram'] }, /unknown preset\(s\): hologram/);
      await refuse({ presetIds: [] }, /must not be empty/);
      await refuse({ inputPath: '../../etc/passwd' }, /inside the work root/);
      await refuse({ inputPath: join(root, '..', 'elsewhere.mxf') }, /inside the work root/);
      await refuse({ inputPath: `${root}-other/clip.mxf` }, /inside the work root/);
      await refuse({ inputPath: join(root, 'inputs', 'not-there.mxf') }, /does not exist/);
      await refuse({ inputPath: join(root, 'inputs') }, /does not exist/);
      assert.equal((await store.jobs({ channelId: CH })).length, 1);
      assert.deepEqual(await drain(), []);
    });
  });

  test(`[${name}] a run: every preset produced and checksummed, the job completed, started then completed announced`, async () => {
    await withService(async ({ service, store, input, drain }) => {
      const assetId = ulid();
      const job = await service.enqueue(caller, {
        assetId,
        presetIds: ['proxy', 'thumbnail'],
        inputPath: await input('clip.mxf'),
      });
      await drain();

      assert.equal(await service.runNext(), 'completed');
      const done = (await store.job(job.id))!;
      assert.equal(done.state, 'completed');
      assert.equal(done.attempts, 1);
      assert.equal(done.percent, 100);
      assert.equal(done.workerId, 'worker-a');
      assert.equal(done.renditions?.length, 2);

      // Each rendition is its own file, and its checksum is of THOSE bytes.
      const [proxy, thumbnail] = done.renditions!;
      assert.equal(proxy?.kind, 'proxy');
      assert.equal(thumbnail?.kind, 'thumbnail');
      assert.notEqual(proxy?.path, thumbnail?.path);
      for (const r of done.renditions!) {
        const bytes = await readFile(r.path);
        assert.equal(r.checksum.algorithm, 'sha256');
        assert.equal(r.checksum.value, createHash('sha256').update(bytes).digest('hex'));
        assert.equal(r.sizeBytes, bytes.length);
      }
      // A still has no duration; a proxy has one.
      assert.equal(thumbnail?.durationSec, undefined);
      assert.equal(proxy?.durationSec, 12.5);

      const events = await drain();
      assert.deepEqual(
        types(events).filter((t) => t !== 'audit.recorded'),
        ['transcode.started', 'transcode.completed'],
      );
      assert.deepEqual(audits(events), ['transcode.started', 'transcode.completed']);
      const completed = events.find((e) => e.type === 'transcode.completed')!;
      assert.ok(validatePayload('transcode.completed', completed.payload).valid);
      const payload = completed.payload as unknown as EventPayloads['transcode.completed'];
      assert.equal(payload.assetId, assetId);
      assert.equal(payload.jobId, job.id);
      // What MAM's FileRef mirror reads: no presetId on the wire, the checksum as computed.
      assert.deepEqual(
        payload.renditions.map((r) => r.kind),
        ['proxy', 'thumbnail'],
      );
      assert.equal(payload.renditions[0]?.checksum.value, proxy?.checksum.value);
      assert.ok(!('presetId' in (payload.renditions[0] ?? {})));
      assert.equal(completed.channelId, CH);

      assert.equal(await service.runNext(), 'idle', 'the queue is drained');
    });
  });

  test(`[${name}] LEASE: two workers read the same queued job and exactly one runs it`, async () => {
    await withService(async ({ service, store, input }) => {
      const job = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['audio-proxy'],
        inputPath: await input('a.wav'),
      });
      const outcomes = await Promise.all([service.runNext(), service.runNext()]);
      assert.deepEqual(outcomes.sort(), ['completed', 'idle']);
      assert.equal((await store.job(job.id))?.attempts, 1, 'one attempt, not two');
    });
  });

  test(`[${name}] priority first, then age`, async () => {
    await withService(async ({ service, store, input, clock }) => {
      const path = await input('p.mxf');
      const old = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy'],
        inputPath: path,
      });
      clock.now += 1_000;
      const urgent = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy'],
        inputPath: path,
        priority: 10,
      });
      clock.now += 1_000;
      const young = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy'],
        inputPath: path,
      });
      const order: string[] = [];
      for (let i = 0; i < 3; i++) {
        await service.runNext();
        for (const id of [old.id, urgent.id, young.id]) {
          if ((await store.job(id))?.state === 'completed' && !order.includes(id)) order.push(id);
        }
      }
      assert.deepEqual(order, [urgent.id, old.id, young.id]);
    });
  });

  test(`[${name}] a REFUSAL of the input is dead-lettered at once — no retry makes bad bytes good`, async () => {
    await withService(async ({ service, store, input, drain }) => {
      const job = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy'],
        inputPath: await input('unreadable.mxf'),
      });
      await drain();
      assert.equal(await service.runNext(), 'dead-letter');
      const dead = (await store.job(job.id))!;
      assert.equal(dead.state, 'dead-letter');
      assert.equal(dead.attempts, 1);
      assert.match(dead.reason ?? '', /Invalid data/);
      const events = await drain();
      const failed = events.find((e) => e.type === 'transcode.failed');
      assert.ok(failed, 'the platform is told it gave up');
      assert.ok(validatePayload('transcode.failed', failed.payload).valid);
      const payload = failed.payload as unknown as EventPayloads['transcode.failed'];
      assert.equal(payload.error.code, 'TRANSCODE_REFUSED');
      assert.equal(payload.attempts, 1);
      assert.equal(await service.runNext(), 'idle');
    });
  });

  test(`[${name}] a TOOL failure is retried after its backoff, not before, and dead-lettered when attempts run out`, async () => {
    await withService(
      async ({ service, store, input, drain, clock }) => {
        const job = await service.enqueue(caller, {
          assetId: ulid(),
          presetIds: ['proxy'],
          inputPath: await input('toolfail.mxf'),
        });
        await drain();

        assert.equal(await service.runNext(), 'failed');
        const first = (await store.job(job.id))!;
        assert.equal(first.state, 'failed');
        assert.equal(first.attempts, 1);
        assert.match(first.reason ?? '', /ENOENT/);
        assert.equal(first.retryAt, new Date(clock.now + 60_000).toISOString(), 'base delay');
        // No `transcode.failed` for an attempt: a notification per retry is a pager that is muted.
        assert.deepEqual(
          types(await drain()).filter((t) => t !== 'audit.recorded'),
          ['transcode.started'],
        );

        assert.equal(await service.runNext(), 'idle', 'not before its backoff');
        clock.now += 60_000;
        assert.equal(await service.runNext(), 'failed', 'leased again once it has passed');
        const second = (await store.job(job.id))!;
        assert.equal(second.attempts, 2);
        assert.equal(second.retryAt, new Date(clock.now + 120_000).toISOString(), 'doubled');

        clock.now += 120_000;
        assert.equal(await service.runNext(), 'dead-letter', 'the third attempt is the last');
        const dead = (await store.job(job.id))!;
        assert.equal(dead.state, 'dead-letter');
        assert.equal(dead.attempts, 3);
        const failed = (await drain()).find((e) => e.type === 'transcode.failed');
        assert.equal(
          (failed?.payload as unknown as EventPayloads['transcode.failed']).error.code,
          'TRANSCODE_FAILED',
        );
      },
      { maxAttempts: 3, retryBaseMs: 60_000 },
    );
  });

  test(`[${name}] a DRAIN mid-job puts it back with its attempt returned — a rollout is not a failure`, async () => {
    await withService(async ({ service, store, input, drain }) => {
      const job = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy'],
        inputPath: await input('slow.mxf'),
      });
      const draining = new AbortController();
      const run = service.runNext(draining.signal);
      // Let the lease commit and the encoder start before pulling the plug.
      for (let i = 0; i < 50 && (await store.job(job.id))?.state !== 'running'; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      draining.abort();
      assert.equal(await run, 'cancelled');
      const back = (await store.job(job.id))!;
      assert.equal(back.state, 'queued');
      assert.equal(back.attempts, 0, 'the interrupted attempt is not charged');
      assert.ok(audits(await drain()).includes('transcode.requeued'));
    });
  });

  test(`[${name}] the SWEEP takes back a job whose worker never returned, and only that one`, async () => {
    await withService(async ({ service, store, input, clock }) => {
      const path = await input('a.mxf');
      const orphan = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy'],
        inputPath: path,
      });
      // A worker leased it and died: `running`, and nothing has written it since.
      await store.transaction((tx) =>
        tx.putJob(
          {
            ...orphan,
            state: 'running',
            attempts: 1,
            updatedAt: new Date(clock.now).toISOString(),
          },
          'queued',
        ),
      );
      clock.now += 60_000;
      assert.equal(await service.sweepStale(5 * 60_000), 0, 'a minute is not a dead worker');
      clock.now += 5 * 60_000;
      assert.equal(await service.sweepStale(5 * 60_000), 1);
      const back = (await store.job(orphan.id))!;
      assert.equal(back.state, 'queued');
      assert.equal(back.attempts, 0);
      assert.equal(back.reason, 'worker did not return');
    });
  });

  test(`[${name}] CAUSATION (EP-03.5): a command's chain reaches every event the job causes, the worker's included`, async () => {
    await withService(async ({ service, store, input, drain }) => {
      const path = await input('chain.mxf');
      const command = (correlationId?: string): Message => {
        const envelope = buildEnvelope({
          type: 'transcode.job.create',
          channelId: CH,
          payload: { assetId: ulid(), presetIds: ['proxy'], inputPath: path },
          actor: { kind: 'service', id: 'bms' },
          ...(correlationId !== undefined ? { correlationId } : {}),
        });
        return {
          id: envelope.messageId,
          subject: `atlas.${CH}.transcode.job.create`,
          body: envelope,
        };
      };

      // A command carrying a chain: every envelope continues it, and names the command as cause —
      // including started/completed and their audits, which the WORKER emits minutes later with
      // no message in hand. That is why the chain is kept on the row.
      const chain = ulid();
      const msg = command(chain);
      await service.consumeJobCreate(msg);
      const [job] = await store.jobs({ channelId: CH });
      assert.equal(job?.correlationId, chain);
      assert.equal(job?.causationId, msg.id);
      assert.equal(await service.runNext(), 'completed');
      const events = await drain();
      assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), [
        'audit.recorded',
        'transcode.completed',
        'transcode.started',
      ]);
      for (const e of events) {
        assert.equal(e.correlationId, chain, `${e.type} continues the chain`);
        assert.equal(e.causationId, msg.id, `${e.type} names the command as its cause`);
      }

      // A command carrying none: the chain STARTS at the command (follow()'s rule), so the
      // command and everything after it are still one query.
      const bare = command();
      await service.consumeJobCreate(bare);
      const queued = (await drain()).find((e) => e.type === 'audit.recorded')!;
      assert.equal(queued.correlationId, bare.id);
      assert.equal(queued.causationId, bare.id);

      // A request: its correlation rides on the job to completion; no message caused it.
      const requestChain = ulid();
      const requested = await service.enqueue(
        { ...caller, correlationId: requestChain },
        { assetId: ulid(), presetIds: ['proxy'], inputPath: path },
      );
      assert.equal((await store.job(requested.id))?.correlationId, requestChain);
      await drain();
      while ((await service.runNext()) !== 'idle');
      const done = (await drain()).filter((e) => e.correlationId === requestChain);
      assert.ok(done.some((e) => e.type === 'transcode.completed'));
      assert.ok(done.every((e) => e.causationId === undefined));
    });
  });

  test(`[${name}] transcode.job.create: queued once, a redelivery is a duplicate, and a bad command is refused`, async () => {
    await withService(async ({ service, store, input, drain, root }) => {
      const path = await input('from-bms.mxf');
      const command = (payload: Record<string, unknown>, channelId = CH): Message => {
        const envelope = buildEnvelope({
          type: 'transcode.job.create',
          channelId,
          payload,
          actor: { kind: 'service', id: 'bms' },
        });
        return {
          id: envelope.messageId,
          subject: `atlas.${channelId}.transcode.job.create`,
          body: envelope,
        };
      };
      const msg = command({ assetId: ulid(), presetIds: ['proxy'], inputPath: path, priority: 5 });
      assert.equal(await service.consumeJobCreate(msg), 'applied');
      assert.equal(await service.consumeJobCreate(msg), 'duplicate');
      const jobs = await store.jobs({ channelId: CH });
      assert.equal(jobs.length, 1, 'one job, however often it is delivered');
      assert.equal(jobs[0]?.priority, 5);
      assert.equal(jobs[0]?.createdBy, 'bms');
      assert.deepEqual(audits(await drain()), ['transcode.queued']);

      await assert.rejects(
        service.consumeJobCreate(command({ assetId: ulid(), presetIds: ['proxy'] })),
        /inputPath is required/,
      );
      await assert.rejects(
        service.consumeJobCreate(
          command({ assetId: ulid(), presetIds: ['nope'], inputPath: path }),
        ),
        /unknown preset/,
      );
      await assert.rejects(
        service.consumeJobCreate(
          command({ assetId: ulid(), presetIds: ['proxy'], inputPath: join(root, '..', 'x') }),
        ),
        /inside the work root/,
      );
      await assert.rejects(
        service.consumeJobCreate({ id: ulid(), subject: 's', body: { not: 'an envelope' } }),
        /not an envelope/,
      );
      assert.equal((await store.jobs({ channelId: CH })).length, 1);
    });
  });

  test(`[${name}] AUTHORIZATION: asset:write on the files group to enqueue, asset:read to look; strict, so a narrower grant is refused`, async () => {
    await withService(async ({ service, store, input }) => {
      const path = await input('clip.mxf');
      const as = (rules: Rule[]): Caller => ({
        userId: 'u',
        channelId: CH,
        policy: compile({ subjectId: 'u', permVersion: 1, rules }),
      });
      const enqueue = (c: Caller) =>
        service.enqueue(c, { assetId: ulid(), presetIds: ['proxy'], inputPath: path });

      // A reader cannot enqueue; nor can a writer of ANOTHER channel.
      const reader = as([{ id: 'r', permissions: ['asset:read'] }]);
      await assert.rejects(enqueue(reader), { status: 403 });
      await assert.rejects(
        enqueue(as([{ id: 'r', permissions: ['asset:write'], scope: { channelIds: ['ch99'] } }])),
        { status: 403 },
      );
      // A writer narrowed to the CORE fields is not a writer of files: renditions are the
      // Librarian's half, and the Editor's grant does not reach them.
      await assert.rejects(
        enqueue(as([{ id: 'r', permissions: ['asset:write'], fieldGroups: ['core'] }])),
        { status: 403 },
      );
      // A writer narrowed to a CATEGORY is refused too: MTS does not know the asset's category,
      // and strict evaluation denies a predicate it cannot check rather than widening the grant.
      await assert.rejects(
        enqueue(
          as([{ id: 'r', permissions: ['asset:write'], scope: { categoryPaths: ['/news/'] } }]),
        ),
        { status: 403 },
      );
      // No policy at all is not an empty one.
      await assert.rejects(enqueue({ userId: 'u', channelId: CH }), { status: 403 });
      assert.deepEqual(await store.jobs({ channelId: CH }), [], 'nothing was written');

      // A Librarian's grant — files only — is exactly enough.
      const librarian = as([{ id: 'r', permissions: ['asset:write'], fieldGroups: ['files'] }]);
      const job = await enqueue(librarian);
      // …and reading needs asset:read, which that grant does not carry.
      await assert.rejects(service.get(librarian, job.id), { status: 403 });
      assert.equal((await service.get(reader, job.id)).id, job.id);
    });
  });

  // --- the profile registry (EP-16.6) -----------------------------------------------------------

  const as = (rules: Rule[], channelId = CH): Caller => ({
    userId: 'admin-1',
    channelId,
    policy: compile({ subjectId: 'admin-1', permVersion: 1, rules }),
  });
  /** config:admin in ch12 only — a channel administrator. */
  const channelAdmin = as([
    {
      id: 'c',
      permissions: ['config:admin', 'asset:read', 'asset:write'],
      scope: { channelIds: [CH] },
    },
  ]);
  /** config:admin with no scope — a deployment administrator. */
  const platformAdmin = as([
    { id: 'p', permissions: ['config:admin', 'asset:read', 'asset:write'] },
  ]);
  const houseBroadcast = (over: Partial<ProfileInput> = {}): ProfileInput => ({
    id: 'broadcast',
    name: 'House broadcast 1080i25',
    kind: 'broadcast',
    container: 'mxf',
    video: {
      codec: 'mpeg2',
      width: 1920,
      height: 1080,
      bitrateMbps: 50,
      chroma: '422',
      frameRate: '25',
      scan: 'tff',
    },
    audio: { codec: 'pcm_s24le', sampleRate: 48000 },
    enabled: true,
    ...over,
  });

  test(`[${name}] PROFILES: a channel administrator writes its channel's registry; the platform's needs an unscoped grant; each write is audited`, async () => {
    await withService(async ({ service, store, drain }) => {
      const created = await service.createProfile(channelAdmin, houseBroadcast());
      assert.equal(created.channelId, CH);
      assert.equal(created.version, 1);
      assert.equal((await store.profile('broadcast', CH))?.name, 'House broadcast 1080i25');
      const audit = (await drain()).find((e) => e.type === 'audit.recorded')!;
      const payload = audit.payload as unknown as EventPayloads['audit.recorded'];
      assert.equal(payload.entityType, 'transcode-profile');
      assert.equal(payload.entityId, 'broadcast');
      assert.equal(payload.action, 'transcode-profile.created');

      // The same (scope, id) twice is a conflict, not an overwrite.
      await assert.rejects(service.createProfile(channelAdmin, houseBroadcast()), { status: 409 });
      // Platform-wide needs an UNSCOPED config:admin; a channel's grant cannot reach it.
      await assert.rejects(
        service.createProfile(channelAdmin, houseBroadcast({ channelId: null })),
        { status: 403 },
      );
      const platform = await service.createProfile(
        platformAdmin,
        houseBroadcast({ channelId: null, name: 'Platform broadcast' }),
      );
      assert.equal(platform.channelId, undefined);
      assert.equal((await store.profile('broadcast', null))?.name, 'Platform broadcast');
      assert.equal(
        ((await drain()).find((e) => e.type === 'audit.recorded')!.payload as { entityId: string })
          .entityId,
        'platform:broadcast',
        'the scope is part of the identity',
      );
      // Another channel's registry is not a channel admin's to write.
      await assert.rejects(
        service.createProfile(channelAdmin, houseBroadcast({ id: 'x', channelId: 'ch99' })),
        { status: 403 },
      );
      // A combination FFmpeg would refuse is a 422 naming the rule, and nothing is written.
      await assert.rejects(
        service.createProfile(channelAdmin, houseBroadcast({ id: 'bad', container: 'mp4' })),
        /mp4 carries h264/,
      );
      assert.equal(await store.profile('bad', CH), undefined);
      // Without config grants: neither read nor write.
      await assert.rejects(service.listProfiles(caller), { status: 403 });
      await assert.rejects(service.createProfile(caller, houseBroadcast({ id: 'y' })), {
        status: 403,
      });
      // A reader with config:read sees the channel's and the platform's.
      const reader = as([{ id: 'r', permissions: ['config:read'], scope: { channelIds: [CH] } }]);
      const listed = await service.listProfiles(reader);
      assert.deepEqual(listed.map((p) => `${p.channelId ?? 'platform'}/${p.id}`).sort(), [
        'ch12/broadcast',
        'platform/broadcast',
      ]);
      assert.deepEqual(
        await service
          .listProfiles(as([{ id: 'r', permissions: ['config:read'] }], 'ch99'))
          .then((l) => l.map((p) => p.channelId ?? 'platform')),
        ['platform'],
      );
    });
  });

  test(`[${name}] PROFILES: a replace is a compare-and-set on version — a stale write is 409, not a silent overwrite`, async () => {
    await withService(async ({ service, store }) => {
      await service.createProfile(channelAdmin, houseBroadcast());
      const replaced = await service.replaceProfile(channelAdmin, 'broadcast', {
        ...houseBroadcast({ name: 'House broadcast v2' }),
        version: 1,
      });
      assert.equal(replaced.version, 2);
      assert.equal(replaced.createdBy, 'admin-1');
      // Another administrator still holding version 1.
      await assert.rejects(
        service.replaceProfile(channelAdmin, 'broadcast', {
          ...houseBroadcast({ name: 'Stale' }),
          version: 1,
        }),
        { status: 409 },
      );
      assert.equal((await store.profile('broadcast', CH))?.name, 'House broadcast v2');
      await assert.rejects(
        service.replaceProfile(channelAdmin, 'broadcast', {
          ...houseBroadcast({ id: 'other' }),
          version: 2,
        }),
        /must match the path/,
      );
      await assert.rejects(
        service.replaceProfile(channelAdmin, 'nope', {
          ...houseBroadcast({ id: 'nope' }),
          version: 1,
        }),
        { status: 404 },
      );
    });
  });

  test(`[${name}] RESOLUTION: the channel's profile, then the platform's, then the built-in — and a disabled one is skipped`, async () => {
    await withService(async ({ service }) => {
      const b = () => service.resolvePreset(CH, 'broadcast');
      assert.equal((await b())?.args.includes('fps=25'), false, 'the built-in: no conform');

      await service.createProfile(
        platformAdmin,
        houseBroadcast({
          channelId: null,
          video: { codec: 'mpeg2', width: 1920, height: 1080, bitrateMbps: 50, frameRate: '29.97' },
        }),
      );
      assert.match((await b())!.args.join(' '), /fps=30000\/1001/, 'the platform redefines it');

      await service.createProfile(channelAdmin, houseBroadcast());
      assert.match(
        (await b())!.args.join(' '),
        /fps=25,setfield=tff/,
        'the channel redefines it again',
      );
      // Another channel still sees the platform's.
      assert.match((await service.resolvePreset('ch99', 'broadcast'))!.args.join(' '), /fps=30000/);

      // Disabling the channel's override puts the channel back on the platform's — "retire my override".
      await service.replaceProfile(channelAdmin, 'broadcast', {
        ...houseBroadcast({ enabled: false }),
        version: 1,
      });
      assert.match((await b())!.args.join(' '), /fps=30000/);
    });
  });

  test(`[${name}] RESOLUTION at enqueue and at run: a custom profile is a preset id; disabled, it is unknown; a GPU it cannot have falls back and says so`, async () => {
    await withService(async ({ service, store, input, drain }) => {
      await service.createProfile(channelAdmin, {
        id: 'fast-proxy',
        name: 'Fast proxy',
        kind: 'proxy',
        container: 'mp4',
        video: { codec: 'h264', width: 640, height: 360, quality: 28, gpu: 'nvenc' },
        audio: { codec: 'aac', bitrateKbps: 96 },
        enabled: true,
      });
      const path = await input('clip.mxf');
      const job = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['fast-proxy'],
        inputPath: path,
      });
      await drain();
      assert.equal(await service.runNext(), 'completed');
      const done = (await store.job(job.id))!;
      const r = done.renditions![0]!;
      assert.equal(r.presetId, 'fast-proxy');
      assert.equal(r.kind, 'proxy');
      assert.equal(r.encoder, 'libx264', 'no GPU on this node');
      assert.equal(r.fallback, true, 'and the rendition says so');
      // The wire rendition is the closed common schema: what only MTS knows stays on the job.
      const completed = (await drain()).find((e) => e.type === 'transcode.completed')!;
      assert.ok(validatePayload('transcode.completed', completed.payload).valid);
      assert.ok(!('encoder' in (completed.payload as { renditions: object[] }).renditions[0]!));

      // Disabled, a custom id with nothing beneath it is unknown to a new job.
      await service.replaceProfile(channelAdmin, 'fast-proxy', {
        id: 'fast-proxy',
        name: 'Fast proxy',
        kind: 'proxy',
        container: 'mp4',
        video: { codec: 'h264', width: 640, height: 360, quality: 28, gpu: 'nvenc' },
        audio: { codec: 'aac', bitrateKbps: 96 },
        enabled: false,
        version: 1,
      });
      await assert.rejects(
        service.enqueue(caller, { assetId: ulid(), presetIds: ['fast-proxy'], inputPath: path }),
        /unknown preset\(s\): fast-proxy/,
      );
    });
  });

  test(`[${name}] reads are channel-scoped: another channel's job is NOT FOUND, and not listed`, async () => {
    await withService(async ({ service, input }) => {
      const job = await service.enqueue(caller, {
        assetId: ulid(),
        presetIds: ['proxy'],
        inputPath: await input('mine.mxf'),
      });
      assert.equal((await service.get(caller, job.id)).id, job.id);
      const other: Caller = { userId: 'u2', channelId: 'ch99', policy: writer('ch99') };
      await assert.rejects(service.get(other, job.id), /no job/);
      assert.deepEqual(await service.list(other), []);
      assert.equal((await service.list(caller, { assetId: job.assetId })).length, 1);
      assert.deepEqual(await service.list(caller, { assetId: ulid() }), []);
    });
  });
}
