// A running workflow, as BMS mirrors it (bms-workflow-dsl-and-designer.md §7). Temporal holds the
// instance — its timers, its waits, its history of record (ADR-0010); this mirror is what the API
// lists and what Studio's overlay reads (FR-BMS-6), written by the instance's own activities as it
// moves. `version` is the published version it is pinned to for its whole life.

import type { HistoryEvent } from './engine/effects.ts';

export type InstanceState = 'running' | 'waiting' | 'completed' | 'failed';
export const INSTANCE_STATES: readonly InstanceState[] = [
  'running',
  'waiting',
  'completed',
  'failed',
];

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
  /** A user, or `bms` when its trigger started it. */
  startedBy: string;
  /** Its start step's trigger started it (EP-22.7): the event, and the message. */
  triggeredBy?: { event: string; messageId: string };
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

/**
 * A step waiting for an EVENT rather than an answer (EP-22.6; bms.md §13f) — a wait-event step, or a
 * review step waiting for MAM's verdict. Nobody carries a correlation id to an event BMS did not
 * ask for, so the router finds the step by the event's KEYS instead: `match` holds the values the
 * step's `correlate` evaluated to when it started waiting. Answered at most once.
 */
export interface EventAwait {
  /**
   * What the waiting step expects its signal to carry (StepInbox): a ULID derived from the instance
   * and the activity, or — for a review step — its task's id, shared by its two verdict rows.
   */
  correlationId: string;
  /** One of WORKFLOW_EVENTS. */
  eventType: string;
  channelId: string;
  instanceId: string;
  stepId: string;
  /** Payload path (dotted) → the value it must equal. */
  match: Record<string, unknown>;
  /**
   * A review step's verdict await: the point it reviews. A verdict naming this point, or naming
   * none, resolves it (decided 2026-10-16); one naming another point does not.
   */
  reviewPointId?: string;
  issuedAt: string;
  answeredAt?: string;
  /** The message id of the event that answered it. */
  answeredBy?: string;
}

/** The asset an await is keyed on — the column every asset event narrows by. */
export const assetKey = (a: EventAwait): string | null =>
  typeof a.match['assetId'] === 'string' ? a.match['assetId'] : null;

/**
 * A waitable event as the router received it (EP-22.7, decided 2026-10-17), kept for a while so a
 * step that starts waiting AFTER it was published still finds it — the earliest matching one since
 * its instance started. Pruned after EVENT_BUFFER_DAYS.
 */
export interface BufferedEvent {
  messageId: string;
  channelId: string;
  eventType: string;
  assetId?: string;
  /** The envelope's — what "since its instance started" compares. */
  occurredAt: string;
  correlationId?: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}

/** How long a waitable event is kept for a step that has not started waiting yet. */
export const EVENT_BUFFER_DAYS = 7;
