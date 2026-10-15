// A running workflow, as BMS mirrors it (bms-workflow-dsl-and-designer.md §7). Temporal holds the
// instance — its timers, its waits, its history of record (ADR-0010); this mirror is what the API
// lists and what Studio's overlay reads (FR-BMS-6), written by the instance's own activities as it
// moves. `version` is the published version it is pinned to for its whole life.

import type { HistoryEvent } from './engine/effects.ts';

export type InstanceState = 'running' | 'waiting' | 'completed' | 'failed';

export interface Instance {
  id: string;
  channelId: string;
  workflowId: string;
  version: number;
  assetId?: string;
  /** A sub-flow's instance names the instance that started it. */
  parentId?: string;
  state: InstanceState;
  /** The steps it is waiting in — more than one inside a parallel split. */
  currentSteps: string[];
  startedAt: string;
  startedBy: string;
  endedAt?: string;
  endStepId?: string;
  error?: string;
  /** Its vars when it ended. */
  vars?: Record<string, unknown>;
}

export interface HistoryEntry {
  instanceId: string;
  channelId: string;
  /** The instance's own sequence: deterministic, so a retried write lands on the same row. */
  seq: number;
  stepId: string;
  event: HistoryEvent;
  at: string;
  result?: unknown;
}

export const isTerminal = (s: InstanceState): boolean => s === 'completed' || s === 'failed';

/** The mirror after one history event: where it waits, and whether it is waiting at all. */
export function afterHistory(i: Instance, stepId: string, event: HistoryEvent): Instance {
  if (isTerminal(i.state)) return i;
  const waiting = new Set(i.currentSteps);
  if (event === 'awaiting') waiting.add(stepId);
  else if (event === 'completed' || event === 'failed' || event === 'compensated')
    waiting.delete(stepId);
  const currentSteps = [...waiting];
  return { ...i, currentSteps, state: currentSteps.length > 0 ? 'waiting' : 'running' };
}

/**
 * A command a command step issued (EP-22.4): its correlation id is the one the target carries to
 * its answer, and the completion router finds the waiting step by it. Answered at most once.
 */
export interface CommandAwait {
  /** The command envelope's correlationId — a ULID derived from the instance and the activity. */
  correlationId: string;
  channelId: string;
  instanceId: string;
  stepId: string;
  /** The command, e.g. `transcode.job.create`. */
  command: string;
  issuedAt: string;
  /** When its answer reached the instance; absent while outstanding. */
  answeredAt?: string;
  /** The message id of the answer. */
  answeredBy?: string;
}
