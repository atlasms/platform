// The generator against a virtual tree: what it writes, what it wires, and what it refuses.
//
// This is the fast half. The other half is CI's "Generated service passes the bar" step, which
// runs the generator for real and then holds the output to lint, strict typecheck and its own
// tests — because a scaffold that only passes the generator's tests is a template, not a service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTreeWithEmptyWorkspace } from '@nx/devkit/testing';
import type { Tree } from '@nx/devkit';
import { serviceGenerator } from '../src/service/generator.ts';

/** The three files the generator edits, in the shape the repo has them. */
function seeded(): Tree {
  const tree = createTreeWithEmptyWorkspace();
  tree.write(
    'package.json',
    JSON.stringify({
      name: 'atlas',
      workspaces: ['libs/*', 'apps/*'],
      scripts: {
        'k8s:build':
          'docker build -f infra/docker/Dockerfile --build-arg SERVICE=iam -t atlas/iam:dev . && docker build -f infra/docker/Dockerfile --build-arg SERVICE=api-gateway -t atlas/api-gateway:dev .',
        'k8s:load': 'kind load docker-image atlas/iam:dev atlas/api-gateway:dev --name atlas-dev',
      },
    }),
  );
  tree.write(
    'infra/k8s/base/kustomization.yaml',
    [
      'resources:',
      '  - namespace.yaml',
      '  - iam.yaml',
      '  - api-gateway.yaml',
      '',
      'labels: []',
      '',
    ].join('\n'),
  );
  tree.write(
    'infra/k8s/overlays/dev/kustomization.yaml',
    [
      'images:',
      '  - name: atlas/iam',
      '    newTag: dev',
      '  - name: atlas/api-gateway',
      '    newTag: dev',
      '',
      'patches: []',
      '',
    ].join('\n'),
  );
  return tree;
}

const read = (tree: Tree, path: string): string =>
  tree.read(path, 'utf8') ?? assert.fail(`${path} missing`);
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

test('scaffolds the service and wires it into the build, the images and the cluster', async () => {
  const tree = seeded();
  await serviceGenerator(tree, {
    name: 'audit-log',
    db: true,
    broker: true,
    description: 'The audit sink.',
  });

  // The package, in the shape the other four have.
  for (const f of [
    'package.json',
    'tsconfig.json',
    'README.md',
    'src/app.ts',
    'src/main.ts',
    'src/index.ts',
    'test/audit-log.test.ts',
  ]) {
    assert.ok(tree.exists(`apps/audit-log/${f}`), `apps/audit-log/${f}`);
  }
  const pkg = JSON.parse(read(tree, 'apps/audit-log/package.json'));
  assert.equal(pkg.name, '@atlas/audit-log');
  assert.equal(pkg.description, 'The audit sink.');
  for (const dep of [
    '@atlas/contracts',
    '@atlas/service-kit',
    '@atlas/data-pg',
    '@atlas/messaging-nats',
    'fastify',
  ]) {
    assert.ok(
      pkg.dependencies[dep],
      `declares ${dep} — an undeclared import is not a graph edge (graph:check)`,
    );
  }

  // The names, cased three ways.
  const app = read(tree, 'apps/audit-log/src/app.ts');
  assert.match(app, /export async function buildAuditLogApp\(/);
  assert.match(app, /goldenSignals\(metrics, 'audit-log'\)/);
  assert.match(app, /'\/api\/v1\/audit-log\/whoami'/);

  // The flags reach main.ts.
  const main = read(tree, 'apps/audit-log/src/main.ts');
  assert.match(main, /migrateWithRetry\(/, '--db: waits for the database within a budget');
  assert.match(main, /new OutboxRelay\(outbox, broker\)/, '--db --broker: relays the outbox');
  assert.match(main, /NatsBroker\.connect\(/);

  // THE WIRING — the list #298 fell out of.
  const root = JSON.parse(read(tree, 'package.json'));
  assert.equal(count(root.scripts['k8s:build'], 'SERVICE=audit-log -t atlas/audit-log:dev'), 1);
  assert.equal(count(root.scripts['k8s:load'], 'atlas/audit-log:dev'), 1);
  assert.ok(root.scripts['k8s:load'].endsWith('atlas/audit-log:dev --name atlas-dev'));

  assert.ok(tree.exists('infra/k8s/base/audit-log.yaml'));
  assert.ok(
    !tree.exists('apps/audit-log/k8s.yaml.template'),
    'the manifest is moved, not left behind',
  );
  const manifest = read(tree, 'infra/k8s/base/audit-log.yaml');
  assert.match(manifest, /image: atlas\/audit-log:dev/);
  assert.match(manifest, /ATLAS_PG_URL/, '--db: the pod gets the database url');
  assert.match(manifest, /ATLAS_NATS_URL/, '--broker: the pod gets the broker url');

  const base = read(tree, 'infra/k8s/base/kustomization.yaml');
  assert.equal(count(base, '  - audit-log.yaml'), 1);
  assert.ok(
    base.indexOf('  - api-gateway.yaml') < base.indexOf('  - audit-log.yaml'),
    'after the last service',
  );

  const dev = read(tree, 'infra/k8s/overlays/dev/kustomization.yaml');
  assert.equal(count(dev, '  - name: atlas/audit-log\n    newTag: dev'), 1);
});

test('a plain service gets neither the database nor the broker', async () => {
  const tree = seeded();
  await serviceGenerator(tree, { name: 'ping' });
  const main = read(tree, 'apps/ping/src/main.ts');
  assert.doesNotMatch(main, /openPool|migrate\(|NatsBroker/);
  const pkg = JSON.parse(read(tree, 'apps/ping/package.json'));
  assert.equal(pkg.dependencies['@atlas/data-pg'], undefined);
  assert.equal(pkg.dependencies['@atlas/messaging-nats'], undefined);
  const manifest = read(tree, 'infra/k8s/base/ping.yaml');
  assert.doesNotMatch(manifest, /ATLAS_PG_URL|ATLAS_NATS_URL/);
});

test('refuses a name that is not kebab-case, an existing directory, and an existing service', async () => {
  const tree = seeded();
  await assert.rejects(serviceGenerator(tree, { name: 'AuditLog' }), /kebab-case/);
  await assert.rejects(serviceGenerator(tree, { name: 'audit_log' }), /kebab-case/);
  await assert.rejects(serviceGenerator(tree, { name: 'mam' }), /existing service/);
  await serviceGenerator(tree, { name: 'once' });
  await assert.rejects(serviceGenerator(tree, { name: 'once' }), /already exists/);
});

test('the wiring is inserted once even if a line is already present', async () => {
  // Defensive: someone hand-added the image before running the generator.
  const tree = seeded();
  const dev = 'infra/k8s/overlays/dev/kustomization.yaml';
  tree.write(
    dev,
    read(tree, dev).replace('patches: []', '  - name: atlas/twice\n    newTag: dev\npatches: []'),
  );
  await serviceGenerator(tree, { name: 'twice' });
  assert.equal(count(read(tree, dev), '  - name: atlas/twice\n    newTag: dev'), 1);
});
