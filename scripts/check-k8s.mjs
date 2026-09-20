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
//   npm run k8s:check

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OVERLAYS = join(ROOT, 'infra/k8s/overlays');

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

if (problems.length > 0) {
  console.error(`${problems.length} manifest problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `manifests OK: ${overlays.length} overlay(s) render (${overlays.join(', ')}), ${rendered} documents, every convention holds`,
);
