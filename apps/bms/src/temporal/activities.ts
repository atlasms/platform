// The instance's activities: the runtime's methods, as Temporal calls them. Thin on purpose — the
// behaviour (and its idempotency) is runtime.ts's, tested without a server.
import type { BmsRuntime } from '../runtime.ts';

export function createActivities(runtime: BmsRuntime) {
  return {
    recordHistory: (input: Parameters<BmsRuntime['recordHistory']>[0]) =>
      runtime.recordHistory(input),
    requestStep: (input: Parameters<BmsRuntime['requestStep']>[0]) => runtime.requestStep(input),
    createTask: (input: Parameters<BmsRuntime['createTask']>[0]) => runtime.createTask(input),
    prepareChild: (input: Parameters<BmsRuntime['prepareChild']>[0]) => runtime.prepareChild(input),
    finish: (input: Parameters<BmsRuntime['finish']>[0]) => runtime.finish(input),
  };
}

export type BmsActivities = ReturnType<typeof createActivities>;
