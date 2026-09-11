// `nx g @atlas/generators:service <name>` — a service that passes the repo's bar on its first run.
//
// The template is DERIVED, not designed: it is what apps/iam, apps/mam, apps/websocket and
// apps/api-gateway agree on, after #313 made the fourth agree with the other three. Every service
// starts the same way — loadConfig, a structured logger, a tracer, a HealthRegistry with IAM as a
// critical dependency, /healthz /readyz /metrics, a ULID correlation id adopted only when
// well-formed, the platform's problem document from every error, every 5xx logged where it is
// raised, graceful drain on SIGTERM — and a fifth written by hand would copy whichever of the four
// it was nearest to, including that one's drift.
//
// It also does the WIRING, which is the part a human forgets: the image in `k8s:build` and
// `k8s:load`, the manifest in the base kustomization, the image tag in the dev overlay. #296
// shipped a manifest for a service whose image `k8s:build` never built; `k8s:up` deployed an
// ImagePullBackOff and every unit test was green. Each of those edits is one line, in a file the
// author of a new service has no reason to open.
//
// Strip-only TypeScript, like everything else here: Nx loads this under Node 24's native type
// stripping, so no build step, no tsx, and no syntax that emits (the eslint rule applies).

import {
  formatFiles,
  generateFiles,
  joinPathFragments,
  names,
  updateJson,
  type Tree,
} from '@nx/devkit';
import { fileURLToPath } from 'node:url';

export interface ServiceGeneratorSchema {
  name: string;
  db?: boolean;
  broker?: boolean;
  description?: string;
}

const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Insert `line` after the last line matching `after` — refused, not duplicated, if already there. */
function insertAfterLast(text: string, after: RegExp, line: string): string {
  if (text.includes(line)) return text;
  const lines = text.split('\n');
  let at = -1;
  lines.forEach((l, i) => {
    if (after.test(l)) at = i;
  });
  if (at < 0)
    throw new Error(`could not find where to insert "${line.trim()}" — no line matches ${after}`);
  lines.splice(at + 1, 0, line);
  return lines.join('\n');
}

export async function serviceGenerator(tree: Tree, options: ServiceGeneratorSchema): Promise<void> {
  const name = options.name.trim();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `"${name}" is not kebab-case — the name becomes a package, an image and a k8s Service`,
    );
  }
  const dir = joinPathFragments('apps', name);
  if (tree.exists(dir)) throw new Error(`${dir} already exists`);
  for (const taken of ['iam', 'mam', 'websocket', 'api-gateway', 'studio', 'walking-skeleton']) {
    if (name === taken) throw new Error(`"${name}" is an existing service`);
  }

  const n = names(name);
  const db = options.db === true;
  const broker = options.broker === true;
  const description =
    options.description?.trim() ||
    `The ${n.className} service. TODO: one sentence on what it owns.`;

  // --- apps/<name> ---------------------------------------------------------------------------------
  const templates = fileURLToPath(new URL('./files', import.meta.url));
  generateFiles(tree, templates, dir, {
    name,
    className: n.className,
    propertyName: n.propertyName,
    constantName: n.constantName,
    db,
    broker,
    description,
    tmpl: '',
  });

  // --- the wiring ----------------------------------------------------------------------------------

  // Images: `k8s:build` builds one per service and `k8s:load` pushes them onto the kind node. Both
  // are hand-maintained lists, and a service missing from them deploys as ImagePullBackOff.
  updateJson(tree, 'package.json', (pkg: { scripts: Record<string, string> }) => {
    const buildScript = pkg.scripts['k8s:build'];
    const loadScript = pkg.scripts['k8s:load'];
    // Loud, not `undefined + '...'`: a root package.json without these is a repo this generator
    // does not know how to wire, and a service that is not in them is exactly #298.
    if (buildScript === undefined || loadScript === undefined) {
      throw new Error('package.json has no k8s:build / k8s:load scripts to register the image in');
    }
    const build = `docker build -f infra/docker/Dockerfile --build-arg SERVICE=${name} -t atlas/${name}:dev .`;
    if (!buildScript.includes(build)) pkg.scripts['k8s:build'] = `${buildScript} && ${build}`;
    const image = `atlas/${name}:dev`;
    if (!loadScript.includes(image)) {
      pkg.scripts['k8s:load'] = loadScript.replace(
        ' --name atlas-dev',
        ` ${image} --name atlas-dev`,
      );
    }
    return pkg;
  });

  // The manifest, and its two registrations.
  tree.write(
    joinPathFragments('infra/k8s/base', `${name}.yaml`),
    tree.read(joinPathFragments(dir, 'k8s.yaml.template'), 'utf8') ?? '',
  );
  tree.delete(joinPathFragments(dir, 'k8s.yaml.template'));

  const base = 'infra/k8s/base/kustomization.yaml';
  tree.write(
    base,
    insertAfterLast(
      tree.read(base, 'utf8') ?? '',
      /^\s+- api-gateway\.yaml\s*$/,
      `  - ${name}.yaml`,
    ),
  );

  const dev = 'infra/k8s/overlays/dev/kustomization.yaml';
  tree.write(
    dev,
    insertAfterLast(
      tree.read(dev, 'utf8') ?? '',
      /^\s+newTag: dev\s*$/,
      `  - name: atlas/${name}\n    newTag: dev`,
    ),
  );

  await formatFiles(tree);
}

export default serviceGenerator;
