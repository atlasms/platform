#!/usr/bin/env node
// The Helm chart, GENERATED from the Kubernetes manifests (ADR-0006).
//
//   node scripts/build-helm-chart.mjs            # write infra/helm/atlas
//   node scripts/build-helm-chart.mjs --check    # fail if what is committed is not what this writes
//
// ADR-0002 chose Kustomize for our own environments and deferred a chart for customer
// distribution, with the reason a chart was not written on day one stated plainly: "the
// alternative is maintaining *two* deployment paths, and the second one always rots". So the
// chart is not a second copy of the manifests — it is a rendering of the first one. The base
// under infra/k8s/base is the source; this script reads it, replaces the handful of values a
// customer must be able to set with template expressions, harvests the values it replaced into
// values.yaml as the defaults, and writes the result. `--check` runs in `npm run k8s:check`, so a
// manifest edited without regenerating fails CI instead of shipping a chart that lies.
//
// Comments survive. The manifests carry the reasoning for nearly every field — why IAM has one
// replica, why the broker is not a readiness check, why PGDATA is a subdirectory — and a chart
// that dropped all of it would be strictly worse than the YAML it came from. The YAML library's
// document API is used rather than parse-and-restringify for exactly that reason.
//
// What is NOT generated, because it has no counterpart in the base: the Ingress (the staging
// overlay's shape, as values), the PodDisruptionBudgets (a rule over the replica counts), the
// optional Secret, and the helpers. Those literals live at the bottom of this file, so the whole
// chart still has one source.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments, parseDocument, stringify } from 'yaml';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = join(ROOT, 'infra/k8s/base');
const CHART = join(ROOT, 'infra/helm/atlas');
const CHECK = process.argv.includes('--check');

/** The platform's own services: their image tag follows the chart's appVersion. */
const ATLAS_SERVICES = new Set([
  'iam',
  'mam',
  'websocket',
  'api-gateway',
  'rim',
  'scheduling',
  'logging',
]);

/**
 * Workloads whose replica count is NOT a value.
 *
 * Each is a correctness constraint rather than a capacity choice, and the base says why: IAM
 * generates its signing key ring per process; RIM's staging area is a ReadWriteOnce volume; the
 * data plane is single-writer. A chart that let you raise these would be a chart that lets you
 * break the install from values.yaml.
 */
const PINNED_REPLICAS = new Set(['iam', 'rim', 'postgres', 'nats', 'opensearch']);

/** The data-plane components a customer may point at their own estate instead. */
const DATA_PLANE = new Set(['postgres', 'nats', 'opensearch']);

// --- template substitution ---------------------------------------------------
//
// A template expression cannot be a YAML node, so each one is parked as a sentinel scalar and
// swapped in after the document is stringified. Three shapes: an inline expression that replaces
// a scalar, a block that replaces a mapping value (`resources:`), and a sentinel KEY whose whole
// line becomes a conditional block.

const substitutions = [];

function sentinel(kind, text) {
  substitutions.push({ kind, text });
  return `@@TPL:${substitutions.length - 1}@@`;
}

const inline = (text) => sentinel('inline', text);
const block = (text) => sentinel('block', text);
const lines = (text) => sentinel('lines', text);

/** Swap every sentinel back out, honouring the indentation of the line it landed on. */
function detemplate(text) {
  let out = text;
  for (const [index, sub] of substitutions.entries()) {
    const token = `@@TPL:${index}@@`;
    if (!out.includes(token)) continue;
    if (sub.kind === 'inline') {
      out = out.replaceAll(new RegExp(`(['"]?)${token}\\1`, 'g'), () => sub.text);
      continue;
    }
    // A block or a line set replaces the whole line, and is re-indented to sit where it was.
    const line = new RegExp(`^([ \\t]*)([^\\n]*?)(['"]?)${token}\\3[^\\n]*$`, 'm');
    const match = line.exec(out);
    if (!match) continue;
    const [whole, indent, key] = match;
    const body =
      sub.kind === 'block'
        ? `${indent}${key.trimEnd()}\n${indent}  ${sub.text.replaceAll('%INDENT%', String(indent.length + 2))}`
        : sub.text
            .replaceAll('%INDENT2%', String(indent.length + 2))
            .replaceAll('%INDENT%', String(indent.length))
            .split('\n')
            .map((l) => (l === '' ? l : `${indent}${l}`))
            .join('\n');
    // A function replacement: the body carries `$(PGUSER)` and friends, which `String.replace`
    // would otherwise read as substitution patterns.
    out = out.replace(whole, () => body);
  }
  return out;
}

// --- harvested defaults ------------------------------------------------------

const values = {
  images: {},
  replicas: {},
  resources: {},
  storage: {},
};

/** `atlas/mam:dev` → the component name the chart knows it by, and its default repository/tag. */
function imageValue(image) {
  const [repository, tag = 'latest'] = image.includes('@')
    ? [image.split('@')[0], image.split('@')[1]]
    : [image.slice(0, image.lastIndexOf(':')), image.slice(image.lastIndexOf(':') + 1)];
  const component = repository.split('/').pop();
  // An Atlas image's default tag is the chart's appVersion, expressed as an empty string here so
  // a release does not have to rewrite values.yaml. A third-party image keeps its pinned tag:
  // `opensearch:<atlas version>` would not exist.
  values.images[component] = { repository, tag: ATLAS_SERVICES.has(component) ? '' : tag };
  return component;
}

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

// --- the rules ---------------------------------------------------------------

/** Every document gets Helm's own labels beside the ones the base already carries. */
function labelDocument(doc) {
  if (doc.getIn(['metadata', 'labels']) === undefined) return;
  doc.setIn(
    ['metadata', 'labels', '__HELM_LABELS__'],
    lines('{{- include "atlas.labels" . | nindent %INDENT% }}'),
  );
}

function templateContainer(doc, path, container, workload) {
  const component = imageValue(String(container.get('image')));
  doc.setIn(
    [...path, 'image'],
    inline(`{{ include "atlas.image" (dict "ctx" . "name" "${component}") }}`),
  );
  if (container.get('imagePullPolicy') !== undefined) {
    doc.setIn([...path, 'imagePullPolicy'], inline('{{ .Values.image.pullPolicy }}'));
  }

  const resources = container.get('resources');
  if (resources) {
    values.resources[camel(workload)] = resources.toJSON();
    doc.setIn(
      [...path, 'resources'],
      block(`{{- toYaml .Values.resources.${camel(workload)} | nindent %INDENT% }}`),
    );
  }

  const env = container.get('env');
  for (const [i, entry] of (env?.items ?? []).entries()) {
    const name = String(entry.get('name'));
    const at = [...path, 'env', i];
    if (name === 'ATLAS_PG_URL') {
      doc.setIn(
        [...at, 'value'],
        inline(
          'postgres://$(PGUSER):$(PGPASSWORD)@{{ .Values.postgres.host }}:{{ .Values.postgres.port }}/{{ .Values.postgres.database }}',
        ),
      );
    } else if (name === 'ATLAS_NATS_URL') {
      doc.setIn([...at, 'value'], inline('nats://{{ .Values.nats.host }}:{{ .Values.nats.port }}'));
    } else if (name === 'ATLAS_OPENSEARCH_URL') {
      doc.setIn(
        [...at, 'value'],
        inline('http://{{ .Values.opensearch.host }}:{{ .Values.opensearch.port }}'),
      );
    } else if (name === 'POSTGRES_DB') {
      doc.setIn([...at, 'value'], inline('{{ .Values.postgres.database }}'));
    }
    // The credentials: the Secret's NAME and its KEYS are both values. A site with a secrets
    // backend already has a Secret, and it rarely spells its keys the way we would.
    if (entry.getIn(['valueFrom', 'secretKeyRef', 'name']) === 'postgres-credentials') {
      doc.setIn(
        [...at, 'valueFrom', 'secretKeyRef', 'name'],
        inline('{{ include "atlas.postgresSecretName" . }}'),
      );
      const key = String(entry.getIn(['valueFrom', 'secretKeyRef', 'key']));
      if (key === 'username' || key === 'password') {
        doc.setIn(
          [...at, 'valueFrom', 'secretKeyRef', 'key'],
          inline(`{{ .Values.postgres.auth.${key === 'username' ? 'userKey' : 'passwordKey'} }}`),
        );
      }
    }
  }

  // `pg_isready -U atlas -d atlas`: the role and database the in-cluster server is created with.
  for (const probe of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
    const command = container.getIn([probe, 'exec', 'command']);
    for (const [i, arg] of (command?.items ?? []).entries()) {
      const previous = i > 0 ? String(command.items[i - 1]) : '';
      if (String(arg) !== 'atlas') continue;
      if (previous === '-U')
        doc.setIn(
          [...path, probe, 'exec', 'command', i],
          inline('{{ .Values.postgres.user | quote }}'),
        );
      if (previous === '-d')
        doc.setIn(
          [...path, probe, 'exec', 'command', i],
          inline('{{ .Values.postgres.database | quote }}'),
        );
    }
  }
}

/** A claim's size is a value, and so is the class — the default one is rarely what a database wants. */
function templateClaim(doc, path, name) {
  const key = camel(name);
  const current = doc.getIn([...path, 'resources', 'requests', 'storage']);
  if (current === undefined) return;
  values.storage[key] = String(current);
  doc.setIn([...path, 'resources', 'requests', 'storage'], inline(`{{ .Values.storage.${key} }}`));
  doc.setIn(
    [...path, '__STORAGE_CLASS__'],
    lines('{{- with .Values.storageClass }}\nstorageClassName: {{ . }}\n{{- end }}'),
  );
}

function templateDocument(doc) {
  labelDocument(doc);
  const kind = String(doc.get('kind'));
  const name = String(doc.getIn(['metadata', 'name']));

  if (kind === 'PersistentVolumeClaim') {
    templateClaim(doc, ['spec'], name);
    return;
  }
  if (kind !== 'Deployment' && kind !== 'StatefulSet') return;

  if (!PINNED_REPLICAS.has(name)) {
    values.replicas[camel(name)] = doc.get('spec').get('replicas') ?? 1;
    doc.setIn(['spec', 'replicas'], inline(`{{ .Values.replicas.${camel(name)} }}`));
  }

  const containers = doc.getIn(['spec', 'template', 'spec', 'containers']);
  for (const [i, container] of (containers?.items ?? []).entries()) {
    templateContainer(doc, ['spec', 'template', 'spec', 'containers', i], container, name);
  }

  // A private or mirrored registry is the normal case for an air-gapped install.
  doc.setIn(
    ['spec', 'template', 'spec', '__IMAGE_PULL_SECRETS__'],
    lines(
      '{{- with .Values.imagePullSecrets }}\nimagePullSecrets:\n  {{- toYaml . | nindent %INDENT2% }}\n{{- end }}',
    ),
  );

  const claims = doc.getIn(['spec', 'volumeClaimTemplates']);
  for (const [i] of (claims?.items ?? []).entries()) {
    templateClaim(doc, ['spec', 'volumeClaimTemplates', i, 'spec'], name);
  }
}

// --- rendering ---------------------------------------------------------------

function generatedBanner(source) {
  return (
    `# GENERATED from infra/k8s/base/${source} by scripts/build-helm-chart.mjs — do not edit.\n` +
    `# Change the manifest and run \`npm run helm:build\`; \`npm run k8s:check\` fails if you do not.\n`
  );
}

const kustomization = parseDocument(readFileSync(join(BASE, 'kustomization.yaml'), 'utf8')).toJS();
/** The base's own order, minus the Namespace — Helm installs into the release's namespace. */
const sources = kustomization.resources.filter((r) => r !== 'namespace.yaml');

const files = new Map();

for (const source of sources) {
  const text = readFileSync(join(BASE, source), 'utf8');
  const docs = parseAllDocuments(text);
  for (const doc of docs) templateDocument(doc);

  const component = source.replace(/\.yaml$/, '');
  // `flowCollectionPadding: false` keeps `["ALL"]` as the manifests write it: the chart should
  // read as the same YAML, not as the same YAML reformatted.
  // The document separator is written here, once: a parsed document past the first carries its
  // own `---` marker, and keeping both would emit an empty document between every pair.
  let rendered = docs
    .map((d) =>
      d
        .toString({ flowCollectionPadding: false })
        .trimEnd()
        .replace(/^---\n/, ''),
    )
    .join('\n---\n');
  rendered = `${generatedBanner(source)}${rendered}\n`;
  // A data-plane component a site already runs is not installed: `postgres.enabled: false` and
  // `postgres.host` point every service at the estate's own server. The base's comment on
  // postgres.yaml says to delete the file in a Kustomize overlay; this is that, as a value.
  if (DATA_PLANE.has(component)) {
    rendered = `{{- if .Values.${component}.enabled }}\n${rendered}{{- end }}\n`;
  }
  files.set(join('templates', `${component}.yaml`), rendered);
}

// --- the values, and the pieces with no counterpart in the base ---------------

const sortKeys = (o) =>
  Object.fromEntries(
    Object.keys(o)
      .sort()
      .map((k) => [k, o[k]]),
  );
const yaml = (o, indent = 2) =>
  stringify(sortKeys(o), { indent: 2, lineWidth: 100 })
    .trimEnd()
    .split('\n')
    .map((l) => ' '.repeat(indent) + l)
    .join('\n');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

files.set(
  'Chart.yaml',
  `# GENERATED by scripts/build-helm-chart.mjs — do not edit.
apiVersion: v2
name: atlas
description: >-
  Atlas — the broadcast media platform. Gateway, IAM, MAM, ingest, scheduling, logging and the
  WebSocket service, with an optional in-cluster data plane (PostgreSQL, NATS JetStream,
  OpenSearch). Installs air-gapped: every image is a value, nothing is fetched at render time.
type: application
# The chart's own version and the platform's. Both are the repository's version: the chart has no
# life of its own, because it is generated from the manifests of exactly one release.
version: ${pkg.version}
appVersion: "${pkg.version}"
kubeVersion: ">=1.27.0-0"
home: https://github.com/atlasms/platform
sources:
  - https://github.com/atlasms/platform
maintainers:
  - name: Atlas
annotations:
  # The chart installs the platform; it does not install Kubernetes, storage or an ingress
  # controller. See infra/helm/README.md for what a cluster must already provide.
  atlas.io/requires: "a default StorageClass (or .Values.storageClass), and an Ingress controller if .Values.ingress.enabled"
`,
);

files.set(
  'values.yaml',
  `# GENERATED by scripts/build-helm-chart.mjs — do not edit.
#
# Every default here is harvested from infra/k8s/base, so the chart installed with no values at
# all is the platform as the manifests define it. Change a manifest, run \`npm run helm:build\`.

# --- images ------------------------------------------------------------------
#
# The final reference is \`{registry}/{repository}:{tag}\`, with the registry omitted when empty.
# For an air-gapped site that mirrors everything into one registry, setting \`image.registry\` is
# the only change needed — including for the data plane, which is the half a chart usually
# forgets. An Atlas image with an empty tag follows the chart's appVersion.
image:
  registry: ""
  # Applies to the platform's own images; a third-party image keeps the tag it is pinned to below.
  tag: ""
  pullPolicy: IfNotPresent

# Credentials for a private or mirrored registry: [{ name: my-pull-secret }].
imagePullSecrets: []

images:
${yaml(values.images)}

# --- scale -------------------------------------------------------------------
#
# Only the workloads that CAN scale appear here. IAM (one signing key ring per process), RIM (a
# ReadWriteOnce staging volume) and the data plane (single writer) are pinned in the manifests,
# and a value that let you raise them would be a value that breaks the install.
#
# A deployment listed here with more than one replica also gets a PodDisruptionBudget.
replicas:
${yaml(values.replicas)}

resources:
${yaml(values.resources)}

# --- storage -----------------------------------------------------------------
#
# Sizes are a laptop's by default, which is what the base is for. A facility sets all four.
# \`storageClass\` applies to every claim; leave it empty to take the cluster's default.
storageClass: ""
storage:
${yaml(values.storage)}

# --- the data plane ----------------------------------------------------------
#
# \`enabled: false\` does not install the component and points the services at \`host\` instead —
# a site with a managed PostgreSQL, its own NATS cluster or an existing OpenSearch. The platform
# does not care which, as long as the address answers.
postgres:
  enabled: true
  host: postgres
  port: 5432
  database: atlas
  # The role the in-cluster server is created with, and the one its probes check. With an external
  # server this must match the username in the Secret below.
  user: atlas
  auth:
    # The Secret holding the credentials. Point this at the one your secrets backend manages —
    # sealed-secrets, vault, external-secrets — and the chart creates nothing.
    existingSecret: postgres-credentials
    userKey: username
    passwordKey: password
    # Set BOTH to have the chart create the Secret instead (\`existingSecret: ""\`). Convenient for
    # a test install; for anything else, a password in a values file is a password in a git repo.
    username: ""
    password: ""

nats:
  enabled: true
  host: nats
  port: 4222

opensearch:
  enabled: true
  host: opensearch
  port: 9200

# --- ingress -----------------------------------------------------------------
#
# ONE origin for the browser: /ws reaches the WebSocket service, which authenticates its own
# upgrade and cannot be proxied by the gateway's fetch client; everything else reaches the
# gateway. Off by default — a cluster without an ingress controller would get an Ingress nothing
# serves, and this is the one setting that cannot have a sensible default.
ingress:
  enabled: false
  className: nginx
  host: atlas.example
  tls:
    enabled: true
    # The Secret holding the certificate. cert-manager users add their issuer under \`annotations\`.
    secretName: atlas-tls
  annotations:
    # An idle upgraded connection must outlive a request; these are ingress-nginx's names for it,
    # and another controller ignores them — set its equivalent.
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    # The gateway caps bodies itself (1 MiB JSON, 8 MiB on /api/v1/uploads). The ingress must not
    # cap them lower, or an upload part never reaches the service that would accept it.
    nginx.ingress.kubernetes.io/proxy-body-size: 16m
`,
);

files.set(
  'templates/_helpers.tpl',
  `{{/* GENERATED by scripts/build-helm-chart.mjs — do not edit. */}}

{{/* Helm's own labels, beside the ones the manifests already carry. */}}
{{- define "atlas.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{/*
One image reference: {registry}/{repository}:{tag}, registry omitted when empty. A component's
own tag wins; an Atlas image leaves it empty and follows the chart's appVersion, so a release
bumps one number rather than seven.
*/}}
{{- define "atlas.image" -}}
{{- $image := index .ctx.Values.images .name -}}
{{- if not $image -}}{{- fail (printf "no image configured for %s" .name) -}}{{- end -}}
{{- $registry := .ctx.Values.image.registry -}}
{{- $tag := $image.tag | default .ctx.Values.image.tag | default .ctx.Chart.AppVersion -}}
{{- if $registry }}{{ $registry }}/{{ end }}{{ $image.repository }}:{{ $tag }}
{{- end -}}

{{/* The Secret the database credentials come from: the site's, or the one this chart creates. */}}
{{- define "atlas.postgresSecretName" -}}
{{- if .Values.postgres.auth.existingSecret -}}
{{ .Values.postgres.auth.existingSecret }}
{{- else -}}
{{ .Release.Name }}-postgres
{{- end -}}
{{- end -}}

{{/*
Refuse to install without credentials, rather than producing a cluster that half-starts.
Every service reads the database through this Secret; without one, each pod crash-loops on a
missing environment variable and the reason is three kubectl commands away.
*/}}
{{- define "atlas.checkCredentials" -}}
{{- if not .Values.postgres.auth.existingSecret -}}
{{- if or (not .Values.postgres.auth.username) (not .Values.postgres.auth.password) -}}
{{- fail "postgres credentials: set postgres.auth.existingSecret to a Secret you manage, or BOTH postgres.auth.username and postgres.auth.password to have this chart create one" -}}
{{- end -}}
{{- end -}}
{{- end -}}
`,
);

files.set(
  'templates/postgres-secret.yaml',
  `{{/* GENERATED by scripts/build-helm-chart.mjs — do not edit. */}}
{{- include "atlas.checkCredentials" . }}
{{- if and (not .Values.postgres.auth.existingSecret) .Values.postgres.auth.password }}
# Created only when no existing Secret is named. A password in a values file is a password in
# whatever holds that file, so this is the test-install path, not the recommended one.
apiVersion: v1
kind: Secret
metadata:
  name: {{ .Release.Name }}-postgres
  labels:
    app.kubernetes.io/name: postgres
    app.kubernetes.io/part-of: atlas
    {{- include "atlas.labels" . | nindent 4 }}
type: Opaque
stringData:
  {{ .Values.postgres.auth.userKey }}: {{ .Values.postgres.auth.username | quote }}
  {{ .Values.postgres.auth.passwordKey }}: {{ .Values.postgres.auth.password | quote }}
{{- end }}
`,
);

files.set(
  'templates/poddisruptionbudget.yaml',
  `{{/* GENERATED by scripts/build-helm-chart.mjs — do not edit. */}}
{{/*
A budget for every deployment that runs more than one replica, and for no other. One pod stays
available through a node drain or a rollout — and a PDB over a SINGLE-replica deployment would
block the drain outright, which is why this is a rule over the replica counts rather than a list.
*/}}
{{- range $name, $count := .Values.replicas }}
{{- if gt (int $count) 1 }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ $name | kebabcase }}
  labels:
    app.kubernetes.io/name: {{ $name | kebabcase }}
    app.kubernetes.io/part-of: atlas
    {{- include "atlas.labels" $ | nindent 4 }}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ $name | kebabcase }}
{{- end }}
{{- end }}
`,
);

files.set(
  'templates/ingress.yaml',
  `{{/* GENERATED by scripts/build-helm-chart.mjs — do not edit. */}}
{{- if .Values.ingress.enabled }}
# ONE origin for the browser: /ws to the WebSocket service — it authenticates its own upgrade and
# the gateway's fetch proxy cannot perform one — and everything else to the gateway. The path
# order is load-bearing: /ws is matched first, and a controller that sorts by specificity does the
# same thing.
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .Release.Name }}
  labels:
    app.kubernetes.io/name: atlas
    app.kubernetes.io/part-of: atlas
    {{- include "atlas.labels" . | nindent 4 }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- with .Values.ingress.className }}
  ingressClassName: {{ . }}
  {{- end }}
  {{- if .Values.ingress.tls.enabled }}
  tls:
    - hosts:
        - {{ .Values.ingress.host | quote }}
      secretName: {{ .Values.ingress.tls.secretName }}
  {{- end }}
  rules:
    - host: {{ .Values.ingress.host | quote }}
      http:
        paths:
          - path: /ws
            pathType: Prefix
            backend:
              service:
                name: websocket
                port:
                  number: 3000
          - path: /
            pathType: Prefix
            backend:
              service:
                name: api-gateway
                port:
                  number: 8080
{{- end }}
`,
);

files.set(
  'templates/NOTES.txt',
  `Atlas {{ .Chart.AppVersion }} is installed as "{{ .Release.Name }}" in namespace {{ .Release.Namespace }}.

{{ if .Values.ingress.enabled -}}
Reach it at https://{{ .Values.ingress.host }} — the browser talks to one origin; /ws is the
WebSocket service and everything else is the gateway.
{{- else -}}
No Ingress was requested. To reach the gateway without one:

  kubectl -n {{ .Release.Namespace }} port-forward svc/api-gateway 8080:8080

Live updates need the WebSocket service on the same origin as the API, so a real deployment wants
\`ingress.enabled: true\` (or your own ingress with the same two paths).
{{- end }}

Check it came up:

  kubectl -n {{ .Release.Namespace }} rollout status deployment/api-gateway
  kubectl -n {{ .Release.Namespace }} get pods

{{ if not .Values.postgres.enabled -}}
PostgreSQL is not installed by this release: the services are pointed at {{ .Values.postgres.host }}:{{ .Values.postgres.port }}.
{{ end -}}
{{ if .Values.postgres.auth.existingSecret -}}
Database credentials come from the Secret "{{ .Values.postgres.auth.existingSecret }}". If it does
not exist, every service will crash-loop with a missing environment variable.
{{- else -}}
Database credentials were created as the Secret "{{ .Release.Name }}-postgres" from values. Rotate
them into a Secret your secrets backend manages, then set postgres.auth.existingSecret.
{{- end }}

There is no seeded account: create the first administrator with the runbook's bootstrap procedure
(docs/operations/17-operations-runbook.md).
`,
);

files.set(
  '.helmignore',
  `.DS_Store
.git
.gitignore
*.tmproj
*.orig
*.bak
`,
);

// --- write, or check ---------------------------------------------------------

const rendered = new Map([...files].map(([path, text]) => [path, detemplate(text)]));

function existing() {
  const found = new Map();
  if (!existsSync(CHART)) return found;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else found.set(relative(CHART, full).replaceAll('\\', '/'), readFileSync(full, 'utf8'));
    }
  };
  walk(CHART);
  return found;
}

const onDisk = existing();
const wanted = new Map([...rendered].map(([p, t]) => [p.replaceAll('\\', '/'), t]));

if (CHECK) {
  const differences = [];
  for (const [path, text] of wanted) {
    if (!onDisk.has(path)) differences.push(`missing: ${path}`);
    else if (onDisk.get(path) !== text) differences.push(`stale: ${path}`);
  }
  for (const path of onDisk.keys()) if (!wanted.has(path)) differences.push(`unexpected: ${path}`);
  if (differences.length > 0) {
    console.error('the Helm chart is not what the manifests say it should be:');
    for (const d of differences) console.error(`  ${d}`);
    console.error('\nrun `npm run helm:build` and commit the result');
    process.exit(1);
  }
  console.log(
    `helm chart matches the manifests: ${wanted.size} files generated from infra/k8s/base`,
  );
} else {
  rmSync(CHART, { recursive: true, force: true });
  for (const [path, text] of wanted) {
    const full = join(CHART, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  console.log(`wrote ${wanted.size} files to ${relative(ROOT, CHART)}`);
}
