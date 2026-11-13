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
import {
  imageRefsFromManifests,
  partitionImages,
  ATLAS_EXTRA_BUILD_ARGS,
} from './lib/manifest-images.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const VERSION = flag('version', readJson('package.json').version);
const OUT_ROOT = flag('out', join('dist', 'bundle'));
const OVERLAY = flag('overlay', 'infra/k8s/overlays/dev');

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

/** `docker save` an image and record the artifact, pinned by its content-addressed image ID. */
function saveImage(ref, fileName, service) {
  const file = join(BUNDLE, 'images', fileName);
  console.log(`  saving   ${ref}`);
  run('docker', ['save', '-o', file, ref]);
  // The image ID pins the exact content. A tag can be reassigned; this cannot.
  const id = run('docker', ['image', 'inspect', ref, '--format', '{{.Id}}']).trim();
  return { ref, service, file: relative(BUNDLE, file), id };
}

console.log(`Building offline bundle atlas-${VERSION}\n`);

rmSync(BUNDLE, { recursive: true, force: true });
mkdirSync(join(BUNDLE, 'images'), { recursive: true });
mkdirSync(join(BUNDLE, 'manifests'), { recursive: true });

// --- 1. the image list, derived from the manifests ---------------------------
// Whatever the overlay deploys is what the bundle must ship (#512): a hand-maintained list drifts,
// and a missing image fails nothing until an air-gapped install tries to pull it. So render first,
// then bundle exactly the images the rendered documents reference — Atlas services AND the
// third-party images (Postgres, NATS, OpenSearch, Temporal) an isolated site cannot otherwise get.
console.log(`  rendering ${OVERLAY}`);
let manifests = run('kubectl', ['kustomize', OVERLAY]);
const { atlas, thirdParty } = partitionImages(imageRefsFromManifests(manifests));
console.log(`  ${atlas.length} Atlas services + ${thirdParty.length} third-party images\n`);

// --- 2. images ---------------------------------------------------------------
// Atlas images are BUILT from this repository at the bundle's version — never `:dev` or `:latest`,
// because a floating tag inside an air-gapped bundle is a lie: the artifact is fixed at build time,
// so the tag must say which one. Third-party images are PULLED and saved under their own fixed tags.
const imageArtifacts = [];

for (const { service } of atlas) {
  const ref = `atlas/${service}:${VERSION}`;
  const buildArgs = [`SERVICE=${service}`, ...(ATLAS_EXTRA_BUILD_ARGS[service] ?? [])];
  console.log(`  building ${ref}`);
  run('docker', [
    'build',
    '-f',
    'infra/docker/Dockerfile',
    ...buildArgs.flatMap((a) => ['--build-arg', a]),
    '-t',
    ref,
    '.',
  ]);
  imageArtifacts.push(saveImage(ref, `${service}.tar`, service));
  // The overlay tagged this `:dev` for local work; the bundle ships the fixed version.
  manifests = manifests.replaceAll(
    `image: atlas/${service}:dev`,
    `image: atlas/${service}:${VERSION}`,
  );
}

for (const ref of thirdParty) {
  console.log(`  pulling  ${ref}`);
  run('docker', ['pull', ref]);
  // A filename from the ref, with the characters a path cannot carry flattened.
  imageArtifacts.push(saveImage(ref, ref.replace(/[/:]/g, '-') + '.tar', null));
}

// --- 3. manifests ------------------------------------------------------------
// RENDERED, not templated. The installing site needs kubectl and nothing else — no kustomize, no
// helm, no chart repository. It also means what ships is exactly what was reviewed. The Atlas images
// were retagged to the bundle version above; third-party refs ship as the overlay named them.
const manifestFile = join(BUNDLE, 'manifests', 'atlas.yaml');
writeFileSync(manifestFile, manifests);

// --- 4. install script -------------------------------------------------------
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

// --- 5. the manifest of record ----------------------------------------------
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

// --- 6. checksums ------------------------------------------------------------
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
