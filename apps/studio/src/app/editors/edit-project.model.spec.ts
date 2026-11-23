import { describe, expect, it } from 'vitest';
import type { EditProject, FileRef } from '../core/generated/mam.types.ts';
import {
  changed,
  lengthMs,
  moved,
  newRow,
  profilesFor,
  refsOf,
  rowsOf,
  timelineOf,
} from './edit-project.model.ts';

const project = (clips: EditProject['timeline']['clips'], outputProfile?: string): EditProject =>
  ({
    id: 'P1',
    sourceAssetId: 'A1',
    mediaKind: 'video',
    state: 'draft',
    timeline: { clips },
    ...(outputProfile ? { outputProfile } : {}),
    version: 2,
    createdBy: 'u1',
    createdAt: '2026-11-23T09:00:00.000Z',
    updatedAt: '2026-11-23T09:00:00.000Z',
  }) as EditProject;

const file = (kind: FileRef['kind'], variant?: string): FileRef =>
  ({ kind, ...(variant ? { variant } : {}) }) as FileRef;

describe('edit-project.model', () => {
  it('offers the media files of the source to cut from — masters first, never a still', () => {
    expect(
      refsOf([
        file('thumbnail'),
        file('proxy', 'edit'),
        file('proxy'),
        file('original'),
        file('vtt-filmstrip', 'sprite'),
        file('broadcast'),
      ]),
    ).toEqual(['original', 'broadcast', 'proxy', 'proxy/edit']);
  });

  it('offers the built-in profiles that make media of the kind, keeping one already set', () => {
    expect(profilesFor('video')).toEqual(['broadcast', 'proxy']);
    expect(profilesFor('audio')).toEqual(['audio-proxy']);
    expect(profilesFor('photo')).toEqual([]);
    expect(profilesFor('video', 'house-hd')).toEqual(['broadcast', 'proxy', 'house-hd']);
  });

  it('round-trips seconds through timecodes to the millisecond, keeping what it does not edit', () => {
    const p = project([
      { renditionRef: 'original', inSec: 1.5, outSec: 62.25 },
      { renditionRef: 'original', inSec: 70, outSec: 71, transitionIn: 'dissolve' },
    ]);
    const rows = rowsOf(p, (i) => `k${i}`);
    expect(rows.map((r) => [r.in, r.out])).toEqual([
      ['00:00:01.500', '00:01:02.250'],
      ['00:01:10.000', '00:01:11.000'],
    ]);
    expect(timelineOf(rows)).toEqual({ timeline: p.timeline });
    expect(changed(rows, undefined, p)).toBe(false);
    expect(lengthMs(rows)).toBe(61_750);
  });

  it('refuses a timecode that is not one, and an out before its in, at MAM’s paths', () => {
    const rows = rowsOf(project([{ renditionRef: 'original', inSec: 0, outSec: 5 }]), () => 'k');
    expect(timelineOf([{ ...rows[0]!, in: '1:7x' }])).toEqual({
      problems: { 'timeline/clips/0/inSec': 'timecode' },
    });
    expect(timelineOf([{ ...rows[0]!, in: '00:00:09', out: '00:00:05' }])).toEqual({
      problems: { 'timeline/clips/0/outSec': 'order' },
    });
  });

  it('is dirty on a trim, a reorder, a new clip or a new profile — and not on a retyped value', () => {
    const p = project([
      { renditionRef: 'original', inSec: 0, outSec: 5 },
      { renditionRef: 'original', inSec: 10, outSec: 12 },
    ]);
    const rows = rowsOf(p, (i) => `k${i}`);
    expect(changed([{ ...rows[0]!, in: '0' }, rows[1]!], undefined, p)).toBe(false);
    expect(changed([{ ...rows[0]!, out: '00:00:04.960' }, rows[1]!], undefined, p)).toBe(true);
    expect(changed(moved(rows, 0, 1), undefined, p)).toBe(true);
    expect(changed([...rows, newRow(rows, ['original'], 'n')], undefined, p)).toBe(true);
    expect(changed(rows, 'broadcast', p)).toBe(true);
  });

  it('a new clip starts where the last ended, from the same file; moves stay in range', () => {
    const rows = rowsOf(project([{ renditionRef: 'proxy', inSec: 3, outSec: 8 }]), () => 'k');
    expect(newRow(rows, ['original'], 'n')).toEqual({
      key: 'n',
      renditionRef: 'proxy',
      in: '00:00:08.000',
      out: '',
    });
    expect(newRow([], ['original', 'proxy'], 'n').renditionRef).toBe('original');
    expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
  });
});
