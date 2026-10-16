// The instance's activities: the runtime's methods, as Temporal calls them. Thin on purpose — the
// behaviour (and its idempotency) is runtime.ts's, tested without a server.
//
// One thing is decided here: what is worth retrying. The workflow retries an activity without a
// limit, which is right for a database blip and wrong for a refusal — a sub-flow whose workflow
// was deactivated (EP-22.11) is not going to be active on the next attempt. A 4xx AppError is
// therefore raised NON-RETRYABLE: the step fails at once and the instance's error handling runs.
import { ApplicationFailure } from '@temporalio/activity';
import { AppError } from '@atlas/service-kit';
import type { BmsRuntime } from '../runtime.ts';

function settled<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof AppError && err.status < 500)
        throw ApplicationFailure.nonRetryable(err.message, err.code);
      throw err;
    }
  };
}

export function createActivities(runtime: BmsRuntime) {
  return {
    recordHistory: settled((input: Parameters<BmsRuntime['recordHistory']>[0]) =>
      runtime.recordHistory(input),
    ),
    requestStep: settled((input: Parameters<BmsRuntime['requestStep']>[0]) =>
      runtime.requestStep(input),
    ),
    awaitEvent: settled((input: Parameters<BmsRuntime['awaitEvent']>[0]) =>
      runtime.awaitEvent(input),
    ),
    createTask: settled((input: Parameters<BmsRuntime['createTask']>[0]) =>
      runtime.createTask(input),
    ),
    prepareChild: settled((input: Parameters<BmsRuntime['prepareChild']>[0]) =>
      runtime.prepareChild(input),
    ),
    finish: settled((input: Parameters<BmsRuntime['finish']>[0]) => runtime.finish(input)),
  };
}

export type BmsActivities = ReturnType<typeof createActivities>;
