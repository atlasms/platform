// The workflow code, bundled when the IMAGE is built (ADR-0010 evidence 2): the Dockerfile runs
// this for any service that has one, and the worker loads dist/workflow-bundle.js instead of
// running webpack at start-up (measured: ~3 s, and a read-only root has nowhere to write it).
// Without the file — a laptop, a test — the worker bundles from source (temporal/runner.ts).
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';

const started = Date.now();
const { code } = await bundleWorkflowCode({
  workflowsPath: fileURLToPath(new URL('./src/temporal/workflows.ts', import.meta.url)),
  logger: { trace() {}, debug() {}, info() {}, warn: console.warn, error: console.error, log() {} },
});
const out = new URL('./dist/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(new URL('workflow-bundle.js', out), code);
console.log(
  `bms: workflow bundle ${(code.length / 1024).toFixed(0)} KiB in ${Date.now() - started} ms`,
);

// In the IMAGE only (the Dockerfile sets ATLAS_IMAGE_BUILD): the SDK's native core ships for five
// platforms (~138 MB) and a Linux image runs one. Never on a laptop — it would delete the
// developer's own binary from node_modules.
if (process.env.ATLAS_IMAGE_BUILD === '1') {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  const keep = `${arch}-unknown-linux-gnu`;
  const releases = join(
    dirname(createRequire(import.meta.url).resolve('@temporalio/core-bridge/package.json')),
    'releases',
  );
  for (const platform of await readdir(releases))
    if (platform !== keep) await rm(join(releases, platform), { recursive: true, force: true });
  console.log(`bms: kept the ${keep} native core only`);
}
