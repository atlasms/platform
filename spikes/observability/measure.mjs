// Measures what the observability stack costs, and proves what survives its removal.
//
//   node spikes/observability/measure.mjs
//
// Plain .mjs and outside the workspace, like the smoke suite: it talks to a real cluster and a
// real daemon, and nothing in CI should ever pick it up.

import { execFileSync } from 'node:child_process';

const NODE = 'atlas-dev-control-plane';

const sh = (cmd, args, opts = {}) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  } catch (err) {
    return err.stdout ?? '';
  }
};

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MiB`;

// --- 1. bundle cost ---------------------------------------------------------
//
// Measured as the SAVED TAR size, not `docker images`. The offline bundle ships tarballs, and
// `docker images` reports the uncompressed on-disk size, which is not what goes on the media.

const STACK = [
  'prom/prometheus:v3.1.0',
  'grafana/loki:3.3.2',
  'grafana/alloy:v1.5.1',
  'grafana/grafana:11.5.0',
];

function tarBytes(image) {
  // `docker save` to stdout and count. Slower than reading metadata, and it is the only number
  // that answers "how much bigger does the USB stick get".
  const out = execFileSync('bash', ['-c', `docker save ${image} | wc -c`], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return Number(out.trim());
}

console.log('=== bundle cost ===');
let stackTotal = 0;
for (const image of STACK) {
  const bytes = tarBytes(image);
  stackTotal += bytes;
  console.log(`  ${image.padEnd(30)} ${mib(bytes).padStart(10)}`);
}
console.log(`  ${'STACK TOTAL'.padEnd(30)} ${mib(stackTotal).padStart(10)}`);

// --- 2. memory ---------------------------------------------------------------
//
// From crictl on the node rather than metrics-server: one less component to install into a
// cluster whose footprint is the thing being measured.

console.log('\n=== memory (working set) ===');
const statsRaw = sh('docker', ['exec', NODE, 'crictl', 'stats', '-o', 'json']);
let stats;
try {
  stats = JSON.parse(statsRaw);
} catch {
  console.log('  crictl stats unavailable:', statsRaw.slice(0, 200));
  stats = { stats: [] };
}

const byName = new Map();
for (const entry of stats.stats ?? []) {
  const name = entry.attributes?.labels?.['io.kubernetes.container.name'] ?? '?';
  const ns = entry.attributes?.labels?.['io.kubernetes.pod.namespace'] ?? '?';
  const bytes = Number(entry.memory?.workingSetBytes?.value ?? 0);
  byName.set(`${ns}/${name}`, bytes);
}

let atlasTotal = 0;
let obsTotal = 0;
for (const [key, bytes] of [...byName.entries()].sort()) {
  if (key.startsWith('atlas-observability/')) obsTotal += bytes;
  else if (key.startsWith('atlas/')) atlasTotal += bytes;
  else continue;
  console.log(`  ${key.padEnd(40)} ${mib(bytes).padStart(10)}`);
}
console.log(`  ${'ATLAS TOTAL'.padEnd(40)} ${mib(atlasTotal).padStart(10)}`);
console.log(`  ${'OBSERVABILITY TOTAL'.padEnd(40)} ${mib(obsTotal).padStart(10)}`);

// --- 3. is it actually scraping Atlas? ---------------------------------------
//
// The assertion that matters. A stack that is up but discovering nothing looks identical to a
// working one on every dashboard — empty panels read as "quiet system", not "broken scraper".

console.log('\n=== scrape targets ===');
const targetsRaw = sh('bash', [
  '-c',
  `kubectl -n atlas-observability exec deploy/prometheus -- wget -qO- 'http://localhost:9090/api/v1/targets?state=active' 2>/dev/null`,
]);
try {
  const targets = JSON.parse(targetsRaw).data.activeTargets;
  if (targets.length === 0) console.log('  NO ACTIVE TARGETS — discovery is not working');
  for (const t of targets) {
    const svc = t.labels.service ?? t.labels.job;
    console.log(`  ${String(svc).padEnd(20)} ${t.health.padEnd(8)} ${t.scrapeUrl}`);
  }
} catch {
  console.log('  could not read targets:', targetsRaw.slice(0, 200));
}

// --- 4. did a real Atlas metric arrive? --------------------------------------

console.log('\n=== a real Atlas series ===');
const q = encodeURIComponent('sum by (service) (atlas_http_requests_total)');
const queryRaw = sh('bash', [
  '-c',
  `kubectl -n atlas-observability exec deploy/prometheus -- wget -qO- 'http://localhost:9090/api/v1/query?query=${q}' 2>/dev/null`,
]);
try {
  const result = JSON.parse(queryRaw).data.result;
  if (result.length === 0) console.log('  NO SERIES — nothing is being scraped');
  for (const r of result) console.log(`  ${String(r.metric.service).padEnd(20)} ${r.value[1]}`);
} catch {
  console.log('  query failed:', queryRaw.slice(0, 200));
}

// --- 5. did logs reach Loki? -------------------------------------------------

console.log('\n=== logs in Loki ===');
const lq = encodeURIComponent('{namespace="atlas"} |= ""');
const logsRaw = sh('bash', [
  '-c',
  `kubectl -n atlas-observability exec deploy/loki -- wget -qO- 'http://localhost:3100/loki/api/v1/query_range?query=${lq}&limit=5' 2>/dev/null`,
]);
try {
  const streams = JSON.parse(logsRaw).data.result;
  if (streams.length === 0) console.log('  NO LOG STREAMS — the shipper is not delivering');
  for (const s of streams.slice(0, 5)) {
    console.log(
      `  ${String(s.stream.service ?? s.stream.pod).padEnd(20)} ${s.values.length} lines`,
    );
  }
} catch {
  console.log('  query failed:', logsRaw.slice(0, 200));
}
