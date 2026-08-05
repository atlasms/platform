#!/usr/bin/env node
// Build the offline install bundle (EP-01.7) — A9 / FR-PLat-7.
//
//   node scripts/build-bundle.mjs --version 0.1.0
//
// Produces a self-contained directory that installs Atlas onto a Kubernetes cluster with NO
// network access of any kind: no registry, no npm, no chart repository.
//
// What the bundle deliberately does NOT contain: Kubernetes itself. A site brings its own cluster
// (or a distribution bundle from its vendor); pretending otherwise would mean shipping a whole
// distro and still being wrong about the site's storage and networking.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const VERSION = flag('version', readJson('package.json').version);
const OUT_ROOT = flag('out', join('dist', 'bundle'));
const OVERLAY = flag('overlay', 'infra/k8s/overlays/dev');

/** Everything the platform runs. Adding a service here is the only step needed to bundle it. */
const IMAGES = [
  { name: 'atlas/iam', tag: VERSION, service: 'iam' },
  { name: 'atlas/api-gateway', tag: VERSION, service: 'api-gateway' },
];

const BUNDLE = join(OUT_ROOT, `atlas-${VERSION}`);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64, ...opts });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

console.log(`Building offline bundle atlas-${VERSION}\n`);

rmSync(BUNDLE, { recursive: true, force: true });
mkdirSync(join(BUNDLE, 'images'), { recursive: true });
mkdirSync(join(BUNDLE, 'manifests'), { recursive: true });

// --- 1. images ---------------------------------------------------------------
// Built at the bundle's version, never `:dev` and never `:latest`. A floating tag inside an
// air-gapped bundle is a lie: the artifact is fixed at build time, so the tag must say which one.
for (const image of IMAGES) {
  const ref = `${image.name}:${image.tag}`;
  console.log(`  building ${ref}`);
  run('docker', [
    'build',
    '-f',
    'infra/docker/Dockerfile',
    '--build-arg',
    `SERVICE=${image.service}`,
    '-t',
    ref,
    '.',
  ]);
}

const imageArtifacts = [];
for (const image of IMAGES) {
  const ref = `${image.name}:${image.tag}`;
  const file = join(BUNDLE, 'images', `${image.service}.tar`);
  console.log(`  saving  ${ref}`);
  run('docker', ['save', '-o', file, ref]);

  // The image ID pins the exact content. A tag can be reassigned; this cannot.
  const id = run('docker', ['image', 'inspect', ref, '--format', '{{.Id}}']).trim();
  imageArtifacts.push({ ref, service: image.service, file: relative(BUNDLE, file), id });
}

// --- 2. manifests ------------------------------------------------------------
// RENDERED, not templated. The installing site needs kubectl and nothing else — no kustomize, no
// helm, no chart repository. It also means what ships is exactly what was reviewed.
console.log(`\n  rendering ${OVERLAY}`);
let manifests = run('kubectl', ['kustomize', OVERLAY]);

// Point every image at the bundle's version rather than whatever the overlay used for local work.
for (const image of IMAGES) {
  manifests = manifests.replaceAll(`image: ${image.name}:dev`, `image: ${image.name}:${image.tag}`);
}
const manifestFile = join(BUNDLE, 'manifests', 'atlas.yaml');
writeFileSync(manifestFile, manifests);

// --- 3. install script -------------------------------------------------------
writeFileSync(
  join(BUNDLE, 'install.sh'),
  `#!/usr/bin/env sh
# Atlas ${VERSION} — offline install.
#
#   ./install.sh                 # load images into containerd/docker, then apply
#   ./install.sh --verify-only   # check integrity and stop
#
# Requires: kubectl with a working context, and a container runtime that can load an image
# tarball. Nothing else, and no network.
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"

echo "Verifying bundle integrity..."
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c SHA256SUMS
else
  echo "no sha256 tool found; refusing to install an unverified bundle" >&2
  exit 1
fi

[ "\${1:-}" = "--verify-only" ] && { echo "Bundle OK."; exit 0; }

echo "Loading images..."
for tar in images/*.tar; do
  echo "  $tar"
  if command -v docker >/dev/null 2>&1; then
    docker load -i "$tar"
  elif command -v ctr >/dev/null 2>&1; then
    ctr -n k8s.io images import "$tar"
  else
    echo "no container runtime found to load images" >&2
    exit 1
  fi
done

echo "Applying manifests..."
kubectl apply -f manifests/atlas.yaml

echo "Done. Watch rollout with: kubectl get pods -n atlas -w"
`,
  { mode: 0o755 },
);

// --- 4. the manifest of record ----------------------------------------------
const bundleManifest = {
  product: 'atlas',
  version: VERSION,
  builtAt: new Date().toISOString(),
  // Provenance: which commit produced this. The first question during an incident is "what is
  // actually installed", and a tag alone cannot answer it.
  gitCommit: (() => {
    try {
      return run('git', ['rev-parse', 'HEAD']).trim();
    } catch {
      return 'unknown';
    }
  })(),
  images: imageArtifacts,
  manifests: ['manifests/atlas.yaml'],
  notes: [
    'Contains no Kubernetes distribution: the site provides the cluster.',
    'Integrity is checksums only. Signing is a separate, unimplemented step (see the runbook).',
  ],
};
writeFileSync(join(BUNDLE, 'bundle.json'), JSON.stringify(bundleManifest, null, 2) + '\n');

// --- 5. checksums ------------------------------------------------------------
// Written last, over everything else. `sha256sum -c` expects paths relative to the bundle root,
// which is why install.sh cd's there first.
const sums = walk(BUNDLE)
  .map((file) => ({ file: relative(BUNDLE, file).replaceAll('\\', '/'), hash: sha256(file) }))
  .sort((a, b) => a.file.localeCompare(b.file))
  .map(({ file, hash }) => `${hash}  ${file}`)
  .join('\n');
writeFileSync(join(BUNDLE, 'SHA256SUMS'), sums + '\n');

const totalBytes = walk(BUNDLE).reduce((n, f) => n + statSync(f).size, 0);
console.log(`\nBundle: ${BUNDLE}`);
console.log(`  ${imageArtifacts.length} images, ${(totalBytes / 1024 / 1024).toFixed(0)} MB total`);
console.log(`  install with: cd ${BUNDLE} && ./install.sh`);
