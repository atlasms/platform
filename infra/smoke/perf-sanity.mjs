// EP-21.4 — performance SANITY against the MVP-relevant NFRs, on a DEPLOYED environment.
//
//   npm run k8s:up && npm run perf
//   ATLAS_BASE_URL=https://atlas.example ATLAS_WS_URL=wss://atlas.example npm run perf
//
// Sanity, not certification. docs/requirements/06 asks for load tests "against the baseline scenario
// in a CI-adjacent perf env"; that environment and its multi-million-asset library do not exist yet.
// What this proves is the SHAPE: that with the MVP's 40 concurrent Studio users (NFR-PERF-8) working
// at a Studio pace, the platform's reads (NFR-PERF-1), simple search (NFR-PERF-2) and live updates
// (NFR-PERF-3) meet their targets on the environment it runs against — and that none of the 40 is
// refused (a 429) or failed (a 5xx) on the way. Run on a kind cluster on one machine, a miss is a
// real signal: production hardware only makes these numbers better, never worse.
//
// The load is 40 DISTINCT principals (perf-vu-01..40, created through IAM's admin API on first use
// and reused after), not one token 40 times: the gateway limits each principal to 300/min, and one
// account doing 40 people's work would be measuring that limit rather than the platform. Each user
// issues one Studio request every THINK_MS (default 6 s, jittered): ~400/min across all 40, under the
// gateway's per-address limit (600/min per replica) — the building's budget, which a facility of 40
// shares, and which is why a 429 here is reported as a finding rather than retried.
//
// Plain .mjs, no @atlas/* imports, HTTP and WebSocket only — the smoke suite's rules.

import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const BASE = process.env.ATLAS_BASE_URL ?? 'http://localhost:30080';
const WS_BASE = process.env.ATLAS_WS_URL ?? 'ws://localhost:30081';
const USERS = Number(process.env.ATLAS_PERF_USERS ?? 40);
const DURATION_MS = Number(process.env.ATLAS_PERF_DURATION_MS ?? 60_000);
const THINK_MS = Number(process.env.ATLAS_PERF_THINK_MS ?? 6_000);
const LIVE_SAMPLES = Number(process.env.ATLAS_PERF_LIVE_SAMPLES ?? 20);
const PASSWORD = process.env.ATLAS_PERF_PASSWORD ?? 'perf-vu-password-not-a-secret';

/** The MVP targets this checks (docs/requirements/06-non-functional-requirements.md). */
const TARGETS = {
  read: { nfr: 'NFR-PERF-1', p95: 300, p99: 800 },
  search: { nfr: 'NFR-PERF-2', p95: 500 },
  live: { nfr: 'NFR-PERF-3', p95: 1_000 },
};

async function call(path, init = {}) {
  const started = performance.now();
  const response = await fetch(new URL(path, BASE), {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, text, body, ms: performance.now() - started };
}

const json = (token) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

async function login(username, password) {
  const res = await call('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return res.status === 200 ? res.body.accessToken : undefined;
}

/** The 40 users: created once, granted reads in the admin's channel, reused by every later run. */
async function principals(admin) {
  const channel = JSON.parse(
    Buffer.from(admin.split('.')[1], 'base64url').toString('utf8'),
  ).channelId;
  const tokens = [];
  for (let i = 1; i <= USERS; i++) {
    const username = `perf-vu-${String(i).padStart(2, '0')}`;
    let token = await login(username, PASSWORD);
    if (!token) {
      const created = await call('/api/v1/users', {
        method: 'POST',
        headers: json(admin),
        body: JSON.stringify({ username, password: PASSWORD, name: `Perf user ${i}` }),
      });
      if (created.status !== 201) throw new Error(`creating ${username}: ${created.text}`);
      const grant = await call(`/api/v1/users/${created.body.id}/assignments`, {
        method: 'POST',
        headers: json(admin),
        body: JSON.stringify({
          rule: {
            id: `perf-read-${i}`,
            description: 'EP-21.4 perf sanity: what a Studio reader does',
            permissions: ['asset:read', 'schedule:read', 'ingest:read', 'taxonomy:read'],
            scope: { channelIds: [channel] },
          },
        }),
      });
      if (grant.status !== 201) throw new Error(`granting ${username}: ${grant.text}`);
      token = await login(username, PASSWORD);
    }
    if (!token) throw new Error(`${username} cannot sign in`);
    tokens.push(token);
  }
  return { channel, tokens };
}

/** Assets to read and a word to search for — made by the admin, once per run. */
async function library(admin, word) {
  // A real category (#260): found by its path, or made once.
  const listed = await call('/api/v1/categories', { headers: json(admin) });
  let categoryId = listed.body?.find((c) => c.path === '/perf/')?.id;
  if (!categoryId) {
    const made = await call('/api/v1/categories', {
      method: 'POST',
      headers: json(admin),
      body: JSON.stringify({ key: 'perf', labels: { en: 'Performance sanity' } }),
    });
    if (made.status !== 201) throw new Error(`category create: ${made.text}`);
    categoryId = made.body.id;
  }
  const ids = [];
  for (let i = 0; i < 30; i++) {
    const res = await call('/api/v1/assets', {
      method: 'POST',
      headers: json(admin),
      body: JSON.stringify({
        title: `Perf ${word} bulletin ${i}`,
        description: `Evening news item ${i} for the performance sanity run`,
        mediaType: 'video',
        fileType: 'mxf',
        categoryId,
      }),
    });
    if (res.status !== 201) throw new Error(`asset create: ${res.text}`);
    ids.push(res.body.id);
  }
  return ids;
}

/** One Studio request, chosen as a Studio session would: mostly reads, some search. */
function studioRequest(ids, word) {
  const id = ids[Math.floor(Math.random() * ids.length)];
  const roll = Math.random();
  if (roll < 0.25) return ['read', '/api/v1/assets?limit=50'];
  if (roll < 0.5) return ['read', `/api/v1/assets/${id}`];
  if (roll < 0.6) return ['read', `/api/v1/assets/${id}/files`];
  if (roll < 0.7) return ['read', '/api/v1/ingest/queue?limit=50'];
  if (roll < 0.8) return ['read', '/api/v1/schedules?limit=20'];
  if (roll < 0.85) return ['read', '/api/v1/jobs?limit=20'];
  const q = roll < 0.95 ? word : `bulletin ${word.slice(0, 4)}`;
  return ['search', `/api/v1/search?q=${encodeURIComponent(q)}&limit=50`];
}

function percentile(values, p) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function virtualUser(token, ids, word, until, samples, refusals) {
  // Staggered start, so 40 users do not arrive in the same millisecond.
  await new Promise((r) => setTimeout(r, Math.random() * THINK_MS));
  while (Date.now() < until) {
    const [kind, path] = studioRequest(ids, word);
    try {
      const res = await call(path, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 200) samples[kind].push(res.ms);
      else refusals.push(`${res.status} ${path.split('?')[0]}`);
    } catch (err) {
      refusals.push(`error ${path.split('?')[0]}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, THINK_MS * (0.5 + Math.random())));
  }
}

/** Write → frame on a live socket, under load: the time from the write's response to the event. */
async function liveLatency(admin, channel, until) {
  const socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(admin)}`);
  const arrivals = new Map();
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'event') return;
    const assetId = frame.payload?.payload?.assetId;
    if (assetId && !arrivals.has(assetId)) arrivals.set(assetId, performance.now());
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`no socket at ${WS_BASE}/ws`)), {
      once: true,
    });
  });
  const pattern = `atlas.${channel}.asset.>`;
  socket.send(JSON.stringify({ type: 'subscribe', pattern }));
  await new Promise((r) => setTimeout(r, 500));
  const latencies = [];
  const gap = Math.max(500, (until - Date.now()) / (LIVE_SAMPLES + 1));
  try {
    for (let i = 0; i < LIVE_SAMPLES && Date.now() < until; i++) {
      await new Promise((r) => setTimeout(r, gap));
      const res = await call('/api/v1/assets', {
        method: 'POST',
        headers: json(admin),
        body: JSON.stringify({ title: `Perf live ${i}`, mediaType: 'video', fileType: 'mxf' }),
      });
      if (res.status !== 201) continue;
      // Measured from the moment the write was acknowledged — what a person who just clicked Save
      // waits for on everyone else's screen.
      const written = performance.now();
      const deadline = written + 10_000;
      while (!arrivals.has(res.body.id) && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      latencies.push(arrivals.has(res.body.id) ? arrivals.get(res.body.id) - written : Infinity);
    }
  } finally {
    socket.close();
  }
  return latencies;
}

const admin = await login(
  process.env.ATLAS_SMOKE_USER ?? 'dev',
  process.env.ATLAS_SMOKE_PASSWORD ?? 'dev-password',
);
if (!admin) {
  console.log('no seed account in this environment — perf sanity skipped');
  process.exit(0);
}

const word = `perf${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}`;
console.log(
  `perf sanity: ${USERS} users, ${DURATION_MS / 1000}s, one request per ~${THINK_MS / 1000}s each`,
);
const { channel, tokens } = await principals(admin);
const ids = await library(admin, word);

const until = Date.now() + DURATION_MS;
const samples = { read: [], search: [] };
const refusals = [];
const [live] = await Promise.all([
  liveLatency(admin, channel, until),
  ...tokens.map((token) => virtualUser(token, ids, word, until, samples, refusals)),
]);

const rows = [];
const misses = [];
const row = (name, values, target) => {
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  const p99 = percentile(values, 99);
  const ok =
    values.length > 0 &&
    (target.p95 === undefined || p95 <= target.p95) &&
    (target.p99 === undefined || p99 <= target.p99);
  if (!ok) misses.push(`${target.nfr} ${name}`);
  const goal = [target.p95 && `p95 < ${target.p95}`, target.p99 && `p99 < ${target.p99}`]
    .filter(Boolean)
    .join(', ');
  const ms = (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : 'never');
  rows.push(
    `| ${target.nfr} | ${name} | ${values.length} | ${ms(p50)} | ${ms(p95)} | ${ms(p99)} | ${goal} | ${ok ? '✅' : '❌'} |`,
  );
};
row('Studio reads', samples.read, TARGETS.read);
row('simple search', samples.search, TARGETS.search);
row('write → live frame', live, TARGETS.live);

const total = samples.read.length + samples.search.length;
const report = [
  `### Performance sanity (EP-21.4) — ${BASE}`,
  '',
  `${USERS} concurrent users (NFR-PERF-8, MVP ≥ 40) for ${DURATION_MS / 1000} s: ${total} requests answered, ${refusals.length} refused or failed.`,
  '',
  '| NFR | What | n | p50 | p95 | p99 | Target (MVP) | |',
  '|---|---|---|---|---|---|---|---|',
  ...rows,
  '',
  refusals.length > 0
    ? `Refused or failed: ${[...new Set(refusals)].slice(0, 10).join('; ')}`
    : 'No request was refused (429) or failed (5xx).',
].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

if (refusals.length > 0) misses.push(`NFR-PERF-8 (${refusals.length} requests refused or failed)`);
if (misses.length > 0) {
  console.error(`\nMISSED: ${misses.join('; ')}`);
  process.exit(1);
}
