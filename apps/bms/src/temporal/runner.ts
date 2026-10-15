// BMS on Temporal (ADR-0010): the namespace ensured at start-up, the worker that runs every
// instance, and the client that starts and signals them.
//
// The namespace is BMS's to ensure, as a service's migrations are its own — not a Job beside the
// server (a Job is immutable once applied, and the chart is generated from Deployments). The
// worker loads the workflow code BUNDLED AT IMAGE BUILD when the bundle is there (bundle.mjs;
// ADR-0010 evidence 2) and bundles at start only where it is not — a laptop, a test.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from '@temporalio/client';
import { msToTs } from '@temporalio/common/lib/time.js';
import { NativeConnection, Worker } from '@temporalio/worker';
import { InstanceNotRunning, type InstanceRunner } from '../runner.ts';
import type { BmsRuntime } from '../runtime.ts';
import { createActivities } from './activities.ts';

export const TASK_QUEUE = 'bms';

/** The bundle `bundle.mjs` writes when the image is built. */
export const BUNDLE_PATH = fileURLToPath(new URL('../../dist/workflow-bundle.js', import.meta.url));
const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows.ts', import.meta.url));

/** How long a closed instance's history is kept by Temporal (the mirror keeps its summary). */
const RETENTION = '72h';

export interface TemporalOptions {
  address: string;
  namespace: string;
  runtime: BmsRuntime;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface TemporalRuntime {
  runner: InstanceRunner;
  /** Runs the worker until `shutdown()`; rejects if the worker dies. */
  run(): Promise<void>;
  shutdown(): Promise<void>;
  /** The frontend answers — the readiness check. */
  healthy(): Promise<boolean>;
}

export async function connectTemporal(options: TemporalOptions): Promise<TemporalRuntime> {
  const { address, namespace } = options;
  const log = options.log ?? (() => undefined);
  const connection = await Connection.connect({ address });
  await ensureNamespace(connection, namespace, log);
  const client = new Client({ connection, namespace });

  const nativeConnection = await NativeConnection.connect({ address });
  const bundled = bundleIsCurrent();
  if (!bundled && existsSync(BUNDLE_PATH))
    log('temporal workflow bundle is older than the source; bundling from source', {
      bundle: BUNDLE_PATH,
    });
  const worker = await Worker.create({
    connection: nativeConnection,
    namespace,
    taskQueue: TASK_QUEUE,
    activities: createActivities(options.runtime),
    ...(bundled
      ? { workflowBundle: { codePath: BUNDLE_PATH } }
      : { workflowsPath: WORKFLOWS_PATH }),
  });
  log('temporal worker ready', { address, namespace, taskQueue: TASK_QUEUE, bundled });

  const runner: InstanceRunner = {
    async start({ definition, start }) {
      try {
        await client.workflow.start('atlasWorkflow', {
          taskQueue: TASK_QUEUE,
          workflowId: start.instanceId,
          args: [definition, start],
        });
      } catch (err) {
        // The same instance started twice (a retried request) is the same instance.
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      }
    },
    async signal(instanceId, signal) {
      try {
        await client.workflow.getHandle(instanceId).signal('step', signal);
      } catch (err) {
        // Ended (or never started): nothing is waiting, and the caller decides what that means.
        if (err instanceof WorkflowNotFoundError) throw new InstanceNotRunning(instanceId);
        throw err;
      }
    },
  };

  return {
    runner,
    run: () => worker.run(),
    async shutdown() {
      worker.shutdown();
      await connection.close();
    },
    async healthy() {
      try {
        await connection.workflowService.getSystemInfo({});
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The build-time bundle, when it was built from the source beside it. In the image it always was —
 * bundle.mjs runs after the source is copied in. On a laptop a bundle left by an earlier
 * `bundle.mjs` would otherwise run the workflow code of THAT day against today's activities, and
 * every test against a real Temporal would be testing the wrong workflow while passing.
 */
function bundleIsCurrent(): boolean {
  if (!existsSync(BUNDLE_PATH)) return false;
  const built = statSync(BUNDLE_PATH).mtimeMs;
  const srcDir = fileURLToPath(new URL('../', import.meta.url));
  const newest = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((max, entry) => {
      const path = join(dir, entry.name);
      const t = entry.isDirectory() ? newest(path) : statSync(path).mtimeMs;
      return Math.max(max, t);
    }, 0);
  return built >= newest(srcDir);
}

async function ensureNamespace(
  connection: Connection,
  namespace: string,
  log: NonNullable<TemporalOptions['log']>,
): Promise<void> {
  try {
    await connection.workflowService.describeNamespace({ namespace });
    return;
  } catch (err) {
    if ((err as { code?: number }).code !== 5) throw err; // gRPC NOT_FOUND
  }
  try {
    await connection.workflowService.registerNamespace({
      namespace,
      workflowExecutionRetentionPeriod: msToTs(RETENTION),
    });
    log('temporal namespace registered', { namespace });
  } catch (err) {
    // Another replica registered it between the describe and here.
    if ((err as { code?: number }).code !== 6) throw err; // gRPC ALREADY_EXISTS
  }
}
