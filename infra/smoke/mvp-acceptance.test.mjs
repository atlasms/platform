// EP-21.1 — the MVP acceptance journey, run against a DEPLOYED environment.
//
//   npm run k8s:up && npm run acceptance
//   ATLAS_BASE_URL=https://atlas.example ATLAS_WS_URL=wss://atlas.example npm run acceptance
//
// Phase 1's exit criterion (docs/roadmap/21-epic-breakdown.md) is a PATH, not a list of features:
// "on one channel — upload → validate → transcode (proxy+broadcast+thumbnail) → metadata → search
// → schedule, every step audited and live-updated." The smoke suite proves each hop on its own,
// each with an asset it made for the purpose; this walks ONE file through all of them, as an editor
// would, and only through what a client has — the gateway and the socket. A step that works alone
// and not after the one before it (the asset an ingest creates is not the asset a test POSTs) fails
// here and nowhere else.
//
// The first run found exactly that: the deployed gateway had no route for `/api/v1/search` — MAM
// served it, Studio's Search panel called it, every unit test and every smoke test was green.
//
// Same rules as the smoke suite: plain .mjs, no @atlas/* imports, HTTP and WebSocket only, and the
// journey skips (does not fail) where no seed account exists. Each step is a subtest, so a failure
// names the step, and once one fails the rest are skipped rather than failing for its reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.ATLAS_BASE_URL ?? 'http://localhost:30080';
const WS_BASE = process.env.ATLAS_WS_URL ?? 'ws://localhost:30081';
const TIMEOUT = Number(process.env.ATLAS_SMOKE_TIMEOUT_MS ?? 10_000);
/** How long an asynchronous hop (relay tick, consumer, FFmpeg) may take before it is a failure. */
const HOP = Number(process.env.ATLAS_ACCEPTANCE_HOP_MS ?? 60_000);

async function call(path, init = {}) {
  const response = await fetch(new URL(path, BASE), {
    ...init,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await response.text();
  let body;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, text, body };
}

/** Poll `fn` until `done(value)`; fail with `what` and the last value when the budget runs out. */
async function until(fn, done, what, budgetMs = HOP) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const value = await fn();
    if (done(value)) return value;
    assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value)?.slice(0, 600)}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * A real video file with no tools: `seconds` of 160×120 4:2:0 at 25 fps in YUV4MPEG2 — a text
 * header, then each frame as `FRAME\n` and its planes. ffprobe reads it as rawvideo with a
 * duration, so RIM calls it video, and FFmpeg makes all three renditions from it. The luma ramps
 * frame by frame so the thumbnail filter has something to choose between.
 */
function y4m(seconds) {
  const [w, h, fps] = [160, 120, 25];
  const parts = [Buffer.from(`YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420jpeg\n`)];
  for (let i = 0; i < fps * seconds; i++) {
    parts.push(Buffer.from('FRAME\n'), Buffer.alloc(w * h, 16 + ((i * 4) % 200)));
    parts.push(Buffer.alloc((w / 2) * (h / 2) * 2, 128));
  }
  return Buffer.concat(parts);
}

test('MVP acceptance — one file: upload → validate → transcode → metadata → search → schedule, every step audited and live', async (t) => {
  const login = await call('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ATLAS_SMOKE_USER ?? 'dev',
      password: process.env.ATLAS_SMOKE_PASSWORD ?? 'dev-password',
    }),
  });
  if (login.status === 401) {
    t.skip('no seed account in this environment');
    return;
  }
  assert.equal(login.status, 200, `login failed: ${login.text}`);
  const token = login.body.accessToken;
  const auth = { authorization: `Bearer ${token}` };
  const headers = { ...auth, 'content-type': 'application/json' };
  const fresh = { ...auth, 'cache-control': 'no-cache' };
  const channel = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ).channelId;
  assert.ok(channel, 'the token names a channel');

  // A word nobody else's asset contains, so search can only find THIS one.
  const word = `mvp${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const file = y4m(2);
  const sha256 = createHash('sha256').update(file).digest('hex');
  const journey = {};

  // The socket first: live updates are a claim about the moment each step happens, so the
  // subscriptions exist before the upload does. One per domain the journey crosses.
  const frames = [];
  const socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`no socket at ${WS_BASE}/ws`)), {
      once: true,
    });
    setTimeout(() => reject(new Error('socket did not open')), TIMEOUT).unref?.();
  });
  const patterns = ['ingest', 'asset', 'transcode', 'file', 'schedule'].map(
    (d) => `atlas.${channel}.${d}.>`,
  );
  for (const pattern of patterns) socket.send(JSON.stringify({ type: 'subscribe', pattern }));

  let broken;
  const step = (name, fn) =>
    t.test(name, async (s) => {
      if (broken) {
        s.skip(`an earlier step failed: ${broken}`);
        return;
      }
      try {
        await fn();
      } catch (err) {
        broken = name;
        throw err;
      }
    });

  try {
    await step('0 · the socket is subscribed to every domain the journey crosses', async () => {
      await until(
        () =>
          patterns.filter((p) => !frames.some((f) => f.type === 'subscribed' && f.subject === p)),
        (missing) => missing.length === 0,
        'subscriptions not confirmed',
        TIMEOUT,
      );
    });

    // The category the editor will file the asset under (#260: a real, addable category of the
    // channel — found by its path, or made once).
    {
      const list = await call('/api/v1/categories', { headers: auth });
      assert.equal(list.status, 200, list.text);
      journey.categoryId = list.body.find((c) => c.path === '/acceptance/')?.id;
      if (!journey.categoryId) {
        const made = await call('/api/v1/categories', {
          method: 'POST',
          headers,
          body: JSON.stringify({ key: 'acceptance', labels: { en: 'Acceptance' } }),
        });
        assert.equal(made.status, 201, made.text);
        journey.categoryId = made.body.id;
      }
    }

    await step('1 · upload — a video file in server-sized parts, through the gateway', async () => {
      const started = await call('/api/v1/uploads', {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename: `Acceptance ${word}.y4m`, sizeBytes: file.length }),
      });
      assert.equal(started.status, 201, started.text);
      const { uploadId, partSizeBytes, partCount } = started.body;
      for (let n = 1; n <= partCount; n++) {
        const part = await call(`/api/v1/uploads/${uploadId}/parts/${n}`, {
          method: 'PUT',
          headers: { ...auth, 'content-type': 'application/octet-stream' },
          body: file.subarray((n - 1) * partSizeBytes, n * partSizeBytes),
        });
        assert.equal(part.status, 204, `part ${n}: ${part.text}`);
      }
      const done = await call(`/api/v1/uploads/${uploadId}/complete`, {
        method: 'POST',
        headers,
      });
      assert.equal(done.status, 202, done.text);
      assert.equal(done.body.checksum, sha256, 'the checksum is of the bytes sent');
      journey.jobId = done.body.id;
    });

    await step('2 · validate — probed as video, accepted, its original placed in HSM', async () => {
      const job = await until(
        async () => (await call(`/api/v1/ingest/${journey.jobId}`, { headers: auth })).body,
        (j) => ['registered', 'rejected', 'quarantined'].includes(j?.state),
        'the ingest job never settled',
      );
      assert.equal(job.state, 'registered', JSON.stringify(job));
      assert.deepEqual(
        [job.technicalMetadata?.videoCodec, job.technicalMetadata?.width, job.assetId],
        ['rawvideo', 160, journey.jobId],
        'probed, and the asset id is the job id',
      );
      journey.assetId = job.assetId;
      const location = (await call(`/api/v1/assets/${journey.assetId}/location`, { headers: auth }))
        .body;
      const original = location?.find((f) => f.kind === 'original');
      assert.ok(original, `no original in HSM: ${JSON.stringify(location)}`);
      assert.equal(original.checksum.value, sha256, 'HSM holds the bytes that were uploaded');
    });

    await step('3 · catalogue — MAM creates the asset from the accepted ingest', async () => {
      const asset = await until(
        () => call(`/api/v1/assets/${journey.assetId}`, { headers: fresh }),
        (r) => r.status === 200,
        'MAM never created the asset',
      );
      assert.deepEqual(
        [asset.body.title, asset.body.mediaType, asset.body.fileType, asset.body.state],
        [`Acceptance ${word}`, 'video', 'y4m', 'created'],
      );
      assert.equal(asset.body.channelId, channel, 'one channel, throughout');
      journey.durationSec = asset.body.durationSec;
    });

    await step(
      '4 · metadata — described, categorised and tagged while its first renditions are still being made',
      async () => {
        // DELIBERATELY now, not after the transcodes: an editor describes an asset the moment it
        // appears, and MTS is making its first renditions at the same time — so MAM's mirror
        // (`hasRenditions`) and this edit write the same asset concurrently. Before #385 that was a
        // lost update and a duplicate audit revision; step 9 holds both to account.
        const patched = await call(`/api/v1/assets/${journey.assetId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            title: `Acceptance ${word} — evening bulletin`,
            description: 'The MVP acceptance journey, one file from upload to the program table.',
            categoryId: journey.categoryId,
          }),
        });
        assert.equal(patched.status, 200, patched.text);
        const tagged = await call(`/api/v1/assets/${journey.assetId}/tags`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ tags: ['acceptance', `tag${word}`] }),
        });
        assert.equal(tagged.status, 200, tagged.text);
        assert.deepEqual(tagged.body.map((tag) => tag.label).sort(), ['acceptance', `tag${word}`]);
      },
    );

    await step(
      '5 · transcode — proxy + thumbnail on their own, broadcast from HSM’s original',
      async () => {
        const jobsOf = async () =>
          (await call(`/api/v1/jobs?assetId=${journey.assetId}`, { headers: auth })).body ?? [];
        const first = await until(
          jobsOf,
          (list) => list.some((j) => ['completed', 'dead-letter'].includes(j.state)),
          'MTS never finished the first renditions',
          HOP * 2,
        );
        const auto = first.find((j) => j.state === 'completed');
        assert.ok(auto, `the first renditions failed: ${JSON.stringify(first)}`);
        assert.deepEqual(
          [auto.presetIds, auto.inputFile?.kind],
          [['proxy', 'thumbnail'], 'original'],
          'queued by MTS itself, from the original HSM holds',
        );

        const enqueued = await call('/api/v1/jobs', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            assetId: journey.assetId,
            presetIds: ['broadcast'],
            inputFile: { kind: 'original' },
          }),
        });
        assert.equal(enqueued.status, 202, enqueued.text);
        const broadcast = await until(
          async () => (await call(`/api/v1/jobs/${enqueued.body.id}`, { headers: auth })).body,
          (j) => ['completed', 'dead-letter'].includes(j?.state),
          'the broadcast rendition never finished',
          HOP * 2,
        );
        assert.equal(broadcast.state, 'completed', JSON.stringify(broadcast));
        journey.transcodeJobIds = [auto.id, broadcast.id];

        const location = (
          await call(`/api/v1/assets/${journey.assetId}/location`, { headers: auth })
        ).body;
        assert.deepEqual(
          location.map((f) => f.kind).sort(),
          ['broadcast', 'original', 'proxy', 'thumbnail'],
          'all four files, in HSM',
        );
        journey.fileIds = location.map((f) => f.id);
        // MAM's file rows are HSM's word (file.placed), with HSM's checksums.
        const files = await until(
          async () =>
            (await call(`/api/v1/assets/${journey.assetId}/files`, { headers: fresh })).body,
          (list) => Array.isArray(list) && list.length >= 4,
          "MAM's mirror never took every placement",
        );
        for (const placed of location) {
          const row = files.find((f) => f.kind === placed.kind);
          assert.equal(row?.checksum?.value, placed.checksum.value, `${placed.kind} mirrored`);
        }
      },
    );

    await step('6 · search — found by a word of its title, and by its tag', async () => {
      for (const q of [word, `tag${word}`, `${word} bulletin`]) {
        const res = await call(`/api/v1/search?q=${encodeURIComponent(q)}`, { headers: auth });
        assert.equal(res.status, 200, `search "${q}" through the gateway: ${res.text}`);
        assert.deepEqual(
          res.body.map((a) => a.id),
          [journey.assetId],
          `search "${q}" finds exactly this asset`,
        );
      }
    });

    await step('7 · review — processed, ready, approved', async () => {
      await until(
        async () => (await call(`/api/v1/assets/${journey.assetId}`, { headers: fresh })).body,
        (a) => a?.hasRenditions === true,
        'the asset never had renditions',
      );
      for (const action of ['process', 'ready']) {
        const res = await call(`/api/v1/assets/${journey.assetId}/${action}`, {
          method: 'POST',
          headers,
        });
        assert.equal(res.status, 200, `${action}: ${res.text}`);
      }
      const approved = await call(`/api/v1/assets/${journey.assetId}/approve`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ expiresAt: '2099-01-01T00:00:00.000Z' }),
      });
      assert.equal(approved.status, 200, approved.text);
      assert.equal(approved.body.state, 'approved');
    });

    await step('8 · schedule — on a reel, validated against the approval', async () => {
      // A day of its own, far enough out that no other run's reel is on it — and another if a
      // long-lived cluster has one there already (one schedule per channel per day).
      let day;
      let created;
      for (let attempt = 0; attempt < 8; attempt++) {
        day = new Date(Date.now() + (800 + Math.floor(Math.random() * 3000)) * 86_400_000)
          .toISOString()
          .slice(0, 10);
        created = await call('/api/v1/schedules', {
          method: 'POST',
          headers,
          body: JSON.stringify({ broadcastDate: day, timezone: 'UTC' }),
        });
        if (created.status !== 409) break;
      }
      assert.equal(created.status, 201, created.text);
      journey.scheduleId = created.body.id;
      const saved = await call(`/api/v1/schedules/${journey.scheduleId}/items`, {
        method: 'PUT',
        headers,
        body: JSON.stringify([
          {
            seq: 0,
            start: `${day}T19:00:00.000Z`,
            durationSec: Math.max(1, Math.round(journey.durationSec ?? 2)),
            itemType: 'media',
            mediaId: journey.assetId,
          },
        ]),
      });
      assert.equal(saved.status, 200, saved.text);
      // The approval crosses the broker into Scheduling's own record: poll until it has.
      const report = await until(
        async () =>
          (
            await call(`/api/v1/schedules/${journey.scheduleId}/validate`, {
              method: 'POST',
              headers,
            })
          ).body,
        (r) => r?.valid === true,
        'the reel never validated',
      );
      assert.deepEqual([report.state, report.issues], ['validated', []]);
      // Every validator ran — availability too: HSM holds the broadcast rendition step 5 made, online.
      assert.deepEqual(report.unchecked, [], 'nothing went unchecked');
    });

    await step(
      '9 · audited — every entity the journey touched has its history, with deltas',
      async () => {
        const history = (type, id, done, what) =>
          until(
            async () =>
              (await call(`/api/v1/history/${type}/${id}`, { headers: auth })).body?.revisions ??
              [],
            done,
            what,
            HOP / 2,
          );
        const after = (field, value) => (revs) =>
          revs.some((r) => r.delta?.[field]?.after === value);

        const ingest = await history(
          'ingest',
          journey.jobId,
          after('state', 'registered'),
          'ingest',
        );
        assert.equal(ingest[0].action, 'ingest.detected');
        assert.deepEqual(ingest[0].delta.checksum, { after: sha256 });

        // The edit made while the renditions landed (step 4) survived beside them, and EVERY
        // revision MAM committed reached the log exactly once: 1..version, no gap. Before #385 two
        // writers could commit one revision twice — the sink kept the first and dead-lettered the
        // other, so the trail had a hole and one of the two changes was gone from the row.
        const stored = (await call(`/api/v1/assets/${journey.assetId}`, { headers: fresh })).body;
        assert.deepEqual(
          [stored.hasRenditions, stored.categoryId, stored.state],
          [true, journey.categoryId, 'approved'],
          'neither the mirror’s write nor the editor’s was lost',
        );
        const asset = await history(
          'asset',
          journey.assetId,
          (revs) => revs.length >= stored.version,
          `all ${stored.version} revisions of the asset`,
        );
        assert.deepEqual(
          asset.map((r) => r.revision),
          Array.from({ length: stored.version }, (_, i) => i + 1),
          'one record per revision, none missing, none twice',
        );
        assert.equal(asset[0].action, 'asset.created');
        assert.ok(after('categoryId', journey.categoryId)(asset), 'the metadata edit, as a delta');
        for (const state of ['processing', 'ready']) {
          assert.ok(after('state', state)(asset), `the move to ${state}`);
        }

        for (const id of journey.transcodeJobIds) {
          await history('transcode-job', id, after('state', 'completed'), `transcode job ${id}`);
        }
        for (const id of journey.fileIds) {
          await history('file', id, (revs) => revs.length >= 1, `file ${id}`);
        }
        await history(
          'schedule',
          journey.scheduleId,
          (revs) => revs.some((r) => r.action === 'schedule.validated'),
          'schedule',
        );
      },
    );

    await step('10 · live — every step reached the socket as it happened', async () => {
      const expected = [
        ['ingest.detected', journey.jobId],
        ['ingest.accepted', journey.assetId],
        ['asset.created', journey.assetId],
        ...journey.transcodeJobIds.map((id) => ['transcode.completed', id]),
        // HSM's placements reach the socket under the file set's grant (#384).
        ...journey.fileIds.map((id) => ['file.placed', id]),
        ['asset.updated', journey.assetId],
        ['asset.ready', journey.assetId],
        ['asset.approved', journey.assetId],
        ['schedule.updated', journey.scheduleId],
        ['schedule.validated', journey.scheduleId],
      ];
      const seen = ([type, id]) =>
        frames.some(
          (f) =>
            f.type === 'event' &&
            f.subject === `atlas.${channel}.${type}` &&
            JSON.stringify(f.payload).includes(id),
        );
      await until(
        () => expected.filter((e) => !seen(e)).map(([type]) => type),
        (missing) => missing.length === 0,
        'never arrived on the socket',
        HOP / 2,
      );
    });
  } finally {
    socket.close();
  }
});
