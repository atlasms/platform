// How the service starts and signals an instance — a port. Production is Temporal
// (temporal/runner.ts); the tests run the same interpreter in-process against the same runtime
// (runner-inprocess.ts), so an instance is exercised end to end without a server.
import type { WorkflowDefinition } from '@atlas/contracts/workflow';
import type { StartContext } from './engine/effects.ts';
import type { StepSignal } from './engine/inbox.ts';

export interface InstanceRunner {
  /** Start the instance. Starting an id that is already running is not an error. */
  start(input: { definition: WorkflowDefinition; start: StartContext }): Promise<void>;
  /**
   * Deliver a step's completion, task outcome or event. Throws `InstanceNotRunning` when there is
   * no running instance to deliver it to — it has ended, or never ran here.
   */
  signal(instanceId: string, signal: StepSignal): Promise<void>;
}

export class InstanceNotRunning extends Error {
  readonly instanceId: string;
  constructor(instanceId: string) {
    super(`instance ${instanceId} is not running`);
    this.name = 'InstanceNotRunning';
    this.instanceId = instanceId;
  }
}
