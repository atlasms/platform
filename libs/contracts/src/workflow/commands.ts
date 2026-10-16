// The commands a workflow may issue (EP-22.4; bms.md §13d). A command step is carried out by
// publishing the target service's OWN command — so the list is closed, and closed here, in the
// contracts both sides read: a workflow author with `workflow:admin` must not be able to make BMS
// publish a FACT (`asset.approved`, `permissions.changed`) that another service would believe, nor a
// command nobody consumes, whose step would wait forever.
//
// Each command names the events that answer it. Both are matched to the step by the envelope's
// `correlationId`, which the target carries from the command to its answer (follow()'s rule,
// EP-03.5); a `fails` event carries `error: { code, message }` and fails the step, so its retries
// and `onError` take over instead of its timeout.
//
// Adding a command is a code change on both sides — the target consumes it and answers it under
// the command's correlation id — so it is a Tier-0 list, not a registry an operator edits.

export interface WorkflowCommand {
  /** The service that carries it out — `workflow.step.requested.target`. */
  target: string;
  /**
   * The authority the command exercises — what the target would demand of a person asking it
   * directly (decided 2026-10-16: a command step carries its PUBLISHER's authority). BMS issues the
   * command as itself, and the target trusts its issuer; so whoever publishes or activates a
   * workflow that issues it must hold this, channel-wide — and then anyone allowed to start the
   * workflow runs it, because an administrator vouched for it (SQL's "security definer").
   */
  requires: { permission: string; resource: { type: string; fieldGroup?: string } };
  /** The events that complete the step; `await.event` must name one of these. */
  completes: readonly string[];
  /** The events that fail the step. */
  fails: readonly string[];
}

export const WORKFLOW_COMMANDS: Readonly<Record<string, WorkflowCommand>> = {
  'transcode.job.create': {
    target: 'mts',
    // MTS's own rule for a transcode over HTTP: renditions are the `files` group (mts.md §10).
    requires: { permission: 'asset:write', resource: { type: 'asset', fieldGroup: 'files' } },
    completes: ['transcode.completed'],
    fails: ['transcode.failed'],
  },
};

/** Every event that answers some command — what BMS's completion router subscribes to. */
export function commandAnswers(): { completes: string[]; fails: string[] } {
  const completes = new Set<string>();
  const fails = new Set<string>();
  for (const c of Object.values(WORKFLOW_COMMANDS)) {
    c.completes.forEach((e) => completes.add(e));
    c.fails.forEach((e) => fails.add(e));
  }
  return { completes: [...completes].sort(), fails: [...fails].sort() };
}
