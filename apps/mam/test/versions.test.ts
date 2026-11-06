// EP-27.6 — the version chain (FR-MAM-6, FR-APP-3, mam.md §13t). The new media arrives as an asset
// of its own; making it the NEXT VERSION copies the old asset's metadata onto it by versions.ts's
// rule and links the two. Here, the rule — and what the service builds on it: one transaction for
// both records, their audits and `asset.replaced`; a linear chain; a superseded asset taking no
// verdict; the chain read; and who may do it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, ulid, validatePayload, type Envelope } from '@atlas/contracts';
import { SqliteOutboxStore } from '@atlas/data';
import { InMemoryBroker, OutboxRelay } from '@atlas/messaging';
import { compile, type Rule } from '@atlas/policy';
import { MamService, sqliteAssetStore, type Asset, type Caller } from '../src/index.ts';
import { userWrote } from '../src/provenance.ts';
import { cloneOnto, mergeExtended, mergeTagLabels, versionProblem } from '../src/versions.ts';

const CHANNEL = 'ch12';
const AT = '2026-11-06T12:00:00.000Z';
const RIM = { source: 'technical', by: 'rim', at: AT } as const;

const old: Asset = {
  id: ulid(),
  channelId: CHANNEL,
  title: 'Evening News',
  description: 'The six o’clock bulletin',
  episodeNo: 12,
  mediaType: 'video',
  fileType: 'mxf',
  durationSec: 1800,
  state: 'approved',
  expiresAt: '2027-01-01T00:00:00.000Z',
  approvedBy: 'user-9',
  version: 6,
  hasRenditions: true,
  createdBy: 'user-1',
  createdAt: AT,
  updatedAt: AT,
  provenance: { title: { source: 'user', by: 'user-1', at: AT } },
};
const fresh: Asset = {
  id: ulid(),
  channelId: CHANNEL,
  title: 'evening_news_fixed.mov',
  mediaType: 'video',
  fileType: 'mov',
  durationSec: 1795,
  state: 'processing',
  version: 2,
  hasRenditions: true,
  createdBy: 'user-2',
  createdAt: AT,
  updatedAt: AT,
  provenance: { title: RIM, mediaType: RIM, fileType: RIM, durationSec: RIM },
  derived: { title: { value: 'Evening News (AI)', source: 'ai', by: 'ai', at: AT } },
};

test('the rule: the old metadata is copied over what the file said, never over a person’s word or the new media’s own measurements', () => {
  const { asset, cloned } = cloneOnto(old, fresh);
  assert.deepEqual(cloned.sort(), ['description', 'episodeNo', 'title']);
  assert.equal(asset.title, 'Evening News', 'a file name gives way to the title a person gave');
  assert.deepEqual(asset.provenance?.['title'], old.provenance?.['title'], 'with its provenance');
  assert.equal(asset.derived, undefined, 'a value held beside the field is settled by the copy');
  assert.equal(asset.description, old.description);
  assert.equal(asset.provenance?.['description'], undefined, 'no provenance there: a person’s');
  assert.deepEqual(
    [asset.fileType, asset.durationSec, asset.state, asset.replacesId],
    ['mov', 1795, 'processing', old.id],
    'the new media’s own facts, its own lifecycle, and the link',
  );
  assert.equal(
    asset.expiresAt,
    undefined,
    'the approval is not copied — the new media is reviewed',
  );
  assert.equal(asset.approvedBy, undefined);

  const typed = userWrote({ ...fresh, episodeNo: 13 }, ['episodeNo'], 'user-2', AT);
  assert.equal(cloneOnto(old, typed).asset.episodeNo, 13, 'set on the new media by a person: kept');

  assert.deepEqual(mergeExtended({ a: 1, b: 2 }, { b: 3 }), {
    merged: { a: 1, b: 3 },
    cloned: ['a'],
  });
  const tags = mergeTagLabels(
    [
      { label: 'News', normalized: 'news' },
      { label: 'Evening', normalized: 'evening' },
    ],
    [{ label: 'NEWS', normalized: 'news' }],
  );
  assert.deepEqual(
    tags.labels.map((t) => t.label),
    ['NEWS', 'Evening'],
  );
  assert.equal(tags.added, true);
});

test('the rule: one chain, one direction, one media type, and the new version not yet judged', () => {
  assert.equal(versionProblem(old, fresh), undefined);
  assert.equal(versionProblem(old, old)?.status, 422);
  assert.equal(versionProblem({ ...old, replacedById: ulid() }, fresh)?.status, 409);
  assert.equal(versionProblem(old, { ...fresh, replacesId: ulid() })?.status, 409);
  assert.equal(versionProblem(old, { ...fresh, replacedById: ulid() })?.status, 409);
  assert.equal(versionProblem(old, { ...fresh, mediaType: 'audio' })?.status, 422);
  for (const state of ['approved', 'rejected', 'expired'] as const) {
    assert.equal(versionProblem(old, { ...fresh, state })?.status, 409, state);
  }
});

// --- the service ------------------------------------------------------------------------------

const EDITOR: Rule[] = [
  { id: 'read', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } },
  {
    id: 'write',
    permissions: ['asset:write'],
    scope: { channelIds: [CHANNEL] },
    fieldGroups: ['core', 'taxonomy', 'cast', 'shotlist'],
  },
];
const LIBRARIAN: Rule[] = [
  { id: 'read', permissions: ['asset:read'], scope: { channelIds: [CHANNEL] } },
  {
    id: 'write',
    permissions: ['asset:write'],
    scope: { channelIds: [CHANNEL] },
    fieldGroups: ['files', 'rights'],
  },
];
const APPROVER: Rule[] = [
  { id: 'r', permissions: ['asset:read', 'asset:approve'], scope: { channelIds: [CHANNEL] } },
];

function harness() {
  const store = sqliteAssetStore();
  const bus = new InMemoryBroker();
  const relay = new OutboxRelay(new SqliteOutboxStore(store.db), bus);
  const service = new MamService({ store, now: () => new Date(AT) });
  const caller = (rules: Rule[] = EDITOR, userId = 'user-1', channelId = CHANNEL): Caller => ({
    userId,
    channelId,
    policy: compile({ subjectId: userId, permVersion: 1, rules }),
  });
  let seen = 0;
  const drain = async (): Promise<Envelope[]> => {
    await relay.drain();
    const out = bus.published.slice(seen).map((m) => m.body as Envelope);
    seen = bus.published.length;
    return out;
  };
  /** An asset as an upload arrives: from RIM, the file's name for a title. */
  const ingest = async (filename: string, mediaType = 'video'): Promise<string> => {
    const assetId = ulid();
    const envelope = buildEnvelope({
      type: 'ingest.accepted',
      channelId: CHANNEL,
      payload: {
        assetId,
        ingestJobId: assetId,
        source: 'upload',
        path: `${CHANNEL}/${assetId}/original/b1`,
        checksum: { algorithm: 'sha256', value: 'abc' },
        filename,
        title: filename,
        mediaType,
        fileType: 'mov',
        createdBy: 'user-2',
        technicalMetadata: { durationSec: 1795 },
      },
      actor: { kind: 'service', id: 'rim' },
    });
    await service.createFromIngest({
      id: envelope.messageId,
      subject: `atlas.${CHANNEL}.ingest.accepted`,
      body: envelope,
    });
    return assetId;
  };
  return { store, service, caller, drain, ingest };
}

const status = (code: number) => (err: Error & { status?: number }) => err.status === code;

test('making a version: the metadata copied, the two linked, both audited, asset.replaced — one transaction', async () => {
  const { service, caller, drain, ingest } = harness();
  const a = await service.create(caller(), {
    title: 'Evening News',
    description: 'The six o’clock bulletin',
    mediaType: 'video',
    fileType: 'mxf',
    episodeNo: 12,
  });
  await service.setTags(caller(), a.id, ['News', 'Evening']);
  const b = await ingest('evening_news_fixed.mov');
  await drain();

  const made = await service.createVersion(caller(), a.id, { assetId: b });
  assert.equal(made.id, b);
  assert.deepEqual(
    [made.title, made.description, made.episodeNo, made.durationSec, made.replacesId],
    ['Evening News', 'The six o’clock bulletin', 12, 1795, a.id],
  );
  assert.deepEqual((await service.tags(caller(), b)).map((t) => t.label).sort(), [
    'Evening',
    'News',
  ]);
  const superseded = await service.get(caller(), a.id);
  assert.equal(superseded.replacedById, b);
  assert.equal(superseded.state, a.state, '`replaced` is not a state; the record keeps its own');

  const events = await drain();
  for (const e of events) assert.ok(validatePayload(e.type, e.payload).valid, e.type);
  const replaced = events.find((e) => e.type === 'asset.replaced');
  assert.deepEqual(replaced?.payload, { oldId: a.id, newId: b });
  const updated = events.find((e) => e.type === 'asset.updated');
  assert.deepEqual((updated?.payload as { changedFields: string[] }).changedFields.sort(), [
    'description',
    'episodeNo',
    'replacesId',
    'tags',
    'title',
  ]);
  const audits = events
    .filter((e) => e.type === 'audit.recorded')
    .map((e) => e.payload as { entityId: string; action: string; delta: Record<string, unknown> });
  assert.deepEqual(
    audits.map((x) => [x.entityId, x.action]).sort(),
    [
      [a.id, 'asset.replaced'],
      [b, 'asset.updated'],
    ].sort(),
  );
  assert.ok(audits.find((x) => x.entityId === a.id)?.delta['replacedById']);
  assert.ok(audits.find((x) => x.entityId === b)?.delta['tags'], 'the copied tags in the delta');

  // The chain, from either end.
  const chain = (await service.versions(caller(), a.id)).map((x) => x.id);
  assert.deepEqual(chain, [a.id, b]);
  assert.deepEqual(
    (await service.versions(caller(), b)).map((x) => x.id),
    [a.id, b],
  );

  // A third version is made from the newest — the old one is refused.
  const c = await ingest('evening_news_v3.mov');
  await assert.rejects(service.createVersion(caller(), a.id, { assetId: c }), status(409));
  await service.createVersion(caller(), b, { assetId: c });
  assert.deepEqual(
    (await service.versions(caller(), a.id)).map((x) => x.id),
    [a.id, b, c],
  );
  assert.equal((await service.get(caller(), c)).title, 'Evening News', 'copied along the chain');
});

test('a superseded version takes no verdict; the new one is reviewed on its own', async () => {
  const { service, caller, ingest } = harness();
  const a = await ingest('first.mov');
  const b = await ingest('second.mov');
  await service.createVersion(caller(), a, { assetId: b });
  await assert.rejects(
    service.transition(caller(APPROVER), a, 'reject', { reason: 'superseded' }),
    status(409),
  );
});

test('who may: core on the old asset, and every group the copy writes on the new one', async () => {
  const { service, caller, ingest } = harness();
  const a = await ingest('first.mov');
  const b = await ingest('second.mov');
  await assert.rejects(service.createVersion(caller(LIBRARIAN), a, { assetId: b }), status(403));
  await assert.rejects(
    service.createVersion(caller(EDITOR, 'user-1', 'ch99'), a, { assetId: b }),
    status(404),
    'another channel’s asset is not found',
  );
  await assert.rejects(service.createVersion(caller(), a, {}), status(422));
  await assert.rejects(service.createVersion(caller(), a, { assetId: a }), status(422));
  const audio = await ingest('podcast.wav', 'audio');
  await assert.rejects(service.createVersion(caller(), a, { assetId: audio }), status(422));
  const made = await service.createVersion(caller(EDITOR), a, { assetId: b });
  assert.equal(made.replacesId, a);
});
