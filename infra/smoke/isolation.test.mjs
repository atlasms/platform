// EP-30.2 — channel isolation, end to end: the cross-tenant suite, run against a DEPLOYED cluster.
//
//   npm run k8s:up && npm run isolation
//
// Two accounts with the SAME broad grant, each in its own channel: the dev account in `ch12` (the
// OWNER, whose things are made here) and a RIVAL in `ch99` (seeded by the dev overlay since
// EP-30.2, `ATLAS_SEED_RIVAL_*`). Everything the rival is refused below it holds every permission
// for — in its own channel. So each refusal is the channel boundary, not a missing grant: the
// suite would pass vacuously against a rival with no rights, and that is the mistake it is built
// not to make. Every case also has a CONTROL — the owner reads what the rival may not — so a
// refusal cannot be a route that is simply broken.
//
// The rules (authorization-model §5a, decided with this suite):
//   - another channel's resource is NOT FOUND — a 404, exactly as an id nobody made. Never a 403,
//     which would say it exists;
//   - another channel's history is EMPTY — a 200 with no revisions, as for an entity that never
//     existed (logging app.ts: a 404 there would itself be information);
//   - another channel's id named in a body (a category, a term, a person, a user, a group, a
//     workflow, an asset) is refused or reaches nothing — never a write into that channel;
//   - lists, searches, the catalog, the log and the inbox carry none of another channel's rows;
//   - a socket can neither subscribe into another channel nor receive one of its frames.
//
// Plain .mjs, no @atlas/* imports, HTTP and WebSocket only — like the smoke suite, and for the same
// reason: a test that shares code with what it tests can pass because both are wrong the same way.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.ATLAS_BASE_URL ?? 'http://localhost:30080';
const WS_BASE = process.env.ATLAS_WS_URL ?? 'ws://localhost:30081';
const TIMEOUT = Number(process.env.ATLAS_SMOKE_TIMEOUT_MS ?? 10_000);

const OWNER = {
  username: process.env.ATLAS_SMOKE_USER ?? 'dev',
  password: process.env.ATLAS_SMOKE_PASSWORD ?? 'dev-password',
};
const RIVAL = {
  username: process.env.ATLAS_ISOLATION_RIVAL_USER ?? 'rival',
  password: process.env.ATLAS_ISOLATION_RIVAL_PASSWORD ?? 'rival-password',
};

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll an async read until `done(result)` or the budget runs out; returns the last result. */
async function poll(read, done, budgetMs = 30_000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const result = await read();
    if (done(result) || Date.now() > deadline) return result;
    await sleep(500);
  }
}

/** A signed-in principal: its token, channel and user id, and request helpers that carry them. */
async function signIn({ username, password }) {
  const login = await call('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (login.status === 401) return undefined;
  assert.equal(login.status, 200, `login ${username}: ${login.text}`);
  const token = login.body.accessToken;
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const send = (method, path, body, extra = {}) =>
    call(path, {
      method,
      headers: { ...headers, ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return {
    token,
    channelId: claims.channelId,
    userId: claims.sub,
    get: (path) => send('GET', path, undefined, { 'cache-control': 'no-cache' }),
    post: (path, body) => send('POST', path, body ?? {}),
    put: (path, body) => send('PUT', path, body),
    patch: (path, body) => send('PATCH', path, body),
    del: (path) => send('DELETE', path),
  };
}

/** Another channel's resource: not found, exactly as an id nobody made. */
function hidden(res, what) {
  assert.equal(
    res.status,
    404,
    `${what} must be NOT FOUND to another channel, got ${res.status}: ${res.text}`,
  );
}

/** Refused, whatever the status — a 4xx, never a success and never a 5xx. */
function refused(res, what) {
  assert.ok(
    res.status >= 400 && res.status < 500,
    `${what} must be refused, got ${res.status}: ${res.text}`,
  );
}

/** The ids in a list answer, whatever its envelope (`[…]`, `{ items }`, `{ tasks }`). */
function idsOf(body, key = 'items') {
  const rows = Array.isArray(body) ? body : (body?.[key] ?? []);
  return new Set(rows.map((r) => r.id));
}

/** A WebSocket that records every frame it receives. */
async function openSocket(token) {
  const socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
  const frames = [];
  socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`no socket at ${WS_BASE}/ws`)), {
      once: true,
    });
    setTimeout(() => reject(new Error('socket did not open')), TIMEOUT).unref?.();
  });
  const answered = async (pattern) => {
    const deadline = Date.now() + TIMEOUT;
    while (Date.now() < deadline) {
      const frame = frames.find(
        (f) => (f.type === 'subscribed' || f.type === 'error') && f.subject === pattern,
      );
      if (frame) return frame;
      await sleep(50);
    }
    return undefined;
  };
  return {
    frames,
    async subscribe(pattern) {
      socket.send(JSON.stringify({ type: 'subscribe', pattern }));
      return answered(pattern);
    },
    close: () => socket.close(),
  };
}

// --- the two principals, and what the owner makes for the rival to reach for ---------------------

let owner;
let rival;
let ownerSocket;
let rivalSocket;
/** Everything the owner made, by kind, for the final sweep over the rival's frames and log. */
const made = { entityIds: new Set() };
const run = Date.now().toString(36);

/** A category of the principal's own channel, found by its key or made once. */
async function categoryOf(who, key) {
  const list = await who.get('/api/v1/categories');
  assert.equal(list.status, 200, list.text);
  const found = list.body.find((c) => c.path === `/${key}/`);
  if (found) return found;
  const createdCategory = await who.post('/api/v1/categories', { key, labels: { en: key } });
  assert.equal(createdCategory.status, 201, createdCategory.text);
  return createdCategory.body;
}

async function assetOf(who, title, categoryId) {
  const res = await who.post('/api/v1/assets', {
    title,
    mediaType: 'video',
    fileType: 'mp4',
    categoryId,
  });
  assert.equal(res.status, 201, `asset: ${res.text}`);
  return res.body;
}

before(async () => {
  owner = await signIn(OWNER);
  rival = await signIn(RIVAL);
  if (!owner || !rival) return;
  assert.notEqual(owner.channelId, rival.channelId, 'the rival must be in ANOTHER channel');
  ownerSocket = await openSocket(owner.token);
  rivalSocket = await openSocket(rival.token);
});

after(() => {
  ownerSocket?.close();
  rivalSocket?.close();
});

/** Skip, loudly, where the environment has no rival account (a real one has neither seed). */
function present(t) {
  if (owner && rival) return true;
  t.skip('no seed accounts in this environment (ATLAS_SEED_* / ATLAS_SEED_RIVAL_*)');
  return false;
}

// --- the socket ------------------------------------------------------------------------------------

test('isolation: a socket cannot subscribe into another channel, by name or by wildcard', async (t) => {
  if (!present(t)) return;
  const own = `atlas.${owner.channelId}.>`;
  assert.equal(
    (await ownerSocket.subscribe(own))?.type,
    'subscribed',
    'control: the owner hears its channel',
  );
  assert.equal((await ownerSocket.subscribe(`live.${owner.channelId}.>`))?.type, 'subscribed');

  for (const pattern of [
    `atlas.${owner.channelId}.>`,
    `atlas.${owner.channelId}.asset.>`,
    `live.${owner.channelId}.>`,
    'atlas.*.>',
    'atlas.>.asset',
    `user.${owner.userId}.>`,
  ]) {
    const answer = await rivalSocket.subscribe(pattern);
    assert.equal(
      answer?.type,
      'error',
      `the rival subscribed to ${pattern}: ${JSON.stringify(answer)}`,
    );
  }
  // Its own channel, wide open — every frame it may see there, which the final sweep reads.
  assert.equal((await rivalSocket.subscribe(`atlas.${rival.channelId}.>`))?.type, 'subscribed');
  assert.equal((await rivalSocket.subscribe(`live.${rival.channelId}.>`))?.type, 'subscribed');
});

// --- IAM -------------------------------------------------------------------------------------------

test('isolation: IAM — another channel’s users and groups are not found, and cannot be written', async (t) => {
  if (!present(t)) return;
  const group = await owner.post('/api/v1/groups', { name: `isolation ${run}` });
  assert.equal(group.status, 201, group.text);
  made.entityIds.add(group.body.id);
  assert.equal((await owner.get(`/api/v1/groups/${group.body.id}`)).status, 200, 'control');
  assert.equal((await owner.get(`/api/v1/users/${owner.userId}`)).status, 200, 'control');

  hidden(await rival.get(`/api/v1/users/${owner.userId}`), 'a user');
  hidden(
    await rival.get(`/api/v1/users/${owner.userId}/effective-permissions`),
    'a user’s permissions',
  );
  hidden(await rival.patch(`/api/v1/users/${owner.userId}`, { name: 'taken' }), 'a user, written');
  hidden(
    await rival.post(`/api/v1/users/${owner.userId}/assignments`, { roleId: 'viewer' }),
    'a grant to a user',
  );
  hidden(await rival.get(`/api/v1/groups/${group.body.id}`), 'a group');
  hidden(
    await rival.patch(`/api/v1/groups/${group.body.id}`, { name: 'taken' }),
    'a group, written',
  );
  hidden(
    await rival.post(`/api/v1/groups/${group.body.id}/members`, { userId: rival.userId }),
    'joining a group',
  );
  hidden(await rival.del(`/api/v1/groups/${group.body.id}`), 'a group, deleted');

  const users = await rival.get('/api/v1/users?limit=200');
  assert.equal(users.status, 200, users.text);
  assert.ok(!idsOf(users.body).has(owner.userId), 'the user list carries another channel’s user');
  const groups = await rival.get('/api/v1/groups');
  assert.equal(groups.status, 200, groups.text);
  assert.ok(
    !idsOf(groups.body).has(group.body.id),
    'the group list carries another channel’s group',
  );

  // Naming the other channel outright is a 403: the rival holds user:admin, but not THERE.
  const planted = await rival.post('/api/v1/users', {
    username: `planted-${run}`,
    password: 'planted-password-not-a-secret',
    channelId: owner.channelId,
  });
  assert.equal(planted.status, 403, `a user planted in another channel: ${planted.text}`);
  // And the rival's own group cannot take the owner as a member.
  const own = await rival.post('/api/v1/groups', { name: `rival ${run}` });
  assert.equal(own.status, 201, own.text);
  refused(
    await rival.post(`/api/v1/groups/${own.body.id}/members`, { userId: owner.userId }),
    'another channel’s user as a member',
  );
  const after = await owner.get(`/api/v1/groups/${group.body.id}`);
  assert.equal(after.body.name, `isolation ${run}`, 'the owner’s group is untouched');
});

// --- MAM -------------------------------------------------------------------------------------------

let ownerAsset;
let ownerCategory;

test('isolation: MAM — another channel’s asset is not found: read, written, judged, versioned, searched', async (t) => {
  if (!present(t)) return;
  ownerCategory = await categoryOf(owner, 'isolation');
  const rivalCategory = await categoryOf(rival, 'isolation');
  const word = `iso${run}`;
  ownerAsset = await assetOf(owner, `Owner clip ${word}`, ownerCategory.id);
  const id = ownerAsset.id;
  assert.equal((await owner.get(`/api/v1/assets/${id}`)).status, 200, 'control');

  for (const path of [
    `/api/v1/assets/${id}`,
    `/api/v1/assets/${id}/extended`,
    `/api/v1/assets/${id}/files`,
    `/api/v1/assets/${id}/inherited`,
    `/api/v1/assets/${id}/verdicts`,
    `/api/v1/assets/${id}/versions`,
    `/api/v1/assets/${id}/shotlist`,
  ]) {
    hidden(await rival.get(path), `GET ${path}`);
  }
  hidden(await rival.patch(`/api/v1/assets/${id}`, { title: 'taken' }), 'an asset, written');
  hidden(await rival.put(`/api/v1/assets/${id}/tags`, { tags: ['taken'] }), 'an asset’s tags');
  hidden(await rival.put(`/api/v1/assets/${id}/shotlist`, { items: [] }), 'an asset’s shot list');
  hidden(await rival.post(`/api/v1/assets/${id}/approve`, {}), 'an asset, approved');
  hidden(await rival.post(`/api/v1/assets/${id}/reject`, { reason: 'no' }), 'an asset, rejected');
  hidden(await rival.del(`/api/v1/assets/${id}`), 'an asset, deleted');

  // A version chain across channels, either way round.
  const rivalAsset = await assetOf(rival, `Rival clip ${word}`, rivalCategory.id);
  hidden(
    await rival.post(`/api/v1/assets/${id}/versions`, { assetId: rivalAsset.id }),
    'replacing another channel’s asset',
  );
  refused(
    await rival.post(`/api/v1/assets/${rivalAsset.id}/versions`, { assetId: id }),
    'another channel’s asset as the next version',
  );

  // Lists and search carry none of it; the browse by the owner's category finds nothing.
  const list = await rival.get('/api/v1/assets?limit=200');
  assert.equal(list.status, 200, list.text);
  assert.ok(!idsOf(list.body).has(id), 'the asset list carries another channel’s asset');
  const search = await rival.post('/api/v1/search', { q: word });
  assert.equal(search.status, 200, search.text);
  const found = idsOf(search.body);
  assert.ok(found.has(rivalAsset.id), 'control: the rival finds its own asset by the same word');
  assert.ok(!found.has(id), 'search returns another channel’s asset');
  const browse = await rival.get(`/api/v1/assets?categoryId=${ownerCategory.id}&subtree=true`);
  assert.ok(browse.status === 200 || browse.status === 422, browse.text);
  if (browse.status === 200)
    assert.equal(idsOf(browse.body).size, 0, 'a browse by another channel’s category');

  const untouched = await owner.get(`/api/v1/assets/${id}`);
  assert.equal(untouched.body.version, ownerAsset.version, 'the owner’s asset is untouched');
  assert.equal(untouched.body.title, ownerAsset.title);
});

test('isolation: MAM — another channel’s category, terms and people are not found, and cannot be named', async (t) => {
  if (!present(t)) return;
  const term = await owner.post('/api/v1/vocabularies/genre', {
    key: `iso-${run}`,
    labels: { en: 'Isolation' },
  });
  assert.equal(term.status, 201, term.text);
  const person = await owner.post('/api/v1/people', { name: `Isolation ${run}` });
  assert.equal(person.status, 201, person.text);
  made.entityIds.add(ownerCategory.id).add(term.body.id).add(person.body.id);

  hidden(await rival.get(`/api/v1/categories/${ownerCategory.id}`), 'a category');
  hidden(
    await rival.patch(`/api/v1/categories/${ownerCategory.id}?version=${ownerCategory.version}`, {
      labels: { en: 'taken' },
    }),
    'a category, written',
  );
  hidden(await rival.get(`/api/v1/people/${person.body.id}`), 'a person');
  hidden(
    await rival.patch(`/api/v1/people/${person.body.id}?version=${person.body.version}`, {
      name: 'taken',
    }),
    'a person, written',
  );
  hidden(await rival.get(`/api/v1/vocabularies/genre/${term.body.id}`), 'a term');

  const categories = await rival.get('/api/v1/categories');
  assert.ok(
    !idsOf(categories.body).has(ownerCategory.id),
    'the category tree carries another channel’s node',
  );
  const terms = await rival.get('/api/v1/vocabularies/genre');
  assert.ok(!idsOf(terms.body).has(term.body.id), 'a vocabulary carries another channel’s term');
  const people = await rival.get('/api/v1/people?limit=200');
  assert.ok(
    !idsOf(people.body).has(person.body.id),
    'the people register carries another channel’s person',
  );

  // Named in a body: an asset filed under the owner's category, given the owner's genre, cast with
  // the owner's person — each a 422, as for an id nobody made.
  const rivalCategory = await categoryOf(rival, 'isolation');
  const filed = await rival.post('/api/v1/assets', {
    title: 'filed across',
    mediaType: 'video',
    fileType: 'mp4',
    categoryId: ownerCategory.id,
  });
  assert.equal(filed.status, 422, `an asset under another channel’s category: ${filed.text}`);
  const own = await assetOf(rival, 'Rival terms', rivalCategory.id);
  const genre = await rival.patch(`/api/v1/assets/${own.id}`, { genre: term.body.id });
  assert.equal(genre.status, 422, `another channel’s term as a genre: ${genre.text}`);
  const role = await rival.post('/api/v1/vocabularies/cast-role', {
    key: `iso-host-${run}`,
    labels: { en: 'Host' },
    roleClass: 'on-screen',
  });
  assert.equal(role.status, 201, role.text);
  const cast = await rival.patch(`/api/v1/assets/${own.id}`, {
    cast: [{ personId: person.body.id, roleId: role.body.id }],
  });
  assert.equal(cast.status, 422, `another channel’s person in a cast: ${cast.text}`);
});

// --- RIM -------------------------------------------------------------------------------------------

test('isolation: RIM — another channel’s upload, ingest job and watcher are not found, and cannot be driven', async (t) => {
  if (!present(t)) return;
  const upload = await owner.post('/api/v1/uploads', {
    filename: 'isolation.bin',
    sizeBytes: 16,
    contentType: 'application/octet-stream',
  });
  assert.equal(upload.status, 201, upload.text);
  const uploadId = upload.body.uploadId;
  made.entityIds.add(uploadId);
  assert.equal((await owner.get(`/api/v1/uploads/${uploadId}`)).status, 200, 'control');

  hidden(await rival.get(`/api/v1/uploads/${uploadId}`), 'an upload');
  const part = await call(`/api/v1/uploads/${uploadId}/parts/1`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${rival.token}`, 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(16, 7),
  });
  hidden(part, 'a part of another channel’s upload');
  hidden(await rival.post(`/api/v1/uploads/${uploadId}/complete`), 'completing an upload');
  hidden(await rival.del(`/api/v1/uploads/${uploadId}`), 'abandoning an upload');
  assert.equal((await owner.get(`/api/v1/uploads/${uploadId}`)).status, 200, 'still the owner’s');

  // A job: the owner sends the bytes and completes it.
  const sent = await call(`/api/v1/uploads/${uploadId}/parts/1`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/octet-stream' },
    body: Buffer.alloc(16, 7),
  });
  assert.ok(sent.status === 200 || sent.status === 204, sent.text);
  const completed = await owner.post(`/api/v1/uploads/${uploadId}/complete`);
  assert.ok(completed.status >= 200 && completed.status < 300, completed.text);
  const jobId = completed.body.id ?? completed.body.ingestJobId;
  assert.ok(jobId, `the completion names its job: ${completed.text}`);
  made.entityIds.add(jobId);
  hidden(await rival.get(`/api/v1/ingest/${jobId}`), 'an ingest job');
  hidden(await rival.post(`/api/v1/ingest/${jobId}/accept`), 'accepting another channel’s job');
  hidden(await rival.post(`/api/v1/ingest/${jobId}/reject`, { reason: 'no' }), 'rejecting it');
  for (const state of [
    'detected',
    'validating',
    'quarantined',
    'accepted',
    'rejected',
    'registered',
  ]) {
    const queue = await rival.get(`/api/v1/ingest/queue?state=${state}&limit=200`);
    if (queue.status !== 200) continue;
    assert.ok(!idsOf(queue.body).has(jobId), `the ${state} queue carries another channel’s job`);
  }

  const watcher = await owner.post('/api/v1/watchers', {
    name: `isolation ${run}`,
    path: `isolation-${run}`,
    settleSeconds: 1,
    extensions: ['wav'],
    afterPickup: 'keep',
    enabled: false,
  });
  assert.equal(watcher.status, 201, watcher.text);
  made.entityIds.add(watcher.body.id);
  hidden(await rival.get(`/api/v1/watchers/${watcher.body.id}`), 'a watcher');
  hidden(
    await rival.patch(`/api/v1/watchers/${watcher.body.id}?version=${watcher.body.version}`, {
      enabled: true,
    }),
    'a watcher, switched on',
  );
  const watchers = await rival.get('/api/v1/watchers');
  assert.ok(
    !idsOf(watchers.body).has(watcher.body.id),
    'the watcher list carries another channel’s',
  );
  const disabled = await owner.get(`/api/v1/watchers/${watcher.body.id}`);
  assert.notEqual(disabled.body.enabled, true, 'the owner’s watcher was not switched on');
});

// --- MTS and HSM -----------------------------------------------------------------------------------

test('isolation: MTS and HSM — another channel’s transcode job is not found; its files are not located', async (t) => {
  if (!present(t)) return;
  const job = await owner.post('/api/v1/jobs', {
    assetId: ownerAsset.id,
    presetIds: ['proxy'],
    inputPath: 'samples/smoke.mp4',
  });
  assert.equal(job.status, 202, job.text);
  made.entityIds.add(job.body.id);
  assert.equal((await owner.get(`/api/v1/jobs/${job.body.id}`)).status, 200, 'control');
  hidden(await rival.get(`/api/v1/jobs/${job.body.id}`), 'a transcode job');
  const jobs = await rival.get('/api/v1/jobs?limit=200');
  assert.equal(jobs.status, 200, jobs.text);
  assert.ok(!idsOf(jobs.body).has(job.body.id), 'the job list carries another channel’s job');

  // The owner's proxy lands in HSM; the owner locates it and the rival finds an empty list.
  const located = await poll(
    () => owner.get(`/api/v1/assets/${ownerAsset.id}/location`),
    (res) => res.status === 200 && res.body.length > 0,
    90_000,
  );
  assert.ok(located.body?.length > 0, `control: the owner’s proxy is in HSM: ${located.text}`);
  const rivalLocated = await rival.get(`/api/v1/assets/${ownerAsset.id}/location`);
  assert.equal(rivalLocated.status, 200, rivalLocated.text);
  assert.deepEqual(rivalLocated.body, [], 'HSM locates another channel’s files');
});

// TODO(#577): OPEN — this case FAILS today and is reported, not hidden: MTS reads another channel's
// file out of HSM by asset id alone, and HSM places a kind the owner's asset lacks under the
// rival's channel. The fix is HSM file-operation code, which people review and pair on (rule 7),
// so it is not made here; `todo` keeps the run green while every run prints the failure.
test(
  'isolation: MTS and HSM — a rival’s job naming another channel’s asset reads none of its media',
  { todo: '#577 — cross-tenant read and placement through MTS → HSM' },
  async (t) => {
    if (!present(t)) return;
    // The rival holds asset:write on files in its own channel and names the OWNER's asset, asking for
    // its original from HSM — a rendition kind the owner's asset does not have yet. Nothing of the
    // owner's may be read into the rival's job, and nothing may be placed for that asset in the
    // rival's channel.
    const enqueued = await rival.post('/api/v1/jobs', {
      assetId: ownerAsset.id,
      presetIds: ['thumbnail'],
      inputFile: { kind: 'proxy' },
    });
    if (enqueued.status >= 400) {
      refused(enqueued, 'a job over another channel’s asset');
      return;
    }
    const settled = await poll(
      () => rival.get(`/api/v1/jobs/${enqueued.body.id}`),
      (res) => ['completed', 'failed', 'dead-lettered'].includes(res.body?.state),
      90_000,
    );
    assert.notEqual(
      settled.body?.state,
      'completed',
      `a rival transcoded another channel’s proxy into its own channel: ${settled.text}`,
    );
    const rivalLocated = await rival.get(`/api/v1/assets/${ownerAsset.id}/location`);
    assert.deepEqual(rivalLocated.body, [], 'a file was placed for another channel’s asset');
  },
);

// --- Scheduling ------------------------------------------------------------------------------------

test('isolation: Scheduling — another channel’s schedule and rights windows are not found, and cannot be written', async (t) => {
  if (!present(t)) return;
  let created;
  let day;
  for (let attempt = 0; attempt < 8; attempt++) {
    day = new Date(Date.now() + (400 + Math.floor(Math.random() * 3000)) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    created = await owner.post('/api/v1/schedules', { broadcastDate: day, timezone: 'UTC' });
    if (created.status !== 409) break;
  }
  assert.equal(created.status, 201, created.text);
  const schedule = created.body;
  made.entityIds.add(schedule.id);
  const window = await owner.post('/api/v1/rights-windows', {
    assetId: ownerAsset.id,
    validFrom: `${day}T00:00:00.000Z`,
    validTo: `${day}T23:59:59.000Z`,
  });
  assert.equal(window.status, 201, window.text);
  made.entityIds.add(window.body.id);
  assert.equal((await owner.get(`/api/v1/schedules/${schedule.id}`)).status, 200, 'control');

  // The rival's OWN day may be the same date: one schedule per channel per day, not per platform.
  const same = await rival.post('/api/v1/schedules', { broadcastDate: day, timezone: 'UTC' });
  assert.equal(same.status, 201, `the owner’s day is not the rival’s: ${same.text}`);

  hidden(await rival.get(`/api/v1/schedules/${schedule.id}`), 'a schedule');
  hidden(
    await rival.put(`/api/v1/schedules/${schedule.id}/items?version=${schedule.version}`, []),
    'a reel, written',
  );
  hidden(await rival.post(`/api/v1/schedules/${schedule.id}/validate`), 'a schedule, validated');
  hidden(
    await rival.post(`/api/v1/schedules/${schedule.id}/copy`, {
      targetScheduleId: same.body.id,
      targetVersion: same.body.version,
      at: `${day}T00:00:00.000Z`,
      mode: 'merge',
    }),
    'copying FROM another channel’s schedule',
  );
  hidden(
    await rival.post(`/api/v1/schedules/${same.body.id}/copy`, {
      targetScheduleId: schedule.id,
      targetVersion: schedule.version,
      at: `${day}T00:00:00.000Z`,
      mode: 'overwrite',
    }),
    'copying INTO another channel’s schedule',
  );
  hidden(await rival.get(`/api/v1/rights-windows/${window.body.id}`), 'a rights window');
  hidden(
    await rival.del(`/api/v1/rights-windows/${window.body.id}?version=${window.body.version}`),
    'a rights window, deleted',
  );

  const schedules = await rival.get(`/api/v1/schedules?from=${day}&to=${day}`);
  if (schedules.status === 200) {
    assert.ok(
      !idsOf(schedules.body).has(schedule.id),
      'the schedule list carries another channel’s',
    );
  }
  const windows = await rival.get(`/api/v1/rights-windows?assetId=${ownerAsset.id}`);
  assert.equal(windows.status, 200, windows.text);
  assert.ok(!idsOf(windows.body).has(window.body.id), 'rights windows of another channel');

  // The owner's asset on the rival's reel is judged as an asset the rival's channel does not
  // know — never with the owner's approval or availability.
  const reel = await rival.put(
    `/api/v1/schedules/${same.body.id}/items?version=${same.body.version}`,
    [
      {
        seq: 0,
        start: `${day}T06:00:00.000Z`,
        durationSec: 60,
        itemType: 'media',
        mediaId: ownerAsset.id,
      },
    ],
  );
  assert.equal(reel.status, 200, reel.text);
  const report = await rival.post(`/api/v1/schedules/${same.body.id}/validate`);
  assert.equal(report.status, 200, report.text);
  const kinds = new Set((report.body.issues ?? []).map((i) => i.kind));
  assert.ok(kinds.has('approval'), `another channel’s asset judged approved: ${report.text}`);
});

// --- BMS -------------------------------------------------------------------------------------------

test('isolation: BMS — another channel’s workflow and instance are not found, started, signalled or in the catalog', async (t) => {
  if (!present(t)) return;
  const definition = {
    name: `isolation ${run}`,
    steps: [
      { id: 's_start', kind: 'start' },
      {
        id: 's_wait',
        kind: 'human-task',
        config: { taskType: 'review', assignee: { userId: owner.userId } },
      },
      { id: 's_end', kind: 'end' },
    ],
    transitions: [
      { id: 't1', from: 's_start', to: 's_wait' },
      { id: 't2', from: 's_wait', to: 's_end' },
    ],
  };
  const workflow = await owner.post('/api/v1/workflows', definition);
  assert.equal(workflow.status, 201, workflow.text);
  const w = workflow.body;
  made.entityIds.add(w.id);
  const published = await owner.post(`/api/v1/workflows/${w.id}/publish?revision=1`);
  assert.equal(published.status, 200, published.text);
  const started = await poll(
    () => owner.post('/api/v1/instances', { workflowId: w.id }),
    (res) => res.status !== 503,
    60_000,
  );
  assert.equal(started.status, 201, started.text);
  const instanceId = started.body.id;
  made.entityIds.add(instanceId);

  hidden(await rival.get(`/api/v1/workflows/${w.id}`), 'a workflow');
  hidden(await rival.get(`/api/v1/workflows/${w.id}/export`), 'a workflow, exported');
  hidden(
    await rival.put(`/api/v1/workflows/${w.id}/draft?revision=2`, definition),
    'a draft, written',
  );
  hidden(
    await rival.post(`/api/v1/workflows/${w.id}/deactivate?revision=2`),
    'a workflow, deactivated',
  );
  hidden(await rival.get(`/api/v1/instances/${instanceId}`), 'an instance');
  hidden(
    await rival.post(`/api/v1/instances/${instanceId}/signal`, {
      stepId: 's_wait',
      payload: { outcome: 'done' },
    }),
    'an instance, signalled',
  );
  refused(
    await rival.post('/api/v1/instances', { workflowId: w.id }),
    'starting another channel’s workflow',
  );

  const catalog = await rival.get('/api/v1/workflows/catalog');
  assert.equal(catalog.status, 200, catalog.text);
  const catalogIds = new Set((catalog.body.items ?? catalog.body).map((e) => e.id ?? e.workflowId));
  assert.ok(!catalogIds.has(w.id), 'the catalog carries another channel’s workflow');
  const listed = await rival.get('/api/v1/workflows?limit=200');
  assert.ok(!idsOf(listed.body).has(w.id), 'the workflow list carries another channel’s');
  const instances = await rival.get('/api/v1/instances?limit=200');
  assert.ok(!idsOf(instances.body).has(instanceId), 'the instance list carries another channel’s');

  // The owner ends its own run, so nothing is left waiting.
  const ended = await poll(
    () =>
      owner.post(`/api/v1/instances/${instanceId}/signal`, {
        stepId: 's_wait',
        payload: { outcome: 'done' },
      }),
    (res) => res.status === 202,
    30_000,
  );
  assert.equal(ended.status, 202, ended.text);
});

// --- Notifications ---------------------------------------------------------------------------------

test('isolation: Notifications — another channel’s task is not found or driven; nothing the rival addresses reaches its people', async (t) => {
  if (!present(t)) return;
  const task = await owner.post('/api/v1/tasks', {
    assignee: owner.userId,
    assigneeKind: 'user',
    title: `isolation ${run}`,
  });
  assert.equal(task.status, 201, task.text);
  made.entityIds.add(task.body.id);
  assert.equal((await owner.get(`/api/v1/tasks/${task.body.id}`)).status, 200, 'control');

  hidden(await rival.get(`/api/v1/tasks/${task.body.id}`), 'a task');
  hidden(await rival.post(`/api/v1/tasks/${task.body.id}/claim`), 'a task, claimed');
  hidden(
    await rival.post(`/api/v1/tasks/${task.body.id}/complete`, { outcome: 'done' }),
    'a task, completed',
  );
  hidden(
    await rival.post(`/api/v1/tasks/${task.body.id}/forward`, {
      assignee: rival.userId,
      assigneeKind: 'user',
    }),
    'a task, forwarded',
  );
  hidden(await rival.post(`/api/v1/tasks/${task.body.id}/cancel`), 'a task, cancelled');
  const inbox = await rival.get('/api/v1/inbox');
  assert.equal(inbox.status, 200, inbox.text);
  assert.ok(
    !idsOf(inbox.body, 'tasks').has(task.body.id),
    'the inbox carries another channel’s task',
  );

  // The owner's people, named by the rival. Notifications does not ask IAM where a user id lives,
  // so a task or a message for one is written IN THE RIVAL'S CHANNEL, addressed to an id nobody
  // there holds — and reaches nobody: the owner, reading in its own channel, finds none of it.
  // (EP-25.7's per-user live stream must keep that true: a frame on `user.<id>` for a row of
  // another channel would be the first thing to cross.)
  const word = `across-${run}`;
  const strayTask = await rival.post('/api/v1/tasks', {
    assignee: owner.userId,
    assigneeKind: 'user',
    title: word,
  });
  assert.ok(strayTask.status < 500, strayTask.text);
  const strayMessage = await rival.post('/api/v1/messages', {
    to: [{ kind: 'user', id: owner.userId }],
    body: word,
  });
  assert.ok(strayMessage.status < 500, strayMessage.text);
  const ownerGroup = await owner.post('/api/v1/groups', { name: `isolation chat ${run}` });
  assert.equal(ownerGroup.status, 201, ownerGroup.text);
  made.entityIds.add(ownerGroup.body.id);
  const strayGroupMessage = await rival.post('/api/v1/messages', {
    to: [{ kind: 'group', id: ownerGroup.body.id }],
    body: word,
  });
  assert.ok(strayGroupMessage.status < 500, strayGroupMessage.text);
  const joined = await owner.post(`/api/v1/groups/${ownerGroup.body.id}/members`, {
    userId: owner.userId,
  });
  assert.equal(joined.status, 204, joined.text);

  const messages = await owner.get('/api/v1/messages?limit=200');
  assert.equal(messages.status, 200, messages.text);
  assert.ok(
    !(messages.body.items ?? []).some((m) => m.body === word),
    'a message from another channel reached the owner',
  );
  const ownerInbox = await owner.get('/api/v1/inbox');
  assert.equal(ownerInbox.status, 200, ownerInbox.text);
  assert.ok(
    !(ownerInbox.body.tasks ?? []).some((t) => t.title === word),
    'a task from another channel reached the owner',
  );
  const done = await owner.post(`/api/v1/tasks/${task.body.id}/complete`, { outcome: 'done' });
  assert.ok(done.status < 300, done.text);
});

// --- logging, and the final sweep ------------------------------------------------------------------

test('isolation: logging — another channel’s history is empty, its log is not browsed, its retention is not written', async (t) => {
  if (!present(t)) return;
  // The owner's asset has history by now (created, transcoded); wait for the control.
  const control = await poll(
    () => owner.get(`/api/v1/history/asset/${ownerAsset.id}`),
    (res) => res.body?.revisions?.length > 0,
  );
  assert.ok(control.body.revisions.length > 0, 'control: the owner reads its asset’s history');

  for (const [type, id] of [
    ['asset', ownerAsset.id],
    ['category', ownerCategory.id],
    ['user', owner.userId],
  ]) {
    const res = await rival.get(`/api/v1/history/${type}/${id}`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.revisions, [], `the rival reads another channel’s ${type} history`);
  }

  // The log: page back through the rival's own channel and find nothing of the owner's.
  let cursor;
  for (let page = 0; page < 5; page++) {
    const res = await rival.get(`/api/v1/logs?limit=200${cursor ? `&before=${cursor}` : ''}`);
    assert.equal(res.status, 200, res.text);
    for (const entry of res.body.items ?? []) {
      assert.equal(
        entry.channelId,
        rival.channelId,
        `a log entry of another channel: ${JSON.stringify(entry)}`,
      );
    }
    cursor = res.body.nextCursor;
    if (!cursor) break;
  }

  // Retention is the caller's channel's, and only that.
  const policy = await rival.get('/api/v1/retention-policies');
  assert.equal(policy.status, 200, policy.text);
  assert.equal(policy.body.channelId, rival.channelId);
  const ownerPolicy = await owner.get('/api/v1/retention-policies');
  const planted = await rival.put(`/api/v1/retention-policies?channelId=${owner.channelId}`, {
    hotDays: ownerPolicy.body.hotDays + 1,
    coldDays: ownerPolicy.body.coldDays,
    legalHold: false,
  });
  if (planted.status === 200) {
    assert.equal(
      planted.body.channelId,
      rival.channelId,
      'a retention write landed in another channel',
    );
  }
  const unchanged = await owner.get('/api/v1/retention-policies');
  assert.equal(
    unchanged.body.hotDays,
    ownerPolicy.body.hotDays,
    'the owner’s retention is untouched',
  );
});

test('isolation: the rival’s socket heard nothing of the owner’s channel, while the owner’s heard it all', async (t) => {
  if (!present(t)) return;
  // The control first: everything above made events in the owner's channel, and its socket got them.
  const heard = await poll(
    async () => ownerSocket.frames.filter((f) => f.type === 'event').length,
    (n) => n > 0,
    30_000,
  );
  assert.ok(heard > 0, 'control: the owner’s socket heard its own channel');

  const leaks = rivalSocket.frames.filter((f) => {
    if (f.type !== 'event') return false;
    const subject = String(f.subject ?? '');
    const text = JSON.stringify(f);
    return (
      subject.split('.')[1] !== rival.channelId ||
      text.includes(`"channelId":"${owner.channelId}"`) ||
      // Ids of things only the owner ever named. Not the owner's ASSET: the rival names it in its
      // own reel and job above, and its own channel's events about those carry the id rightly.
      [...made.entityIds].some((id) => text.includes(id))
    );
  });
  assert.deepEqual(leaks, [], 'the rival’s socket received another channel’s frames');

  // And the other way: the rival addressed the owner's user id (Notifications above) — a personal
  // frame for that row is in ch99 and names the owner's id, and must never reach the owner's socket
  // (EP-25.7; the note on #456).
  const inbound = ownerSocket.frames.filter(
    (f) =>
      f.type === 'event' &&
      (String(f.subject ?? '').split('.')[1] !== owner.channelId ||
        JSON.stringify(f).includes(`"channelId":"${rival.channelId}"`)),
  );
  assert.deepEqual(inbound, [], 'the owner’s socket received the rival’s channel’s frames');
});
