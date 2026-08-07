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

# ---- dependencies + source --------------------------------------------------
FROM node:24-alpine AS deps
ARG SERVICE
WORKDIR /app

# Manifests before source: dependencies change far less often than code, and this is the expensive
# layer to rebuild.
COPY package.json package-lock.json ./
COPY libs/contracts/package.json ./libs/contracts/
COPY libs/data/package.json ./libs/data/
COPY libs/data-pg/package.json ./libs/data-pg/
COPY libs/messaging/package.json ./libs/messaging/
COPY libs/messaging-nats/package.json ./libs/messaging-nats/
COPY libs/policy/package.json ./libs/policy/
COPY libs/reference/package.json ./libs/reference/
COPY libs/service-kit/package.json ./libs/service-kit/
COPY apps/api-gateway/package.json ./apps/api-gateway/
COPY apps/iam/package.json ./apps/iam/
COPY apps/mam/package.json ./apps/mam/
COPY apps/websocket/package.json ./apps/websocket/
COPY apps/walking-skeleton/package.json ./apps/walking-skeleton/

# ⚠️ THIS LIST IS A MANUAL MIRROR OF THE WORKSPACE LAYOUT. Add a service to `apps/` and it must be
# added here too, or `npm ci` never learns about that workspace and its dependencies are simply not
# installed. That failure is quiet: mam was missing from this list for two releases and its image
# still ran, because every dependency it declares happened to be installed by another service. The
# first dependency unique to a new service is what turns it into a startup crash.
#
# Studio and the spikes are deliberately absent. `workspaces` are globs, so a directory that is not
# in the build context simply does not match — which is how Angular's dependency tree stays out of
# a server image, and with it the whole dev toolchain (`npm ci --omit=dev` does the rest).
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

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

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime
ARG SERVICE
ENV NODE_ENV=production
WORKDIR /app

# dumb-init reaps zombies and forwards signals. Without it node runs as PID 1, where the default
# SIGTERM disposition does not apply — so a rollout would hang until Kubernetes escalated to
# SIGKILL, dropping in-flight requests every deploy.
RUN apk add --no-cache dumb-init

COPY --from=deps --chown=node:node /app /app

# The `node` user ships with the image. Running as root in a container is one escape away from
# being root on the node.
USER node

ENV SERVICE=${SERVICE}
EXPOSE 3000 8080

# `sh -c` because SERVICE expands at runtime; dumb-init stays PID 1 either way.
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "exec node apps/${SERVICE}/src/main.ts"]
