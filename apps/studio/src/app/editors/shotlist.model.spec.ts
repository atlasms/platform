import { describe, expect, it } from 'vitest';
import {
  bodyOf,
  changed,
  formatTimecode,
  newRow,
  parseTimecode,
  problemsOf,
  rowsOf,
} from './shotlist.model.ts';

describe('shot-list timecodes', () => {
  it('reads HH:MM:SS.mmm, MM:SS and seconds — and refuses what is not one', () => {
    expect(parseTimecode('01:02:03.450')).toBe(3_723_450);
    expect(parseTimecode('2:03')).toBe(123_000);
    expect(parseTimecode('2:03.5')).toBe(123_500);
    expect(parseTimecode('75')).toBe(75_000);
    expect(parseTimecode(' 75.25 ')).toBe(75_250);
    for (const bad of ['', '1:2:3:4', '1:60', '1:60:00', 'ab', '1::2', '1.2345', '-1'])
      expect(parseTimecode(bad), bad).toBeUndefined();
  });

  it('shows milliseconds as HH:MM:SS.mmm, and the two round-trip', () => {
    expect(formatTimecode(3_723_450)).toBe('01:02:03.450');
    expect(formatTimecode(0)).toBe('00:00:00.000');
    for (const ms of [0, 1, 999, 61_001, 3_599_999, 36_000_000])
      expect(parseTimecode(formatTimecode(ms))).toBe(ms);
  });
});

describe('shot-list rows', () => {
  const stored = [{ id: 'S1', startMs: 0, endMs: 4_000, description: 'Opening' }];

  it('a stored list becomes rows and back unchanged — and an edit is a change', () => {
    const rows = rowsOf(stored);
    expect(bodyOf(rows)).toEqual({ items: stored });
    expect(changed(rows, stored)).toBe(false);
    expect(changed([{ ...rows[0]!, description: 'Opening titles' }], stored)).toBe(true);
    expect(changed([], stored)).toBe(true);
  });

  it('a new row starts where the last one ends, and carries no id until MAM gives it one', () => {
    const row = newRow(rowsOf(stored), 'k1');
    expect(row.start).toBe('00:00:04.000');
    expect(row.id).toBeUndefined();
    expect(newRow([], 'k2').start).toBe('00:00:00.000');
  });

  it('a timecode that is not one is the form’s problem, at its path, before MAM is asked', () => {
    const rows = [
      ...rowsOf(stored),
      { key: 'k', start: '00:00:05', end: 'soon', description: 'x' },
    ];
    expect(bodyOf(rows)).toEqual({ problems: { 'items/1/endMs': 'timecode' } });
  });

  it("MAM's 422 problems become a path → message map", () => {
    expect(
      problemsOf({ problems: [{ path: 'items/0/endMs', message: 'must be after startMs' }] }),
    ).toEqual({ 'items/0/endMs': 'must be after startMs' });
    expect(problemsOf(undefined)).toEqual({});
  });
});
