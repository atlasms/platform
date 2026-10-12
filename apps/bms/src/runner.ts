// How the service starts and signals an instance — a port. Production is Temporal
// (temporal/runner.ts); the tests run the same interpreter in-process against the same runtime
// (runner-inprocess.ts), so an instance is exercised end to end without a server.
import type { WorkflowDefinition } from '@atlas/contracts/workflow';
import type { StartContext } from './engine/effects.ts';

export interface InstanceRunner {
  /** Start the instance. Starting an id that is already running is not an error. */
  start(input: { definition: WorkflowDefinition; start: StartContext }): Promise<void>;
  /** Deliver a step's completion, task outcome or event. */
  signal(instanceId: string, stepId: string, payload: Record<string, unknown>): Promise<void>;
}
