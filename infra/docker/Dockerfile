# One image definition for every Node service (EP-01.4).
#
#   docker build -f infra/docker/Dockerfile --build-arg SERVICE=iam -t atlas/iam:dev .
#
# NO BUILD STEP, deliberately — the same decision the libraries make. Node 24 strips TypeScript
# types natively, so the image runs exactly the source the tests ran against: no bundling, no
# transpile output that can drift from the repository, and no sourcemap indirection when reading a
# production stack trace.
#
# That only works because the code is STRIP-ONLY compatible — no constructor parameter properties,
# no enums, no namespaces, since those emit code rather than just erasing types. An eslint rule
# (`@typescript-eslint/parameter-properties`) keeps it that way; without it a single parameter
# property anywhere in the import graph breaks every container at startup.

ARG SERVICE

# The base image, per service. Alpine for every service but one: BMS runs Temporal's worker, whose
# native core is built for glibc only — on Alpine it cannot load, with or without gcompat (ADR-0010
# evidence 1). BMS's `k8s:build` line passes `BASE_IMAGE=node:24-slim`. Every stage uses the same
# base, so `npm ci` installs for the libc the runtime has.
ARG BASE_IMAGE=node:24-alpine

# ---- manifests: every workspace package.json, and nothing else ------------
#
# Manifests before source: dependencies change far less often than code, and `npm ci` is the
# expensive layer. BuildKit keys a `COPY --from` on the CONTENT it copies, so as long as no
# package.json changed, the install layer below is reused whatever the source did.
#
# Derived from the tree, not listed by hand. This used to be a hand-maintained list of `COPY
# <pkg>/package.json` lines — a manual mirror of the workspace layout — and it failed the quiet
# way such lists do: mam was missing for two releases and its image still ran, because every
# dependency it declared happened to be installed by another service; logging and scheduling were
# missing too. The first dependency unique to one service turned that into a startup crash
# (`Cannot find package '@atlas/data-opensearch'`, EP-07.4). A list you must remember to extend
# fails when you forget; a tree you must remember to PRUNE only bloats when you forget.
FROM ${BASE_IMAGE} AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY libs ./libs
COPY apps ./apps
# Studio is the one exclusion: `workspaces` are globs, and a directory that is not present simply
# does not match — which is how Angular's dependency tree, and with it the whole dev toolchain,
# stays out of every server image. Spikes and tools are never copied at all.
RUN rm -rf apps/studio \
 && find libs apps -mindepth 2 -maxdepth 2 ! -name package.json -exec rm -rf {} + \
 && find libs apps -maxdepth 1 -type f -delete

# ---- dependencies + source --------------------------------------------------
FROM ${BASE_IMAGE} AS deps
ARG SERVICE
WORKDIR /app

COPY --from=manifests /app /app

# `k8s:build` and `k8s:load` in the root package.json still name every image by hand, and the
# generator (`nx g service`) extends them; the websocket service once shipped a manifest for an
# image those scripts had never built. That one at least fails loudly (ImagePullBackOff).
#
# ONE workspace's dependencies, not the whole tree's: `--workspace` installs this service and the
# @atlas/* libraries it declares, with their dependencies, and nothing a sibling service needs. It
# matters since BMS took Temporal's SDK (ADR-0010) — ~176 MB of native builds, webpack and swc that
# every other image would otherwise carry. A library a service imports but does not declare is
# already a CI failure (graph:check), so the scope cannot silently drop one.
RUN npm ci --omit=dev --ignore-scripts --workspace=@atlas/${SERVICE} && npm cache clean --force

# Source goes into THIS stage so the runtime can copy /app whole. Copying only the root
# node_modules would silently drop NESTED ones, and the service would die at startup on a package
# npm had in fact installed correctly — just one level down.
#
# The canonical example used to be ajv: eslint hoisted an incompatible ajv@6 to the root, pushing
# the ajv@8 that @atlas/contracts needs into libs/contracts/node_modules. A dependency update has
# since flipped that — ajv@8 is at the root now and the ajv@6 copies are nested under eslint. The
# example changed; the rule did not. Hoisting is npm's choice and it moves, so copy the whole tree.
COPY libs ./libs
COPY apps/${SERVICE} ./apps/${SERVICE}
# Schemas are loaded and compiled at runtime by @atlas/contracts: executable input, not docs.
COPY docs/architecture/schemas ./docs/architecture/schemas

# A service with a build-time step runs it here, once — today BMS, whose Temporal workflow code is
# bundled into apps/bms/dist so the worker never runs webpack in a pod (ADR-0010 evidence 2; a
# read-only root has nowhere to write it anyway). No other service has a bundle.mjs.
RUN if [ -f apps/${SERVICE}/bundle.mjs ]; then ATLAS_IMAGE_BUILD=1 node apps/${SERVICE}/bundle.mjs; fi

# ---- runtime ----------------------------------------------------------------
FROM ${BASE_IMAGE} AS runtime
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app

# dumb-init reaps zombies and forwards signals. Without it node runs as PID 1, where the default
# SIGTERM disposition does not apply — so a rollout would hang until Kubernetes escalated to
# SIGKILL, dropping in-flight requests every deploy.
#
# APK_PACKAGES is what a service needs from the OS beyond Node — passed by ITS entry in
# `k8s:build`, so only that image carries it: rim's ffprobe (EP-15.4) is the ffmpeg package,
# ~80 MB the gateway has no use for. Empty for every other service.
#
# On a Debian base (BMS) there is no apk: dumb-init comes from apt, and APK_PACKAGES is refused
# rather than silently dropped.
ARG APK_PACKAGES=""
RUN if command -v apk >/dev/null; then       apk add --no-cache dumb-init ${APK_PACKAGES};     elif [ -n "${APK_PACKAGES}" ]; then       echo "APK_PACKAGES is for an Alpine base; this one is not" >&2; exit 1;     else       apt-get update && apt-get install -y --no-install-recommends dumb-init       && rm -rf /var/lib/apt/lists/*;     fi

COPY --from=deps --chown=node:node /app /app

# The `node` user ships with the image. Running as root in a container is one escape away from
# being root on the node.
USER node

ENV SERVICE=${SERVICE}
EXPOSE 3000 8080

# `sh -c` because SERVICE expands at runtime; dumb-init stays PID 1 either way.
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "exec node apps/${SERVICE}/src/main.ts"]
