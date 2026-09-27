// The recorder worker's process (EP-39; ADR-0007): the `rim-recorder` StatefulSet runs this — RIM's
// image with another command. It shares RIM's Postgres schema (it is RIM's own worker, EP-07.6:
// one owner per schema) and hands every file to RIM through the SIGNED internal routes (ADR-0008);
// it never reaches the broker or the gateway.
//
// Its pod name is its lease holder. A StatefulSet keeps that name — and the pod's own volume —
// across restarts, which is what lets a restarted worker find the partial file it was writing and
// hand it over.

import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { migrate, openPool } from '@atlas/data-pg';
import {
  createLogger,
  HealthRegistry,
  internalKeys,
  loadConfig,
  MetricRegistry,
} from '@atlas/service-kit';
import {
  ffmpegCapturer,
  httpHandOff,
  pgMigrations,
  pgRimStore,
  RecorderWorker,
  type Recorder,
} from './index.ts';

const config = loadConfig({
  port: { env: 'PORT', type: 'number', default: 3000 },
  host: { env: 'HOST', type: 'string', default: '0.0.0.0' },
  databaseUrl: {
    env: 'ATLAS_PG_URL',
    type: 'string',
    default: 'postgres://atlas:atlas@postgres:5432/atlas',
  },
  // RIM's schema: the worker is RIM's, and reads and leases RIM's captures.
  pgSchema: { env: 'ATLAS_PG_SCHEMA', type: 'string', default: 'rim' },
  // RIM itself, directly — the gateway does not route /internal/ (ADR-0008).
  rimOrigin: { env: 'ATLAS_RIM_ORIGIN', type: 'string', default: 'http://rim:3000' },
  internalKeys: { env: 'ATLAS_RIM_INTERNAL_KEYS', type: 'string', default: '' },
  // The pod's own volume: files wait here until RIM has them.
  workDir: { env: 'ATLAS_RECORDER_WORK_DIR', type: 'string', default: '/var/lib/atlas/recorder' },
  // Where the install mounts passphrase Secrets: `<dir>/<secret>/<key>` — a recorder names
  // `<secret>/<key>` in `input.passphraseSecret`, and never holds the passphrase itself.
  passphraseDir: {
    env: 'ATLAS_RECORDER_PASSPHRASE_DIR',
    type: 'string',
    default: '/var/run/atlas/passphrases',
  },
  ffmpegBin: { env: 'ATLAS_FFMPEG_BIN', type: 'string', default: 'ffmpeg' },
  tickMs: { env: 'ATLAS_RECORDER_TICK_MS', type: 'number', default: 1_000 },
});

const log = createLogger('rim-recorder');
const keys = internalKeys(config.internalKeys);
if (keys.length === 0) {
  // Without a key no file can ever be handed over: recording would fill the disk and go nowhere.
  log.error('ATLAS_RIM_INTERNAL_KEYS is empty — the recorder worker cannot hand files to RIM');
  process.exit(1);
}
const holder = process.env['HOSTNAME'] ?? hostname();

const pool = openPool({ connectionString: config.databaseUrl, schema: config.pgSchema });
// RIM migrates its schema; the worker takes the same lock, so whichever starts first does it once.
for (let attempt = 1, deadline = Date.now() + 120_000; ; attempt += 1) {
  try {
    await migrate(pool, pgMigrations);
    break;
  } catch (err) {
    if (Date.now() >= deadline) throw err;
    log.warn('database unavailable, retrying', { attempt, error: (err as Error).message });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

const metrics = new MetricRegistry();
const active = metrics.gauge({
  name: 'atlas_recorder_active_captures',
  help: 'Captures this worker is recording now.',
});
// A closed label set: what happened, never which recorder or which feed.
const events = metrics.counter({
  name: 'atlas_recorder_events_total',
  help: 'Capture outcomes on this worker.',
  labelNames: ['event'],
});
const EVENTS = new Set([
  'capture started',
  'capture completed',
  'capture ended early',
  'capture handed over',
  'hand-off failed',
]);

/** The feed's URL, with an SRT passphrase read from its Secret's file — never logged. */
async function feedUrl(recorder: Recorder): Promise<string> {
  const ref = recorder.input.passphraseSecret;
  if (!ref) return recorder.input.url;
  const [secret, key] = ref.split('/') as [string, string];
  const passphrase = (await readFile(join(config.passphraseDir, secret, key), 'utf8')).trim();
  const url = new URL(recorder.input.url);
  url.searchParams.set('passphrase', passphrase);
  return url.toString();
}

const worker = new RecorderWorker({
  store: pgRimStore(pool),
  capturer: ffmpegCapturer({ binary: config.ffmpegBin }),
  handOff: httpHandOff({ origin: config.rimOrigin, key: keys[0]! }),
  holder,
  workDir: config.workDir,
  feedUrl,
  onEvent: (level, message, context) => {
    if (EVENTS.has(message)) events.inc({ event: message });
    log[level](message, context);
  },
});

const health = new HealthRegistry().register(
  'postgres',
  async () =>
    await pool
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false),
  { critical: true },
);
const app = Fastify({ logger: false });
app.get('/healthz', async () => health.liveness());
app.get('/readyz', async (_req, reply) => {
  const report = await health.readiness();
  return reply.code(report.status === 'ready' ? 200 : 503).send(report);
});
app.get('/metrics', async (_req, reply) => {
  active.set({}, worker.active);
  return reply.header('content-type', metrics.contentType).send(metrics.expose());
});

let timer: NodeJS.Timeout | undefined;
let stopping = false;
const loop = async (): Promise<void> => {
  try {
    await worker.tick();
  } catch (err) {
    log.error('recorder pass failed', { error: (err as Error).message });
  }
  if (!stopping) timer = setTimeout(() => void loop(), config.tickMs);
};
void loop();

await app.listen({ port: config.port, host: config.host });
log.info('rim-recorder running', { holder, port: config.port });

// SIGTERM: stop recording — FFmpeg finishes each file — mark each capture partial and continue it,
// so the other worker takes the rest of every span at once. The files stay on this pod's volume.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, draining`);
    stopping = true;
    if (timer) clearTimeout(timer);
    void worker
      .drain()
      .then(() => app.close())
      .then(() => pool.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}
