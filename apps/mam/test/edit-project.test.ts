// EP-26.2 — the media editor's EditProject: a re-openable timeline over one asset's renditions.
// The store's round-trip and compare-and-set are the conformance suite's; here, what the SERVICE
// promises around them — a draft started over an asset, the timeline saved compare-and-set with a
// field-level audit delta, a re-sent timeline changing nothing, render issuing the command and
// moving the project to `rendering`, the `core` write group enforced, and the routes' status codes.

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
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import { buildMamApp, MamService, sqliteAssetStore, type Caller } from '../src/index.ts';

const CHANNEL = 'ch12';

const writeGroups = (groups: string[]): Rule[] => [
  { id: 'read', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } },
  {
    id: 'write',
    permissions: ['asset:write'],
    scope: { channelIds: [CHANNEL] },
    fieldGroups: groups,
  },
];
/** The Editor writes `core` — editing renditions is a core editorial act (like making a version). */
const EDITOR = writeGroups(['core', 'taxonomy', 'cast', 'shotlist']);
/** A Librarian writes `files` and `rights` — not `core`, so it cannot drive the editor. */
const LIBRARIAN = writeGroups(['files', 'rights']);
const READER: Rule[] = [
  { id: 'read', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } },
];

function harness() {
  const store = sqliteAssetStore();
  const broker = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), broker);
  const service = new MamService({ store });
  const caller = (rules: Rule[] = EDITOR): Caller => ({
    userId: 'user-1',
    channelId: CHANNEL,
    policy: compile({ subjectId: 'user-1', permVersion: 1, rules }),
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

const VIDEO = { title: 'Match', mediaType: 'video', fileType: 'mxf', durationSec: 90 };

/** Give an asset a file of `kind`, as MTS's `transcode.completed` would — a render cuts from it. */
async function withFile(service: MamService, assetId: string, kind: 'proxy' | 'original') {
  const envelope = buildEnvelope({
    type: 'transcode.completed',
    channelId: CHANNEL,
    payload: {
      assetId,
      jobId: ulid(),
      renditions: [
        {
          kind,
          path: `${CHANNEL}/${assetId}/${kind}/b1`,
          checksum: { algorithm: 'sha256', value: 'a'.repeat(64) },
        },
      ],
    },
  });
  await service.mirrorTranscode({ id: envelope.messageId, subject: 'x', body: envelope });
}
const clip = (ref: string, inSec: number, outSec: number) => ({ renditionRef: ref, inSec, outSec });

test('create starts a draft over the asset, deriving the media kind, and audits it', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), VIDEO);
  await drain();

  const project = await service.createEditProject(caller(), asset.id);
  assert.deepEqual(
    [
      project.state,
      project.mediaKind,
      project.sourceAssetId,
      project.version,
      project.timeline.clips,
    ],
    ['draft', 'video', asset.id, 1, []],
  );
  const sent = await drain();
  const audit = sent.find((e) => e.type === 'audit.recorded');
  assert.ok(validatePayload('audit.recorded', audit?.payload).valid);
  const payload = audit?.payload as unknown as EventPayloads['audit.recorded'];
  assert.deepEqual(
    [payload.entityType, payload.entityId, payload.action],
    ['edit-project', project.id, 'edit-project.created'],
  );
  // Re-loadable, and confined to its channel.
  assert.equal((await service.editProject(caller(), project.id)).id, project.id);
  await assert.rejects(
    service.editProject(caller(), 'EPnope'),
    (e: Error & { status?: number }) => e.status === 404,
  );
});

test('media that cannot be edited is refused', async () => {
  const { service, caller } = harness();
  const live = await service.create(caller(), { ...VIDEO, mediaType: 'live-event' });
  await assert.rejects(
    service.createEditProject(caller(), live.id),
    (e: Error & { status?: number }) => e.status === 422,
  );
});

test('save replaces the timeline compare-and-set, audits the delta, and a re-sent timeline is nothing', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), VIDEO);
  const project = await service.createEditProject(caller(), asset.id);
  await drain();

  const saved = await service.updateEditProject(caller(), project.id, project.version, {
    timeline: { clips: [clip('proxy', 10.5, 20), clip('proxy', 30, 42.25)] },
  });
  assert.deepEqual([saved.version, saved.timeline.clips.length], [2, 2]);
  const audit = (await drain()).find((e) => e.type === 'audit.recorded');
  const delta = (audit?.payload as unknown as EventPayloads['audit.recorded']).delta;
  assert.ok(delta['timeline'], 'the timeline change is in the delta');

  // The same timeline again on the current version changes nothing.
  const again = await service.updateEditProject(caller(), project.id, saved.version, {
    timeline: { clips: [clip('proxy', 10.5, 20), clip('proxy', 30, 42.25)] },
  });
  assert.equal(again.version, 2);
  assert.deepEqual(await drain(), [], 'a re-sent timeline emits nothing');

  // A stale base (the version already moved) is a 409.
  await assert.rejects(
    service.updateEditProject(caller(), project.id, project.version, { timeline: { clips: [] } }),
    (e: Error & { status?: number }) => e.status === 409,
  );
});

test('a clip is validated whole — every problem at its path', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), VIDEO);
  const project = await service.createEditProject(caller(), asset.id);
  await assert.rejects(
    service.updateEditProject(caller(), project.id, project.version, {
      timeline: {
        clips: [
          { renditionRef: '', inSec: 0, outSec: 1 },
          { renditionRef: 'p', inSec: 5, outSec: 3 },
          { renditionRef: 'p', inSec: 0, outSec: 1, colour: 'red' },
        ],
      },
    }),
    (err: Error & { details?: { problems?: { path: string }[] } }) => {
      assert.deepEqual(
        err.details?.problems?.map((p) => p.path),
        ['timeline/clips/0/renditionRef', 'timeline/clips/1/outSec', 'timeline/clips/2/colour'],
      );
      return true;
    },
  );
});

test('render issues editor.render.requested and moves the project to rendering', async () => {
  const { service, caller, drain } = harness();
  const asset = await service.create(caller(), VIDEO);
  await withFile(service, asset.id, 'proxy');
  const project = await service.createEditProject(caller(), asset.id);
  await service.updateEditProject(caller(), project.id, project.version, {
    timeline: { clips: [clip('proxy', 0, 12)] },
  });
  await drain();

  // No profile set and none given: refused.
  await assert.rejects(
    service.renderEditProject(caller(), project.id, {}),
    (e: Error & { status?: number }) => e.status === 422,
  );

  const rendering = await service.renderEditProject(caller(), project.id, {
    outputProfile: 'web-720',
  });
  assert.deepEqual(
    [rendering.state, rendering.outputProfile, rendering.version],
    ['rendering', 'web-720', 3],
  );
  const sent = await drain();
  const cmd = sent.find((e) => e.type === 'editor.render.requested');
  assert.ok(validatePayload('editor.render.requested', cmd?.payload).valid);
  const payload = cmd?.payload as unknown as EventPayloads['editor.render.requested'];
  assert.deepEqual(
    [payload.editProjectId, payload.outputProfile, payload.timeline.clips.length],
    [project.id, 'web-720', 1],
  );

  // While rendering, a save is refused (409); a fresh render is refused too (already in progress).
  await assert.rejects(
    service.updateEditProject(caller(), project.id, rendering.version, { timeline: { clips: [] } }),
    (e: Error & { status?: number }) => e.status === 409,
  );
});

test('an empty timeline cannot be rendered', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), VIDEO);
  const project = await service.createEditProject(caller(), asset.id);
  await assert.rejects(
    service.renderEditProject(caller(), project.id, { outputProfile: 'web-720' }),
    (e: Error & { status?: number }) => e.status === 422,
  );
});

test('editing is a `core` write: a reader and a Librarian are refused, a reader may still load', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), VIDEO);
  const project = await service.createEditProject(caller(), asset.id);

  for (const rules of [READER, LIBRARIAN]) {
    await assert.rejects(
      service.createEditProject(caller(rules), asset.id),
      (e: Error & { status?: number }) => e.status === 403,
    );
    await assert.rejects(
      service.updateEditProject(caller(rules), project.id, project.version, {
        timeline: { clips: [] },
      }),
      (e: Error & { status?: number }) => e.status === 403,
    );
  }
  assert.equal((await service.editProject(caller(READER), project.id)).id, project.id);
});

test('over HTTP: POST creates (201), GET loads, PATCH saves with ?version, POST render (202)', async () => {
  const { service, caller } = harness();
  const asset = await service.create(caller(), VIDEO);
  await withFile(service, asset.id, 'proxy');
  const app = await buildMamApp({ service, policyFor: () => caller().policy });
  const headers = { 'x-atlas-user': 'user-1', 'x-atlas-channel': CHANNEL };

  const created = await app.inject({
    method: 'POST',
    url: `/api/v1/assets/${asset.id}/edit-projects`,
    headers,
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json<{ id: string; version: number }>().id;

  const got = await app.inject({ method: 'GET', url: `/api/v1/edit-projects/${id}`, headers });
  assert.equal(got.statusCode, 200);

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/v1/edit-projects/${id}?version=1`,
    headers,
    payload: { timeline: { clips: [clip('proxy', 0, 8)] }, outputProfile: 'web-720' },
  });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.equal(patched.json<{ version: number }>().version, 2);

  const rendered = await app.inject({
    method: 'POST',
    url: `/api/v1/edit-projects/${id}/render`,
    headers,
    payload: {},
  });
  assert.equal(rendered.statusCode, 202, rendered.body);
  assert.equal(rendered.json<{ state: string }>().state, 'rendering');
  await app.close();
});
