// EP-26.6 / 26.7 / 26.8's backend — a render becomes an asset of its own (media-editor.md §5.1).
//
// MAM's half: the request mints the asset's id and refuses what would doom the render; the
// completion creates the asset in ONE transaction — standing alone with the source's metadata (and
// so its category scope), or as the target's next version, linked — and the project `rendered`; a
// failure fails the project, which a save returns to draft and a new render retries under a NEW id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEnvelope,
  ulid,
  validatePayload,
  type Envelope,
  type EventPayloads,
} from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay, type Message } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import { MamService, sqliteAssetStore, type Caller } from '../src/index.ts';

const CH = 'ch12';
const ALL: Rule[] = [
  {
    id: 'all',
    permissions: ['asset:read', 'asset:write', 'taxonomy:admin'],
    scope: { channelIds: [CH] },
  },
];

function harness() {
  const store = sqliteAssetStore();
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const service = new MamService({ store });
  const caller = (rules: Rule[] = ALL, userId = 'editor-1'): Caller => ({
    userId,
    channelId: CH,
    policy: compile({ subjectId: userId, permVersion: 1, rules }),
  });
  let seen = 0;
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    const fresh = broker.published.slice(seen).map((m) => m.body as Envelope);
    seen = broker.published.length;
    return fresh;
  };
  return { service, caller, drain };
}

function message<T extends keyof EventPayloads>(type: T, payload: EventPayloads[T]): Message {
  const envelope = buildEnvelope({ type, channelId: CH, payload });
  return { id: envelope.messageId, subject: `atlas.${CH}.${type}`, body: envelope };
}

const sha = { algorithm: 'sha256' as const, value: 'b'.repeat(64) };

/** The source: a video in a category, with a description, tags and an original to cut from. */
async function source(h: ReturnType<typeof harness>) {
  const category = await h.service.createCategory(h.caller(), {
    key: 'news',
    labels: { en: 'News' },
    kind: 'department',
  });
  const asset = await h.service.create(h.caller(), {
    title: 'Evening bulletin',
    description: 'The whole bulletin',
    mediaType: 'video',
    fileType: 'mxf',
    durationSec: 600,
    categoryId: category.id,
  });
  await h.service.setTags(h.caller(), asset.id, ['politics']);
  await h.service.mirrorTranscode(
    message('transcode.completed', {
      assetId: asset.id,
      jobId: ulid(),
      renditions: [{ kind: 'original', path: `${CH}/${asset.id}/original/b1`, checksum: sha }],
    }),
  );
  return h.service.get(h.caller(), asset.id);
}

async function projectOver(h: ReturnType<typeof harness>, assetId: string, ref = 'original') {
  const project = await h.service.createEditProject(h.caller(), assetId);
  return h.service.updateEditProject(h.caller(), project.id, project.version, {
    timeline: {
      clips: [
        { renditionRef: ref, inSec: 10, outSec: 40 },
        { renditionRef: ref, inSec: 100, outSec: 130 },
      ],
    },
    outputProfile: 'broadcast',
  });
}

/** MTS's answer to the render: the rendered asset's original. */
function completion(projectId: string, outputAssetId: string, jobId = ulid()): Message {
  return message('transcode.completed', {
    assetId: outputAssetId,
    jobId,
    editProjectId: projectId,
    renditions: [
      {
        kind: 'original',
        fileType: 'mxf',
        path: `${CH}/${outputAssetId}/original/b9`,
        checksum: sha,
        sizeBytes: 1234,
        durationSec: 60,
      },
    ],
  });
}

test('the render request mints the asset it becomes, and carries it in the command', async () => {
  const h = harness();
  const src = await source(h);
  const project = await projectOver(h, src.id);
  await h.drain();

  const rendering = await h.service.renderEditProject(h.caller(), project.id, {});
  assert.equal(rendering.state, 'rendering');
  assert.ok(rendering.outputAssetId, 'minted at the request');
  assert.equal(rendering.renderRequestedBy, 'editor-1');
  const cmd = (await h.drain()).find((e) => e.type === 'editor.render.requested')!;
  assert.ok(validatePayload('editor.render.requested', cmd.payload).valid);
  assert.equal(
    (cmd.payload as unknown as EventPayloads['editor.render.requested']).outputAssetId,
    rendering.outputAssetId,
  );
});

test('a render the source or the target dooms is refused at the request', async () => {
  const h = harness();
  const src = await source(h);
  const status = (n: number) => (e: Error & { status?: number }) => e.status === n;

  // The source has no proxy to cut from.
  const noProxy = await projectOver(h, src.id, 'proxy');
  await assert.rejects(h.service.renderEditProject(h.caller(), noProxy.id, {}), status(422));
  // A still is not something to cut from.
  const still = await projectOver(h, src.id, 'thumbnail');
  await assert.rejects(h.service.renderEditProject(h.caller(), still.id, {}), status(422));

  const project = await projectOver(h, src.id);
  // A target of another media type.
  const audio = await h.service.create(h.caller(), {
    title: 'Radio',
    mediaType: 'audio',
    fileType: 'wav',
  });
  await assert.rejects(
    h.service.renderEditProject(h.caller(), project.id, { targetAssetId: audio.id }),
    status(422),
  );
  // A target nobody has.
  await assert.rejects(
    h.service.renderEditProject(h.caller(), project.id, { targetAssetId: ulid() }),
    status(404),
  );
  // Two files on one timeline, and a transition, before EP-26.5.
  await h.service.updateEditProject(h.caller(), project.id, project.version, {
    timeline: {
      clips: [
        { renditionRef: 'original', inSec: 0, outSec: 1 },
        { renditionRef: 'proxy', inSec: 0, outSec: 1 },
      ],
    },
  });
  await assert.rejects(h.service.renderEditProject(h.caller(), project.id, {}), status(422));
  const again = await h.service.editProject(h.caller(), project.id);
  await h.service.updateEditProject(h.caller(), project.id, again.version, {
    timeline: { clips: [{ renditionRef: 'original', inSec: 0, outSec: 1, transitionIn: 'wipe' }] },
  });
  await assert.rejects(h.service.renderEditProject(h.caller(), project.id, {}), status(422));
});

test('standing alone: the render is a new asset with the source’s metadata and scope, the project rendered — once', async () => {
  const h = harness();
  const src = await source(h);
  const project = await projectOver(h, src.id);
  const rendering = await h.service.renderEditProject(h.caller(), project.id, {});
  await h.drain();

  const jobId = ulid();
  const msg = completion(project.id, rendering.outputAssetId!, jobId);
  assert.equal(await h.service.mirrorTranscode(msg), 'applied');
  assert.equal(await h.service.mirrorTranscode(msg), 'duplicate', 'the seen-mark');

  const made = await h.service.get(h.caller(), rendering.outputAssetId!);
  assert.deepEqual(
    [made.title, made.description, made.categoryId, made.mediaType, made.fileType, made.state],
    ['Evening bulletin (edit)', 'The whole bulletin', src.categoryId, 'video', 'mxf', 'created'],
  );
  assert.equal(made.durationSec, 60, 'the render’s own length, not the source’s');
  assert.equal(made.createdBy, 'editor-1', 'whoever rendered it');
  assert.equal(made.replacesId, undefined, 'not linked: no target was asked for');
  assert.deepEqual(
    (await h.service.tags(h.caller(), made.id)).map((t) => t.label),
    ['politics'],
  );
  const files = await h.service.files(h.caller(), made.id);
  assert.deepEqual(
    files.map((f) => [f.kind, f.storage.path]),
    [['original', `${CH}/${made.id}/original/b9`]],
  );

  const done = await h.service.editProject(h.caller(), project.id);
  assert.deepEqual([done.state, done.renderJobId], ['rendered', jobId]);

  const sent = await h.drain();
  assert.ok(sent.some((e) => e.type === 'asset.created' && e.payload['assetId'] === made.id));
  const audits = sent
    .filter((e) => e.type === 'audit.recorded')
    .map((e) => e.payload as unknown as EventPayloads['audit.recorded'])
    .map((a) => `${a.entityType}:${a.action}`);
  for (const expected of [
    'asset:asset.created',
    'file:transcode.completed',
    'edit-project:edit-project.rendered',
  ]) {
    assert.ok(audits.includes(expected), `${expected} in ${audits.join(', ')}`);
  }
});

test('as the next version: the render is linked into the target’s chain, with its metadata', async () => {
  const h = harness();
  const src = await source(h);
  const project = await projectOver(h, src.id);
  const rendering = await h.service.renderEditProject(h.caller(), project.id, {
    targetAssetId: src.id,
  });
  assert.equal(rendering.targetAssetId, src.id);
  await h.drain();

  assert.equal(
    await h.service.mirrorTranscode(completion(project.id, rendering.outputAssetId!)),
    'applied',
  );
  const made = await h.service.get(h.caller(), rendering.outputAssetId!);
  assert.equal(made.replacesId, src.id);
  assert.equal(made.title, 'Evening bulletin', 'a version keeps the title');
  assert.equal((await h.service.get(h.caller(), src.id)).replacedById, made.id);
  assert.deepEqual(
    (await h.service.versions(h.caller(), made.id)).map((a) => a.id),
    [src.id, made.id],
  );
  const replaced = (await h.drain()).find((e) => e.type === 'asset.replaced')!;
  assert.deepEqual(replaced.payload, { oldId: src.id, newId: made.id });
});

test('a target versioned while the render ran: the render still lands, standing alone, and says why', async () => {
  const h = harness();
  const src = await source(h);
  const project = await projectOver(h, src.id);
  const rendering = await h.service.renderEditProject(h.caller(), project.id, {
    targetAssetId: src.id,
  });
  // Someone else makes the next version first.
  const upload = await h.service.create(h.caller(), {
    title: 'Re-upload',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await h.service.createVersion(h.caller(), src.id, { assetId: upload.id });

  assert.equal(
    await h.service.mirrorTranscode(completion(project.id, rendering.outputAssetId!)),
    'applied',
  );
  const made = await h.service.get(h.caller(), rendering.outputAssetId!);
  assert.equal(made.replacesId, undefined);
  const done = await h.service.editProject(h.caller(), project.id);
  assert.equal(done.state, 'rendered');
  assert.match(done.versionRefused!, /already replaced/);
});

test('a failed render fails the project with MTS’s reason; a save returns it to draft, a new render mints a new id', async () => {
  const h = harness();
  const src = await source(h);
  const project = await projectOver(h, src.id);
  const first = await h.service.renderEditProject(h.caller(), project.id, {});

  // Not a render's failure: none of MAM's business.
  assert.equal(
    await h.service.renderFailed(
      message('transcode.failed', {
        assetId: src.id,
        error: { code: 'TRANSCODE_FAILED', message: 'x' },
      }),
    ),
    'skipped',
  );

  const failure = message('transcode.failed', {
    assetId: first.outputAssetId!,
    editProjectId: project.id,
    jobId: ulid(),
    error: { code: 'TRANSCODE_REFUSED', message: 'Invalid data found', retryable: false },
  });
  assert.equal(await h.service.renderFailed(failure), 'applied');
  assert.equal(await h.service.renderFailed(failure), 'duplicate');
  const failed = await h.service.editProject(h.caller(), project.id);
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.failure, { code: 'TRANSCODE_REFUSED', message: 'Invalid data found' });
  assert.equal(failed.timeline.clips.length, 2, 'the timeline is kept for the next attempt');

  // A render straight from `failed` is a new attempt, under a new id, with the failure cleared.
  const second = await h.service.renderEditProject(h.caller(), project.id, {});
  assert.notEqual(second.outputAssetId, first.outputAssetId);
  assert.equal(second.failure, undefined);

  // The FIRST render's late completion is not what the project waits for now: nothing is made.
  assert.equal(
    await h.service.mirrorTranscode(completion(project.id, first.outputAssetId!)),
    'duplicate',
  );
  await assert.rejects(
    h.service.get(h.caller(), first.outputAssetId!),
    (e: Error & { status?: number }) => e.status === 404,
  );
});
