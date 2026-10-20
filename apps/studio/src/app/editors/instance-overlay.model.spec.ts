import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../core/generated/bms.types.ts';
import { isLive, stepStatuses } from './instance-overlay.model.ts';

const h = (seq: number, stepId: string, event: HistoryEntry['event']): HistoryEntry => ({
  seq,
  stepId,
  event,
  at: `2026-10-20T10:00:${String(seq).padStart(2, '0')}.000Z`,
});

describe('stepStatuses — where a run is, step by step', () => {
  it('each step is its LAST event, in sequence order', () => {
    const history = [
      h(4, 's_review', 'awaiting'),
      h(1, 's_start', 'entered'),
      h(2, 's_start', 'completed'),
      h(3, 's_review', 'entered'),
    ];
    expect(stepStatuses(history)).toEqual({ s_start: 'done', s_review: 'waiting' });
  });

  it('a loop re-entering a step shows its latest pass; failure and compensation are their own', () => {
    const history = [
      h(1, 's_try', 'entered'),
      h(2, 's_try', 'completed'),
      h(3, 's_try', 'entered'),
      h(4, 's_try', 'failed'),
      h(5, 's_undo', 'compensated'),
    ];
    expect(stepStatuses(history)).toEqual({ s_try: 'failed', s_undo: 'compensated' });
  });

  it('a step the instance says it waits in is waiting, whatever the mirror last wrote', () => {
    expect(stepStatuses([h(1, 's_wait', 'entered')], ['s_wait'])).toEqual({ s_wait: 'waiting' });
    expect(stepStatuses([], ['s_x'])).toEqual({ s_x: 'waiting' });
    expect(stepStatuses([h(1, 's_esc', 'escalated')])).toEqual({ s_esc: 'waiting' });
  });

  it('only a running or waiting run is followed', () => {
    expect(['running', 'waiting', 'completed', 'failed'].map(isLive)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});
