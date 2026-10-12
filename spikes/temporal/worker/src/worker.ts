// The worker, run as our containers run a service: `node src/worker.ts`, Node's strip-only
// TypeScript, no tsx, no bundler at start. It loads the PREBUILT workflow bundle.
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.ts';

const address = process.env['TEMPORAL_ADDRESS'] ?? 'localhost:7233';
const taskQueue = process.env['TASK_QUEUE'] ?? 'spike';
const t0 = Date.now();
const connection = await NativeConnection.connect({ address });
const worker = await Worker.create({
  connection,
  namespace: 'atlas',
  taskQueue,
  workflowBundle: {
    codePath: fileURLToPath(new URL('../dist/workflow-bundle.js', import.meta.url)),
  },
  activities,
});
console.log(`worker ready in ${Date.now() - t0} ms on ${process.env['IMAGE'] ?? 'unknown'}`);
await worker.run();
