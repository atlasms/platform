// ADR-0012 — MAM's half of a browser reading media: it answers the authorization question and signs
// one file of one asset in one channel, as one content type, until a time, into a URL HSM serves.
// What is tested here is what MAM decides; HSM's serving is HSM's suite, and the round trip smoke's.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnvelope, ulid, type EventPayloads } from '@atlas/contracts';
import { compile, type Rule } from '@atlas/policy';
import { verifyMediaUrl } from '@atlas/service-kit';
import {
  buildMamApp,
  MamService,
  mediaTypeOf,
  sqliteAssetStore,
  type Caller,
} from '../src/index.ts';

const CH = 'ch12';
const KEY = 'm'.repeat(40);
const NOW = new Date('2026-11-23T12:00:00Z');
const READ_FILES: Rule[] = [
  { id: 'r', permissions: ['asset:read', 'asset:write'], scope: { channelIds: [CH] } },
];
/** Reads the asset, but not its files group — the Editor's half without the Librarian's. */
const READ_CORE_ONLY: Rule[] = [
  { id: 'r', permissions: ['asset:read'], scope: { channelIds: [CH] }, fieldGroups: ['core'] },
  { id: 'w', permissions: ['asset:write'], scope: { channelIds: [CH] } },
];

function harness(
  mediaUrls: { key: string; ttlSeconds: number } | null = { key: KEY, ttlSeconds: 1800 },
) {
  const store = sqliteAssetStore();
  const service = new MamService({ store, now: () => NOW, ...(mediaUrls ? { mediaUrls } : {}) });
  const caller = (rules: Rule[] = READ_FILES, channelId = CH): Caller => ({
    userId: 'u1',
    channelId,
    policy: compile({ subjectId: 'u1', permVersion: 1, rules }),
  });
  /** MTS announcing renditions, as the mirror receives them. */
  const transcoded = (
    assetId: string,
    renditions: EventPayloads['transcode.completed']['renditions'],
  ) => {
    const env = buildEnvelope({
      type: 'transcode.completed',
      channelId: CH,
      payload: { assetId, jobId: ulid(), renditions },
    });
    return service.mirrorTranscode({ id: env.messageId, subject: 'x', body: env });
  };
  const placed = (payload: EventPayloads['file.placed']) => {
    const env = buildEnvelope({ type: 'file.placed', channelId: CH, payload });
    return service.mirrorPlacement({ id: env.messageId, subject: 'x', body: env });
  };
  return { service, caller, transcoded, placed };
}

const sha = { algorithm: 'sha256' as const, value: 'c'.repeat(64) };
const query = (url: string) => {
  const u = new URL(url, 'https://atlas.example');
  const [, , , assetId, kind] = u.pathname.split('/');
  return { assetId: assetId!, kind: kind!, query: Object.fromEntries(u.searchParams) };
};

test('a URL grants one file, as the type of its container, for the configured life', async () => {
  const h = harness();
  const asset = await h.service.create(h.caller(), {
    title: 'Clip',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await h.transcoded(asset.id, [
    {
      kind: 'proxy',
      variant: 'edit',
      fileType: 'mp4',
      path: `${CH}/${asset.id}/proxy.edit/b`,
      checksum: sha,
    },
  ]);

  const { url, expiresAt } = await h.service.mediaUrl(h.caller(), asset.id, 'proxy', 'edit');
  assert.match(url, new RegExp(`^/media/v1/${asset.id}/proxy\\?`));
  assert.equal(expiresAt, '2026-11-23T12:30:00.000Z');
  const verdict = verifyMediaUrl([KEY], query(url), NOW);
  assert.ok(verdict.ok, JSON.stringify(verdict));
  assert.deepEqual(verdict.grant, {
    channelId: CH,
    assetId: asset.id,
    kind: 'proxy',
    variant: 'edit',
    contentType: 'video/mp4',
    exp: Math.floor(NOW.getTime() / 1000) + 1800,
  });
});

test('the original takes the asset’s own container; an unknown one is an octet stream, never a page', async () => {
  const h = harness();
  const asset = await h.service.create(h.caller(), {
    title: 'Master',
    mediaType: 'video',
    fileType: 'mxf',
  });
  await h.placed({
    fileId: ulid(),
    assetId: asset.id,
    renditionKind: 'original',
    path: `${CH}/${asset.id}/original/b`,
    tier: 'online',
    checksum: sha,
  } as EventPayloads['file.placed']);
  const { url } = await h.service.mediaUrl(h.caller(), asset.id, 'original');
  assert.equal(query(url).query['ct'], 'application/mxf');
  assert.equal(mediaTypeOf('html'), 'application/octet-stream');
  assert.equal(mediaTypeOf(undefined), 'application/octet-stream');
  assert.equal(mediaTypeOf('MP4'), 'video/mp4');
});

test('no such file is a 404; a file not online is a 409 — a restore comes first', async () => {
  const h = harness();
  const asset = await h.service.create(h.caller(), {
    title: 'Clip',
    mediaType: 'video',
    fileType: 'mp4',
  });
  await assert.rejects(
    h.service.mediaUrl(h.caller(), asset.id, 'proxy', 'edit'),
    (e: Error & { status?: number }) => e.status === 404,
  );
  await h.placed({
    fileId: ulid(),
    assetId: asset.id,
    renditionKind: 'broadcast',
    path: `${CH}/${asset.id}/broadcast/b`,
    tier: 'near-line',
    checksum: sha,
  } as EventPayloads['file.placed']);
  await assert.rejects(
    h.service.mediaUrl(h.caller(), asset.id, 'broadcast'),
    (e: Error & { status?: number }) => e.status === 409,
  );
});

test('the grant is the files group’s; another channel’s asset is a 404; no key is a 503', async () => {
  const h = harness();
  const asset = await h.service.create(h.caller(), {
    title: 'Clip',
    mediaType: 'video',
    fileType: 'mp4',
  });
  await h.transcoded(asset.id, [
    { kind: 'proxy', fileType: 'mp4', path: `${CH}/${asset.id}/proxy/b`, checksum: sha },
  ]);
  await assert.rejects(
    h.service.mediaUrl(h.caller(READ_CORE_ONLY), asset.id, 'proxy'),
    (e: Error & { status?: number }) => e.status === 403,
  );
  await assert.rejects(
    h.service.mediaUrl(
      h.caller([{ id: 'r', permissions: ['asset:read'], scope: { channelIds: ['ch99'] } }], 'ch99'),
      asset.id,
      'proxy',
    ),
    (e: Error & { status?: number }) => e.status === 404,
  );

  const unconfigured = harness(null);
  const other = await unconfigured.service.create(unconfigured.caller(), {
    title: 'Clip',
    mediaType: 'video',
    fileType: 'mp4',
  });
  await assert.rejects(
    unconfigured.service.mediaUrl(unconfigured.caller(), other.id, 'proxy'),
    (e: Error & { status?: number }) => e.status === 503,
  );
});

test('over HTTP: GET /assets/{id}/files/{kind}/url?variant= answers { url, expiresAt }', async () => {
  const h = harness();
  const asset = await h.service.create(h.caller(), {
    title: 'Clip',
    mediaType: 'video',
    fileType: 'mp4',
  });
  await h.transcoded(asset.id, [
    {
      kind: 'proxy',
      variant: 'edit',
      fileType: 'mp4',
      path: `${CH}/${asset.id}/proxy.edit/b`,
      checksum: sha,
    },
  ]);
  const app = await buildMamApp({ service: h.service, policyFor: () => h.caller().policy });
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/assets/${asset.id}/files/proxy/url?variant=edit`,
    headers: { 'x-atlas-user': 'u1', 'x-atlas-channel': CH },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<{ url: string; expiresAt: string }>();
  assert.equal(verifyMediaUrl([KEY], query(body.url), NOW).ok, true);
  await app.close();
});
