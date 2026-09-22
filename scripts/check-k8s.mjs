// The manifests, held to their conventions (EP-07.5).
//
// `kubectl kustomize` renders every overlay under infra/k8s/overlays — so an overlay that no
// longer builds (a patch whose path moved, a resource that was renamed) fails here, not on the
// cluster — and then the rendered documents are checked for what ADR-0002 and the base's own
// comments promise: every Atlas workload has probes, resource requests and a memory limit and
// runs with a read-only root filesystem; and the staging overlay is shaped like production —
// images from a registry by a release tag or digest, never `:dev`; no NodePort; no seeded
// account; one Ingress with TLS routing /ws and /; a PodDisruptionBudget for every deployment
// with more than one replica. The dev overlay is allowed its shortcuts; that is what it is for.
//
// A staging Secret is generated from an env file git never sees. For the render, the `.example`
// stands in when the real file is absent, and is removed again afterwards — this script never
// leaves a credential file behind that it did not find.
//
// The HELM CHART (ADR-0006) is held to the same bar, in the same place, because it is the same
// platform: the generator is re-run and its output compared with what is committed, `helm lint`
// passes, and the chart is rendered twice — once with the defaults, once shaped like production
// — and both renders go through the checks above. A convention that held for Kustomize and not
// for the chart would be a convention that half the installs do not get.
//
//   npm run k8s:check

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OVERLAYS = join(ROOT, 'infra/k8s/overlays');
const CHART = join(ROOT, 'infra/helm/atlas');

const problems = [];
const problem = (overlay, text) => problems.push(`${overlay}: ${text}`);

function render(dir) {
  try {
    return execFileSync('kubectl', ['kustomize', dir], { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : err.message;
    throw new Error(`kubectl kustomize ${dir} failed:\n${stderr}`, { cause: err });
  }
}

/** The env files an overlay's secretGenerator reads, from their committed examples if absent. */
function withExampleEnvs(dir, fn) {
  const created = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.env.example')) continue;
    const real = join(dir, name.slice(0, -'.example'.length));
    if (existsSync(real)) continue;
    copyFileSync(join(dir, name), real);
    created.push(real);
  }
  try {
    return fn();
  } finally {
    for (const f of created) rmSync(f, { force: true });
  }
}

const isAtlas = (doc) => doc?.metadata?.labels?.['app.kubernetes.io/part-of'] === 'atlas';
const containersOf = (doc) => doc?.spec?.template?.spec?.containers ?? [];

/** What every Atlas workload — service or data plane — promises in the base. */
function checkWorkload(overlay, doc) {
  const name = `${doc.kind}/${doc.metadata?.name}`;
  for (const c of containersOf(doc)) {
    const where = `${name} container ${c.name}`;
    if (!c.livenessProbe || !c.readinessProbe)
      problem(overlay, `${where}: needs liveness AND readiness probes`);
    if (!c.resources?.requests?.cpu || !c.resources?.requests?.memory)
      problem(overlay, `${where}: needs cpu and memory requests`);
    if (!c.resources?.limits?.memory) problem(overlay, `${where}: needs a memory limit`);
    // The data plane's images (Postgres, NATS, OpenSearch) write to their own filesystems by
    // design; the read-only root is the platform's own services' promise (the Dockerfile).
    if (doc.kind === 'Deployment') {
      if (c.securityContext?.readOnlyRootFilesystem !== true)
        problem(overlay, `${where}: readOnlyRootFilesystem must be true`);
      if (c.securityContext?.allowPrivilegeEscalation !== false)
        problem(overlay, `${where}: allowPrivilegeEscalation must be false`);
    }
  }
}

/** The staging overlay is the production shape; the dev overlay is allowed its shortcuts. */
function checkStaging(overlay, docs) {
  const deployments = docs.filter((d) => d.kind === 'Deployment' && isAtlas(d));
  for (const d of deployments) {
    const name = `Deployment/${d.metadata.name}`;
    for (const c of containersOf(d)) {
      const image = String(c.image ?? '');
      const [ref, tag] = image.includes('@')
        ? [image.split('@')[0], image.split('@')[1]]
        : image.split(':');
      const registry = ref.split('/')[0];
      if (!registry.includes('.') && !registry.includes(':'))
        problem(overlay, `${name}: image "${image}" has no registry — staging pulls from one`);
      if (!tag || tag === 'dev' || tag === 'latest')
        problem(
          overlay,
          `${name}: image "${image}" must carry a release tag or a digest, not "${tag ?? ''}"`,
        );
      for (const env of c.env ?? []) {
        if (/^ATLAS_SEED_/.test(env.name))
          problem(overlay, `${name}: ${env.name} is set — a seeded account is a dev-only shortcut`);
      }
    }
    const replicas = d.spec?.replicas ?? 1;
    if (replicas > 1) {
      const pdb = docs.find(
        (x) =>
          x.kind === 'PodDisruptionBudget' &&
          x.spec?.selector?.matchLabels?.['app.kubernetes.io/name'] === d.metadata.name,
      );
      if (!pdb) problem(overlay, `${name}: ${replicas} replicas without a PodDisruptionBudget`);
    }
  }
  for (const s of docs.filter((d) => d.kind === 'Service')) {
    if (s.spec?.type === 'NodePort')
      problem(
        overlay,
        `Service/${s.metadata.name}: NodePort — staging is reached through the Ingress`,
      );
  }
  const ingresses = docs.filter((d) => d.kind === 'Ingress');
  if (ingresses.length !== 1) {
    problem(overlay, `expected exactly one Ingress, found ${ingresses.length}`);
  } else {
    const ing = ingresses[0];
    if (!ing.spec?.tls?.length) problem(overlay, 'Ingress: TLS is not configured');
    const paths = (ing.spec?.rules ?? []).flatMap((r) => r.http?.paths ?? []);
    const to = (path) => paths.find((p) => p.path === path)?.backend?.service?.name;
    if (to('/ws') !== 'websocket')
      problem(overlay, 'Ingress: /ws must route to the websocket service');
    if (to('/') !== 'api-gateway')
      problem(overlay, 'Ingress: / must route to the api-gateway service');
  }
  const secrets = docs.filter((d) => d.kind === 'Secret');
  if (!secrets.some((s) => s.metadata?.name === 'postgres-credentials'))
    problem(overlay, 'no postgres-credentials Secret is generated');
}

// --- the Helm chart ----------------------------------------------------------

/**
 * The chart's production-shaped values: a registry, a release tag, pull secrets, an Ingress, and
 * one more replica than the defaults — so the PodDisruptionBudget rule is exercised rather than
 * merely present.
 */
const CHART_PRODUCTION_VALUES = [
  'image.registry=registry.example',
  'image.tag=0.1.0',
  'imagePullSecrets[0].name=atlas-registry',
  'storageClass=fast-ssd',
  'ingress.enabled=true',
  'ingress.host=atlas.staging.example',
  'replicas.websocket=2',
];

function helm(args) {
  const result = spawnSync('helm', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.status !== 0) {
    throw new Error(
      `helm ${args.join(' ')} failed:\n${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return result.stdout;
}

function parse(text) {
  return parseAllDocuments(text)
    .map((d) => d.toJS())
    .filter((d) => d && typeof d === 'object');
}

/** The chart's own promises, beyond the workload conventions every render is held to. */
function checkChart(label, docs, { production }) {
  const deployments = docs.filter((d) => d.kind === 'Deployment' && isAtlas(d));
  if (deployments.length === 0) problem(label, 'rendered no Atlas deployments');

  for (const d of deployments) {
    const name = `Deployment/${d.metadata.name}`;
    for (const c of containersOf(d)) {
      const image = String(c.image ?? '');
      if (production) {
        if (!image.startsWith('registry.example/'))
          problem(label, `${name}: image "${image}" ignores image.registry`);
        if (/:(dev|latest)$/.test(image))
          problem(label, `${name}: image "${image}" must carry a release tag`);
      }
      // Whatever the values say, a credential is read from a Secret and never inlined.
      for (const env of c.env ?? []) {
        if (/^ATLAS_SEED_/.test(env.name))
          problem(label, `${name}: ${env.name} is set — a seeded account is a dev-only shortcut`);
        if (/PASSWORD|SECRET/i.test(env.name) && env.value !== undefined)
          problem(label, `${name}: ${env.name} is a literal value, not a secretKeyRef`);
      }
    }
    const replicas = d.spec?.replicas ?? 1;
    const pdb = docs.find(
      (x) =>
        x.kind === 'PodDisruptionBudget' &&
        x.spec?.selector?.matchLabels?.['app.kubernetes.io/name'] === d.metadata.name,
    );
    // Both directions: a multi-replica deployment needs a budget, and a single-replica one must
    // NOT have one — a PDB over the only pod blocks a node drain outright.
    if (replicas > 1 && !pdb)
      problem(label, `${name}: ${replicas} replicas without a PodDisruptionBudget`);
    if (replicas === 1 && pdb)
      problem(label, `${name}: one replica with a PodDisruptionBudget would block a drain`);
  }

  for (const s of docs.filter((d) => d.kind === 'Service')) {
    if (s.spec?.type === 'NodePort')
      problem(
        label,
        `Service/${s.metadata.name}: NodePort — the chart is reached through an Ingress`,
      );
  }

  const ingresses = docs.filter((d) => d.kind === 'Ingress');
  if (!production) {
    if (ingresses.length !== 0)
      problem(label, 'an Ingress is rendered by default — it must be opt-in');
    return;
  }
  if (ingresses.length !== 1) {
    problem(label, `expected exactly one Ingress, found ${ingresses.length}`);
    return;
  }
  const ing = ingresses[0];
  if (!ing.spec?.tls?.length) problem(label, 'Ingress: TLS is not configured');
  const paths = (ing.spec?.rules ?? []).flatMap((r) => r.http?.paths ?? []);
  const to = (path) => paths.find((p) => p.path === path)?.backend?.service?.name;
  if (to('/ws') !== 'websocket') problem(label, 'Ingress: /ws must route to the websocket service');
  if (to('/') !== 'api-gateway') problem(label, 'Ingress: / must route to the api-gateway service');
}

/** Every workload the manifests define is in the chart, under the same name. */
function checkChartParity(label, chartDocs) {
  const baseDocs = parse(render(join(ROOT, 'infra/k8s/base')));
  const key = (d) => `${d.kind}/${d.metadata?.name}`;
  const inChart = new Set(chartDocs.map(key));
  for (const doc of baseDocs) {
    // The Namespace is the release's, and Helm creates it or the operator does.
    if (doc.kind === 'Namespace') continue;
    if (!inChart.has(key(doc)))
      problem(label, `${key(doc)} is in the manifests but not in the chart`);
  }
}

function checkHelmChart() {
  const label = 'helm/atlas';
  if (spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status !== 0) {
    // A laptop without helm is fine; CI without helm means the chart stopped being checked and
    // nothing said so. Same rule as the JetStream conformance suite.
    if (process.env['CI']) {
      throw new Error(
        'helm is not on PATH in CI: the chart would go unchecked. Restore the Helm step in ' +
          '.github/workflows/ci.yml.',
      );
    }
    console.log('  (helm not found — skipping the chart; install it to check it locally)');
    return 0;
  }

  // 1. What is committed is what the manifests generate. Everything below checks the chart; this
  //    checks that the chart is still the manifests.
  const generator = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts/build-helm-chart.mjs'), '--check'],
    {
      encoding: 'utf8',
    },
  );
  if (generator.status !== 0) {
    problem(label, (generator.stdout + generator.stderr).trim());
    return 0;
  }

  helm(['lint', CHART]);

  const defaults = parse(helm(['template', 'atlas', CHART]));
  const production = parse(
    helm(['template', 'atlas', CHART, ...CHART_PRODUCTION_VALUES.flatMap((v) => ['--set', v])]),
  );

  for (const docs of [defaults, production]) {
    for (const doc of docs) {
      if ((doc.kind === 'Deployment' || doc.kind === 'StatefulSet') && isAtlas(doc))
        checkWorkload(label, doc);
    }
  }
  checkChart(`${label} (defaults)`, defaults, { production: false });
  checkChart(`${label} (production values)`, production, { production: true });
  checkChartParity(label, defaults);

  return defaults.length + production.length;
}

const overlays = readdirSync(OVERLAYS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
if (overlays.length === 0) {
  console.error('no overlays under infra/k8s/overlays');
  process.exit(1);
}

let rendered = 0;
for (const overlay of overlays) {
  const dir = join(OVERLAYS, overlay);
  let docs;
  try {
    const text = withExampleEnvs(dir, () => render(dir));
    docs = parseAllDocuments(text)
      .map((d) => d.toJS())
      .filter((d) => d && typeof d === 'object');
  } catch (err) {
    problem(overlay, err.message);
    continue;
  }
  rendered += docs.length;
  for (const doc of docs) {
    if ((doc.kind === 'Deployment' || doc.kind === 'StatefulSet') && isAtlas(doc))
      checkWorkload(overlay, doc);
  }
  if (overlay === 'staging') checkStaging(overlay, docs);
}

let chartDocuments = 0;
try {
  chartDocuments = checkHelmChart();
} catch (err) {
  problem('helm/atlas', err.message);
}

if (problems.length > 0) {
  console.error(`${problems.length} manifest problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `manifests OK: ${overlays.length} overlay(s) render (${overlays.join(', ')}), ${rendered} documents, ` +
    `every convention holds` +
    (chartDocuments > 0 ? `; the Helm chart matches them and renders ${chartDocuments} more` : ''),
);
