// What a waiting step is waiting FOR (EP-22.4), shared by both runners — Temporal's workflow
// (temporal/workflows.ts, deterministic: it is driven only by signals and activity results) and
// the in-process one the tests use — so what the tests prove about matching is what Temporal runs.
//
// A signal is a step's completion, task outcome or event. One from the completion router carries
// the correlation id of the command it answers, and a step waiting on a command takes only the
// answer to the command it issued LAST: an earlier attempt's answer that arrives late — after that
// attempt timed out and the step was retried — is not this attempt's. A signal without a
// correlation id (`POST /instances/{id}/signal`, a person completing a step by hand) is accepted
// by whatever the step is waiting for. An answer may arrive BEFORE the step waits — a fast
// service against the workflow reaching its wait — so every signal is held until taken.

/** A step's completion, task outcome or event, as `POST /instances/{id}/signal` or the router sends it. */
export interface StepSignal {
  stepId: string;
  payload: Record<string, unknown>;
  /** The correlation id of the command this answers; absent from a person's signal. */
  correlationId?: string;
  /** The command failed (`transcode.failed`, …): the step fails with it, and its retries take over. */
  error?: { code: string; message: string };
}

/** Raised from a wait when the command's answer is a failure. */
export class CommandFailed extends Error {
  readonly stepId: string;
  readonly code: string;
  constructor(stepId: string, error: { code: string; message: string }) {
    super(`${error.code}: ${error.message}`);
    this.name = 'CommandFailed';
    this.stepId = stepId;
    this.code = error.code;
  }
}

export class StepInbox {
  /** Held signals by step, then by correlation id ('' for an uncorrelated one). */
  private readonly held = new Map<string, Map<string, StepSignal>>();
  /** The correlation id of the command each step issued last. */
  private readonly expected = new Map<string, string>();

  put(signal: StepSignal): void {
    const byCorrelation = this.held.get(signal.stepId) ?? new Map<string, StepSignal>();
    byCorrelation.set(signal.correlationId ?? '', signal);
    this.held.set(signal.stepId, byCorrelation);
  }

  /** The step issued a command under this correlation id: only its answer completes the wait. */
  expect(stepId: string, correlationId: string): void {
    this.expected.set(stepId, correlationId);
  }

  has(stepId: string): boolean {
    return this.match(stepId) !== undefined;
  }

  /**
   * The signal the step is waiting for, removed — with everything else held for the step, which
   * by then answers a command it no longer waits on. Throws `CommandFailed` for a failure answer.
   */
  take(stepId: string): Record<string, unknown> {
    const signal = this.match(stepId);
    if (signal === undefined) throw new Error(`nothing for step "${stepId}"`);
    this.held.delete(stepId);
    this.expected.delete(stepId);
    if (signal.error !== undefined) throw new CommandFailed(stepId, signal.error);
    return signal.payload;
  }

  private match(stepId: string): StepSignal | undefined {
    const byCorrelation = this.held.get(stepId);
    if (byCorrelation === undefined) return undefined;
    const expected = this.expected.get(stepId);
    return (
      (expected !== undefined ? byCorrelation.get(expected) : undefined) ?? byCorrelation.get('')
    );
  }
}
