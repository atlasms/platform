// The container images a rendered overlay references — derived once, used twice (#512).
//
// The offline bundle (`build-bundle.mjs`) must ship EVERY image an air-gapped install will run, or
// the install pulls from a registry it cannot reach and fails FR-PLat-7 with nothing failing until
// it is tried. It used to hand-list two (`atlas/iam`, `atlas/api-gateway`) and shipped neither the
// other nine Atlas services nor any third-party image (Postgres, NATS, OpenSearch, Temporal). So
// the bundle now DERIVES its image list from the same manifests it ships, and cannot miss one.
//
// `check-k8s.mjs` uses the same derivation to hold the hand-maintained `k8s:build` / `k8s:load`
// lists to the manifests — those two can still drift (the bundle no longer can), which is the
// hand-maintained-list failure the Dockerfile's comment warns about.

/**
 * Every `image:` ref in rendered Kubernetes YAML, sorted and de-duplicated. Containers and
 * initContainers are both plain `image:` lines once rendered, so a single scan catches the Temporal
 * schema initContainer as readily as a Deployment's main container.
 */
export function imageRefsFromManifests(yamlText) {
  const refs = new Set();
  // `image: foo`, `- image: foo`, and quoted forms; stop at whitespace, a quote or a comment.
  const re = /^[ \t]*-?[ \t]*image:[ \t]*["']?([^"'#\s]+)["']?[ \t]*$/gm;
  for (const m of yamlText.matchAll(re)) refs.add(m[1]);
  return [...refs].sort();
}

/**
 * Split refs into the Atlas images built from this repository (`atlas/<service>:<tag>`) and the
 * third-party images pulled from their own registries (everything else). An Atlas ref carries no
 * registry host; a `registry.example/atlas/mam:…` from a production overlay is third-party here,
 * which is why the bundle is built from the DEV overlay, whose Atlas images are local.
 */
export function partitionImages(refs) {
  const atlas = [];
  const thirdParty = [];
  for (const ref of refs) {
    const m = /^atlas\/([a-z0-9-]+):(.+)$/.exec(ref);
    if (m) atlas.push({ service: m[1], tag: m[2], ref });
    else thirdParty.push(ref);
  }
  return { atlas, thirdParty };
}

/**
 * Extra `docker build --build-arg` values an Atlas service needs beyond `SERVICE=<name>`, mirroring
 * the `k8s:build` script. A service absent here builds with `SERVICE` alone. Kept in step with
 * `k8s:build` by `check-k8s.mjs`, which fails if the deployed Atlas set and the build list diverge.
 */
export const ATLAS_EXTRA_BUILD_ARGS = {
  rim: ['APK_PACKAGES=ffmpeg'],
  mts: ['APK_PACKAGES=ffmpeg'],
  bms: ['BASE_IMAGE=node:24-slim'],
};
