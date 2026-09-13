import { describe, expect, it } from 'vitest';
import type { ScheduleItem } from '../core/generated/scheduling.types.ts';
import {
  append,
  endOf,
  fromItems,
  move,
  newRow,
  patch,
  problems,
  reflow,
  remove,
  span,
  toInputs,
  topLevel,
  type ReelRow,
} from './reel.model.ts';

const T0 = '2026-09-12T06:00:00.000Z';
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString();

const row = (key: string, startMin: number, durationMin: number, extra: Partial<ReelRow> = {}) =>
  newRow(
    {
      start: at(startMin),
      durationSec: durationMin * 60,
      fixed: false,
      itemType: 'media',
      mediaId: 'm',
      ...extra,
    },
    key,
  );

/** A live row: no mediaId key at all (exactOptionalPropertyTypes forbids `mediaId: undefined`). */
const liveRow = (
  key: string,
  startMin: number,
  durationMin: number,
  extra: Partial<ReelRow> = {},
) =>
  newRow(
    {
      start: at(startMin),
      durationSec: durationMin * 60,
      fixed: false,
      itemType: 'live',
      ...extra,
    },
    key,
  );

const starts = (rows: readonly ReelRow[]) =>
  topLevel(rows).map((r) => [r.key, (Date.parse(r.start) - Date.parse(T0)) / 60_000] as const);

describe('reflow (rule 1)', () => {
  it('chains every non-fixed item onto the previous end, whatever starts it arrived with', () => {
    const rows = reflow([row('a', 0, 30), row('b', 99, 10), row('c', 5, 20)]);
    expect(starts(rows)).toEqual([
      ['a', 0],
      ['b', 30],
      ['c', 40],
    ]);
  });

  it('keeps a fixed anchor where it is and flows the rest from it', () => {
    const rows = reflow([row('a', 0, 30), row('anchor', 60, 10, { fixed: true }), row('c', 0, 5)]);
    expect(starts(rows)).toEqual([
      ['a', 0],
      ['anchor', 60],
      ['c', 70],
    ]);
  });

  it('is pure and stable: an already-flowed reel comes back equal, row for row', () => {
    const rows = reflow([row('a', 0, 30), row('b', 30, 10)]);
    const again = reflow(rows);
    expect(again).toEqual(rows);
    expect(again[0]).toBe(rows[0]);
  });

  it("shifts a live item's sub-reel by exactly what the parent moved", () => {
    const live = liveRow('live', 100, 60);
    const child = row('child', 110, 5, { parentKey: 'live' });
    const rows = reflow([row('a', 0, 30), live, child]);
    // live moved from 100 to 30 (-70); the child follows: 110 -> 40.
    expect(rows.find((r) => r.key === 'live')?.start).toBe(at(30));
    expect(rows.find((r) => r.key === 'child')?.start).toBe(at(40));
  });
});

describe('problems (rules 2 and 3)', () => {
  it('reports an anchor that starts inside the previous item as an OVERLAP', () => {
    const rows = reflow([row('a', 0, 30), row('anchor', 20, 10, { fixed: true })]);
    const p = problems(rows);
    expect([...p.overlaps]).toEqual(['anchor']);
    expect(p.gaps.size).toBe(0);
  });

  it('reports an anchor after the previous end as a GAP of that many seconds — not an overlap', () => {
    const rows = reflow([row('a', 0, 30), row('anchor', 45, 10, { fixed: true }), row('c', 0, 5)]);
    const p = problems(rows);
    expect(p.overlaps.size).toBe(0);
    expect([...p.gaps]).toEqual([['anchor', 15 * 60]]);
  });

  it('a chained reel has neither', () => {
    const p = problems(reflow([row('a', 0, 30), row('b', 0, 10), row('c', 0, 5)]));
    expect(p.overlaps.size + p.gaps.size).toBe(0);
  });

  it('ignores sub-reel rows: a child inside its live parent is not an overlap with it', () => {
    const live = liveRow('live', 30, 60);
    const child = row('child', 35, 5, { parentKey: 'live' });
    const p = problems(reflow([row('a', 0, 30), live, child]));
    expect(p.overlaps.size).toBe(0);
  });
});

describe('edits', () => {
  it('append lands at the end of the reel unless fixed', () => {
    const rows = append([row('a', 0, 30)], row('b', 0, 10));
    expect(starts(rows)).toEqual([
      ['a', 0],
      ['b', 30],
    ]);
    const anchored = append(rows, row('c', 120, 10, { fixed: true }));
    expect(starts(anchored)[2]).toEqual(['c', 120]);
  });

  it('move swaps with the neighbour and re-times; the ends of the reel are walls', () => {
    const rows = reflow([row('a', 0, 30), row('b', 0, 10), row('c', 0, 5)]);
    const up = move(rows, 'c', 'up');
    expect(starts(up)).toEqual([
      ['a', 0],
      ['c', 30],
      ['b', 35],
    ]);
    expect(starts(move(rows, 'a', 'up'))).toEqual(starts(rows));
    expect(starts(move(rows, 'c', 'down'))).toEqual(starts(rows));
  });

  it('move takes a live item’s children along, in order, and they re-time with it', () => {
    const live = liveRow('live', 0, 60);
    const c1 = row('c1', 0, 5, { parentKey: 'live' });
    const c2 = row('c2', 5, 5, { parentKey: 'live' });
    const rows = reflow([row('a', 0, 30), live, c1, c2, row('z', 0, 10)]);
    const moved = move(rows, 'live', 'down');
    expect(moved.map((r) => r.key)).toEqual(['a', 'z', 'live', 'c1', 'c2']);
    expect(moved.find((r) => r.key === 'live')?.start).toBe(at(40));
    expect(moved.find((r) => r.key === 'c1')?.start).toBe(at(40));
    expect(moved.find((r) => r.key === 'c2')?.start).toBe(at(45));
  });

  it('remove closes the hole, and removing a live item removes its sub-reel', () => {
    const live = liveRow('live', 0, 60);
    const child = row('child', 0, 5, { parentKey: 'live' });
    const rows = reflow([row('a', 0, 30), live, child, row('z', 0, 10)]);
    const without = remove(rows, 'live');
    expect(without.map((r) => r.key)).toEqual(['a', 'z']);
    expect(starts(without)).toEqual([
      ['a', 0],
      ['z', 30],
    ]);
  });

  it('patch re-times everything after the changed row', () => {
    const rows = reflow([row('a', 0, 30), row('b', 0, 10), row('c', 0, 5)]);
    const longer = patch(rows, 'a', { durationSec: 45 * 60 });
    expect(starts(longer)).toEqual([
      ['a', 0],
      ['b', 45],
      ['c', 55],
    ]);
  });

  it('unfixing an anchor lets it flow; fixing one holds its current start', () => {
    const rows = reflow([row('a', 0, 30), row('anchor', 45, 10, { fixed: true })]);
    expect(starts(patch(rows, 'anchor', { fixed: false }))[1]).toEqual(['anchor', 30]);
    const held = patch(reflow([row('a', 0, 30), row('b', 0, 10)]), 'b', { fixed: true });
    expect(starts(patch(held, 'a', { durationSec: 10 * 60 }))).toEqual([
      ['a', 0],
      ['b', 30],
    ]);
  });
});

describe('the wire', () => {
  const item = (overrides: Partial<ScheduleItem>): ScheduleItem => ({
    id: 'i1',
    scheduleId: 's1',
    seq: 0,
    start: at(0),
    durationSec: 60,
    end: at(1),
    fixed: false,
    itemType: 'media',
    mediaId: 'm1',
    description: '',
    repeat: false,
    featured: false,
    ...overrides,
  });

  const liveItem = (overrides: Partial<ScheduleItem>): ScheduleItem => {
    const { mediaId: _m, ...base } = item({ itemType: 'live', ...overrides });
    void _m;
    return base;
  };

  it('round-trips the service’s items: seq is the position, children carry their parent id', () => {
    const rows = fromItems([
      item({ id: 'a', seq: 0 }),
      liveItem({ id: 'live', seq: 1, start: at(1), durationSec: 600 }),
      item({ id: 'k', seq: 0, parentItemId: 'live', start: at(1), durationSec: 60 }),
      item({ id: 'z', seq: 2, start: at(11) }),
    ]);
    const inputs = toInputs(rows);
    expect(inputs.map((i) => [i.id, i.seq, i.parentItemId])).toEqual([
      ['a', 0, undefined],
      ['live', 1, undefined],
      ['k', 0, 'live'],
      ['z', 2, undefined],
    ]);
    expect(inputs[1]).not.toHaveProperty('mediaId');
    expect(inputs[0]).not.toHaveProperty('end');
  });

  it('a new row has no id, and gets its position from where it sits after a move', () => {
    const rows = move([...fromItems([item({ id: 'a' })]), row('new', 0, 5)], 'new', 'up');
    const inputs = toInputs(rows);
    expect(inputs.map((i) => [i.id, i.seq])).toEqual([
      [undefined, 0],
      ['a', 1],
    ]);
  });

  it('refuses to send a child whose parent has no id yet', () => {
    const rows = [liveRow('p', 0, 5), row('c', 0, 1, { parentKey: 'p' })];
    expect(() => toInputs(rows)).toThrow(/unsaved parent/);
  });

  it('span and endOf', () => {
    expect(endOf(at(0), 90)).toBe(new Date(Date.parse(T0) + 90_000).toISOString());
    expect(span(reflow([row('a', 0, 30), row('b', 0, 10)]))).toBe(40 * 60);
    expect(span([])).toBe(0);
  });
});
