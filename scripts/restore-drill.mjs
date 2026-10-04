// EP-21.3 — the first restore drill, rehearsed: back up, DESTROY, reinstall, restore, verify.
//
//   npm run k8s:up && npm run acceptance    # a cluster with a journey's worth of data in it
//   npm run drill -- --yes                  # DESTROYS the `atlas` namespace on kind-atlas-dev
//   npm run drill -- --yes --from-backup    # restore again from the backup in tmp/drill
//
// The runbook (docs/operations/17-operations-runbook.md §5) says a restore is not done until the
// smoke suite passes against it, and asks for a drill before GA. This is that drill, on the dev
// cluster, as a LOGICAL backup — `pg_dump` of the one database every service's schema lives in, and
// the bytes of HSM's online tier — because that is what exists. The runbook's production method is
// continuous WAL archiving with point-in-time recovery (RPO < 5 min); standing that up is its own
// decision (a tool and an archive target, an ADR) and this drill does not pretend to be it. What it
// does prove is the ORDER and the INVARIANTS a restore has to get right whatever the backup method:
//
//   1. quiesce: every service's outbox drained, then every service stopped — so the dump holds no
//      event that is half-announced, and nothing writes while it is taken;
//   2. back up Postgres (all schemas) and HSM's online tier, and fingerprint what was there:
//      row counts per table, the audit log's per-channel chain heads, every live file's checksum;
//   3. destroy the namespace — volumes and all — and reinstall from the same manifests;
//   4. restore in the runbook's order: the data plane first, the database before any service
//      starts, HSM's bytes before anything reads them;
//   5. verify BEFORE the services run (so nothing they write muddies the comparison): the same rows,
//      the same chain heads, and every ledger file's bytes hashing to the ledger's checksum;
//   6. start the services — OpenSearch is NOT restored: the projector rebuilds the hot index from
//      Postgres, which is the claim ADR-0005 makes — and run the smoke suite and the MVP journey.
//
// JetStream is not backed up: what the quiesce drained has been delivered, and a consumer's cursor
// starts again on an empty stream. The timings are printed: destroy-to-green is this cluster's RTO.

import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const NS = 'atlas';
const CONTEXT = 'kind-atlas-dev';
const OUT = join(ROOT, 'tmp', 'drill');
const SERVICES = [
  'api-gateway',
  'iam',
  'mam',
  'websocket',
  'logging',
  'scheduling',
  'rim',
  'mts',
  'hsm',
];
const SCHEMAS = ['iam', 'mam', 'logging', 'scheduling', 'rim', 'mts', 'hsm'];
/** The schemas with an outbox — logging is the sink, and appends directly. */
const OUTBOXES = SCHEMAS.filter((s) => s !== 'logging');

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const step = (text) => console.log(`\n[${elapsed()}] ${text}`);

function kubectl(args, options = {}) {
  return execFileSync('kubectl', ['--context', CONTEXT, '-n', NS, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 << 20,
    ...options,
  });
}
const psql = (sql) =>
  kubectl(['exec', 'postgres-0', '--', 'psql', '-U', 'atlas', '-d', 'atlas', '-tAc', sql]).trim();

function npm(script) {
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (run.status !== 0) throw new Error(`npm run ${script} failed against the restored cluster`);
}

function waitFor(what, check, budgetMs = 600_000) {
  const deadline = Date.now() + budgetMs;
  let last;
  for (;;) {
    try {
      if (check()) return;
    } catch (err) {
      // Not yet — but kept: a wait that times out on a broken query should say so, not just wait.
      last = err;
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)']);
  }
}

function scale(names, replicas) {
  for (const name of names) {
    kubectl(['scale', `deployment/${name}`, `--replicas=${replicas}`]);
  }
}
/** The recorder workers plan and lease captures in RIM's tables — they are writers too. */
const scaleRecorders = (replicas) =>
  kubectl(['scale', 'statefulset/rim-recorder', `--replicas=${replicas}`]);

/** Rows per table in every service schema, the audit chain heads, and the live files' checksums. */
function fingerprint() {
  const tables = psql(
    `select table_schema||'.'||table_name from information_schema.tables
     where table_schema in (${SCHEMAS.map((s) => `'${s}'`).join(',')}) and table_type='BASE TABLE'
     order by 1`,
  )
    .split('\n')
    .filter(Boolean);
  const counts = Object.fromEntries(
    tables.map((t) => [t, Number(psql(`select count(*) from ${t}`))]),
  );
  const heads = psql(
    `select channel_id||' '||seq||' '||hash from logging.audit_events a
     where seq = (select max(seq) from logging.audit_events b where b.channel_id = a.channel_id)
     order by channel_id`,
  );
  const files = psql(
    `select f.data->'storage'->>'path'||' '||(f.data->'checksum'->>'value')||' '||(t.data->>'root')
     from hsm.files f join hsm.storage_targets t on t.id = f.target_id
     where f.deleted_at is null and t.data->>'kind' = 'fs' order by 1`,
  )
    .split('\n')
    .filter(Boolean);
  return { counts, heads, files };
}

function same(label, before, after) {
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  if (a !== b) throw new Error(`${label} differs after the restore:\nbefore ${a}\nafter  ${b}`);
  console.log(`  ✔ ${label}`);
}

// --- guard -------------------------------------------------------------------

if (!process.argv.includes('--yes')) {
  console.error(
    `This DESTROYS the "${NS}" namespace on ${CONTEXT}, volumes included, and restores it from a ` +
      'backup it takes first. Run it as `npm run drill -- --yes`.',
  );
  process.exit(2);
}
const contexts = execFileSync('kubectl', ['config', 'get-contexts', '-o', 'name'], {
  encoding: 'utf8',
});
if (!contexts.split('\n').includes(CONTEXT)) {
  console.error(`no kubectl context ${CONTEXT} — the drill only runs against the kind dev cluster`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const dumpFile = join(OUT, 'atlas.dump');
const tarFile = join(OUT, 'hsm-online.tar');
const fingerprintFile = join(OUT, 'fingerprint.json');
const fromBackup = process.argv.includes('--from-backup');
let before;

if (fromBackup) {
  step(`restore from the backup already in ${OUT}`);
  before = JSON.parse(readFileSync(fingerprintFile, 'utf8'));
} else {
  // --- 1. quiesce --------------------------------------------------------------

  step('quiesce: wait for every outbox to drain, then stop every service');
  waitFor('every outbox to drain', () =>
    OUTBOXES.every((s) => psql(`select count(*) from ${s}.outbox where sent_at is null`) === '0'),
  );
  // HSM stays up for its bytes; everything else stops writing.
  scale(
    SERVICES.filter((s) => s !== 'hsm'),
    0,
  );
  scaleRecorders(0);
  waitFor('the services to stop', () =>
    kubectl(['get', 'pods', '-o', 'name'])
      .split('\n')
      .every(
        (p) =>
          !/pod\/(api-gateway|iam|mam|websocket|logging|scheduling|rim|mts|rim-recorder)-/.test(p),
      ),
  );
  // HSM's own queue (copies, moves, releases) must be idle, then it stops writing too.
  waitFor('HSM operations to settle', () =>
    ['0', ''].includes(
      psql(`select count(*) from hsm.operations where state in ('queued','running')`),
    ),
  );

  // --- 2. back up and fingerprint ----------------------------------------------

  step('back up: pg_dump of the whole database, the bytes of HSM’s online tier');
  before = fingerprint();
  {
    const fd = openSync(dumpFile, 'w');
    try {
      execFileSync(
        'kubectl',
        [
          '--context',
          CONTEXT,
          '-n',
          NS,
          'exec',
          'postgres-0',
          '--',
          'pg_dump',
          '-U',
          'atlas',
          '-Fc',
          'atlas',
        ],
        { stdio: ['ignore', fd, 'inherit'], maxBuffer: 1 << 30 },
      );
    } finally {
      closeSync(fd);
    }
  }
  {
    const fd = openSync(tarFile, 'w');
    try {
      execFileSync(
        'kubectl',
        [
          '--context',
          CONTEXT,
          '-n',
          NS,
          'exec',
          'deploy/hsm',
          '--',
          'tar',
          '-C',
          '/storage',
          '-cf',
          '-',
          'online',
        ],
        { stdio: ['ignore', fd, 'inherit'], maxBuffer: 1 << 30 },
      );
    } finally {
      closeSync(fd);
    }
  }
  writeFileSync(fingerprintFile, JSON.stringify(before, null, 2));
  console.log(
    `  database ${(statSync(dumpFile).size / 1e6).toFixed(1)} MB, HSM online tier ` +
      `${(statSync(tarFile).size / 1e6).toFixed(1)} MB; ${Object.keys(before.counts).length} tables, ` +
      `${before.files.length} live files, chain heads:\n    ${before.heads.split('\n').join('\n    ')}`,
  );
}

// --- 3. destroy and reinstall ------------------------------------------------

const destroyed = Date.now();
step(`destroy: delete namespace "${NS}" (volumes included)`);
execFileSync('kubectl', ['--context', CONTEXT, 'delete', 'namespace', NS, '--wait=true'], {
  stdio: 'inherit',
});

step('reinstall from the same manifests, services held at zero');
execFileSync(
  'kubectl',
  ['--context', CONTEXT, 'apply', '-k', join(ROOT, 'infra/k8s/overlays/dev')],
  {
    stdio: 'ignore',
  },
);
scale(SERVICES, 0);
scaleRecorders(0);
kubectl(['rollout', 'status', 'statefulset/postgres', '--timeout=300s'], { stdio: 'inherit' });
waitFor('Postgres to accept connections', () => psql('select 1') === '1');

// --- 4. restore, data plane first --------------------------------------------

step('restore: the database (fresh, then pg_restore), before any service starts');
psql('select 1'); // connection proven
kubectl(['exec', 'postgres-0', '--', 'dropdb', '-U', 'atlas', '--if-exists', '--force', 'atlas']);
kubectl(['exec', 'postgres-0', '--', 'createdb', '-U', 'atlas', 'atlas']);
{
  const fd = openSync(dumpFile, 'r');
  try {
    execFileSync(
      'kubectl',
      [
        '--context',
        CONTEXT,
        '-n',
        NS,
        'exec',
        '-i',
        'postgres-0',
        '--',
        'pg_restore',
        '-U',
        'atlas',
        '-d',
        'atlas',
        '--no-owner',
      ],
      { stdio: [fd, 'inherit', 'inherit'] },
    );
  } finally {
    closeSync(fd);
  }
}

step('restore: HSM’s online tier, before anything reads it');
scale(['hsm'], 1);
// STARTED, not Ready: HSM's readiness asks IAM, and IAM is held at zero until the data is back —
// the restore order the runbook prescribes. The container running is all `tar` needs.
waitFor(
  'HSM to start',
  () =>
    kubectl([
      'get',
      'pods',
      '-l',
      'app.kubernetes.io/name=hsm',
      '-o',
      'jsonpath={.items[*].status.containerStatuses[0].started}',
    ]).trim() === 'true',
);
{
  const fd = openSync(tarFile, 'r');
  try {
    execFileSync(
      'kubectl',
      [
        '--context',
        CONTEXT,
        '-n',
        NS,
        'exec',
        '-i',
        'deploy/hsm',
        '--',
        'tar',
        '-C',
        '/storage',
        '-xf',
        '-',
      ],
      { stdio: [fd, 'inherit', 'inherit'] },
    );
  } finally {
    closeSync(fd);
  }
}

// --- 5. verify before the services write anything ---------------------------

step(
  'verify: the same rows, the same audit chain, every file’s bytes hashing to its ledger checksum',
);
const after = fingerprint();
same(`row counts of ${Object.keys(before.counts).length} tables`, before.counts, after.counts);
same('audit chain heads (seq and hash, per channel)', before.heads, after.heads);
same('the live file ledger', before.files, after.files);
let checked = 0;
for (const line of after.files) {
  const [path, checksum, root] = line.split(' ');
  const out = kubectl(['exec', 'deploy/hsm', '--', 'sha256sum', `${root}/${path}`]).split(' ')[0];
  if (out !== checksum)
    throw new Error(`${path}: bytes hash to ${out}, the ledger says ${checksum}`);
  checked++;
}
console.log(`  ✔ ${checked} files: bytes ↔ ledger checksum`);

// --- 6. services, then the suites --------------------------------------------

step('start every service; OpenSearch is rebuilt by the projector, not restored');
scale(SERVICES, 1);
kubectl(['scale', 'deployment/mts', '--replicas=2']);
scaleRecorders(2);
for (const name of SERVICES) {
  kubectl(['rollout', 'status', `deployment/${name}`, '--timeout=400s'], { stdio: 'inherit' });
}
step('smoke suite against the restored cluster');
npm('smoke');
step('the MVP journey against the restored cluster');
npm('acceptance');

console.log(
  `\nDRILL PASSED in ${elapsed()} — destroy to smoke-green ` +
    `${((Date.now() - destroyed) / 1000).toFixed(0)}s (this cluster's RTO for a logical restore).`,
);
