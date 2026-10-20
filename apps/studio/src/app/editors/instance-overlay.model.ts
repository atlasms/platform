// The live-instance overlay (EP-23.9; DSL doc §12.4, FR-BMS-6): an instance's step history painted
// on the SAME graph the designer edits — the version it is pinned to, read-only. Pure: the history
// in, a status per step out.
import type { HistoryEntry } from '../core/generated/bms.types.ts';

/** What a step is in this run. A step the run never reached has none. */
export type StepStatus = 'active' | 'waiting' | 'done' | 'failed' | 'compensated';

const BY_EVENT: Record<HistoryEntry['event'], StepStatus> = {
  entered: 'active',
  awaiting: 'waiting',
  escalated: 'waiting',
  completed: 'done',
  failed: 'failed',
  compensated: 'compensated',
};

/**
 * Each step's status: its LAST history event, in sequence order (a loop re-enters a step, and the
 * latest pass is the one that matters). A step the instance says it is waiting in is waiting,
 * whatever the mirror last wrote for it — `currentSteps` is the fresher of the two.
 */
export function stepStatuses(
  history: readonly HistoryEntry[],
  currentSteps: readonly string[] = [],
): Record<string, StepStatus> {
  const out: Record<string, StepStatus> = {};
  for (const h of [...history].sort((a, b) => a.seq - b.seq)) out[h.stepId] = BY_EVENT[h.event];
  for (const id of currentSteps) out[id] = 'waiting';
  return out;
}

/** Whether a run can still move — and so whether the overlay keeps reading it. */
export const isLive = (state: string): boolean => state === 'running' || state === 'waiting';

/** How often a live run is re-read: BMS publishes no event per step (its history is its own). */
export const OVERLAY_REFRESH_MS = 3_000;
