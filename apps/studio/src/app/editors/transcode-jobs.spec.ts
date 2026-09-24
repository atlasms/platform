// An asset's transcode jobs on its Files tab (EP-16): what each state shows, a poll that runs while
// something is moving and stops by itself, `completed` only for a job this view watched finish, a
// refusal of the read hidden rather than shown, and nothing left ticking once the tab is closed.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from '../core/generated/mts.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { TranscodeJobsService } from '../core/transcode-jobs.service.ts';
import { TranscodeJobs } from './transcode-jobs.ts';

const ASSET = '01K00000000000000000000000';

class FakeJobs {
  readonly reads: Array<{ assetId: string; result: Subject<Job[]> }> = [];
  forAsset(assetId: string) {
    const result = new Subject<Job[]>();
    this.reads.push({ assetId, result });
    return result;
  }
}

const job = (id: string, state: Job['state'], over: Partial<Job> = {}): Job => ({
  id,
  channelId: 'ch12',
  assetId: ASSET,
  presetIds: ['proxy', 'thumbnail'],
  inputPath: '/work/in.mp4',
  state,
  attempts: 1,
  priority: 0,
  createdBy: 'u1',
  createdAt: '2026-09-24T10:00:00.000Z',
  updatedAt: '2026-09-24T10:00:00.000Z',
  version: 1,
  ...over,
});

function setup() {
  const fake = new FakeJobs();
  TestBed.configureTestingModule({
    providers: [
      { provide: TranscodeJobsService, useValue: fake },
      { provide: LocaleService, useValue: { t: (k: string) => k, locale: () => 'en' } },
    ],
  });
  const fixture = TestBed.createComponent(TranscodeJobs);
  fixture.componentRef.setInput('assetId', ASSET);
  const completed: Job[] = [];
  fixture.componentInstance.completed.subscribe((j) => completed.push(j));
  fixture.detectChanges();
  const rows = () =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('li')).map((li) => ({
      state: li.getAttribute('data-state'),
      text: li.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }));
  return { fake, fixture, completed, rows, root: fixture.nativeElement as HTMLElement };
}

describe('TranscodeJobs', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('reads the asset’s jobs and shows each state for what it is, newest first', () => {
    const t = setup();
    expect(t.fake.reads[0]?.assetId).toBe(ASSET);
    t.fake.reads[0]?.result.next([
      job('01J1', 'completed', {
        renditions: [
          {
            presetId: 'proxy',
            kind: 'proxy',
            path: '/p',
            checksum: { algorithm: 'sha256', value: 'a' },
            sizeBytes: 1,
          },
        ],
      }),
      job('01J2', 'dead-letter', { reason: 'Invalid data found when processing input' }),
      job('01J3', 'failed', {
        attempts: 2,
        reason: 'spawn ffmpeg ENOENT',
        retryAt: '2026-09-24T10:05:00.000Z',
      }),
      job('01J4', 'running', { percent: 42.4 }),
    ]);
    t.fixture.detectChanges();

    const rows = t.rows();
    expect(rows.map((r) => r.state)).toEqual(['running', 'failed', 'dead-letter', 'completed']);
    expect(rows[0]?.text).toContain('proxy · thumbnail');
    expect(rows[0]?.text).toContain('assetEditor.jobStates.running');
    expect(rows[0]?.text).toContain('42%');
    expect(t.root.querySelector('progress')?.getAttribute('value')).toBe('42.4');
    // Waiting to retry: why, which attempt, and when.
    expect(rows[1]?.text).toContain('spawn ffmpeg ENOENT');
    expect(rows[1]?.text).toContain('assetEditor.jobAttempt 2');
    expect(rows[1]?.text).toContain('assetEditor.jobRetryAt');
    // Given up: why, and no retry time.
    expect(rows[2]?.text).toContain('Invalid data found');
    expect(rows[2]?.text).not.toContain('assetEditor.jobRetryAt');
    expect(rows[3]?.text).toContain('1 assetEditor.jobRenditions');
  });

  it('polls while a job is moving, and stops by itself once nothing is', () => {
    const t = setup();
    t.fake.reads[0]?.result.next([job('01J1', 'queued')]);
    vi.advanceTimersByTime(1_999);
    expect(t.fake.reads).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.fake.reads).toHaveLength(2);
    t.fake.reads[1]?.result.next([job('01J1', 'running', { percent: 50 })]);
    vi.advanceTimersByTime(2_000);
    t.fake.reads[2]?.result.next([job('01J1', 'completed')]);
    vi.advanceTimersByTime(60_000);
    expect(t.fake.reads).toHaveLength(3);
  });

  it('nothing moving on first read: one read, no poll', () => {
    const t = setup();
    t.fake.reads[0]?.result.next([job('01J1', 'completed'), job('01J2', 'dead-letter')]);
    vi.advanceTimersByTime(60_000);
    expect(t.fake.reads).toHaveLength(1);
  });

  it('`completed` is emitted for a job it watched finish — not for one already finished when it looked', () => {
    const t = setup();
    t.fake.reads[0]?.result.next([job('01J1', 'completed'), job('01J2', 'running')]);
    expect(t.completed).toEqual([]);
    vi.advanceTimersByTime(2_000);
    t.fake.reads[1]?.result.next([job('01J1', 'completed'), job('01J2', 'completed')]);
    expect(t.completed.map((j) => j.id)).toEqual(['01J2']);
  });

  it('a 403 hides the section; any other failure says so and keeps asking while a job was moving', () => {
    const refused = setup();
    refused.fake.reads[0]?.result.error({ status: 403 });
    refused.fixture.detectChanges();
    expect(refused.root.querySelector('section')).toBeNull();

    TestBed.resetTestingModule();
    const t = setup();
    t.fake.reads[0]?.result.next([job('01J1', 'running')]);
    vi.advanceTimersByTime(2_000);
    t.fake.reads[1]?.result.error({ status: 502 });
    t.fixture.detectChanges();
    expect(t.root.textContent).toContain('assetEditor.jobsError');
    vi.advanceTimersByTime(2_000);
    expect(t.fake.reads).toHaveLength(3);
  });

  it('a hidden page skips the request but keeps the cadence', () => {
    const t = setup();
    t.fake.reads[0]?.result.next([job('01J1', 'running')]);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.advanceTimersByTime(6_000);
    expect(t.fake.reads).toHaveLength(1);
    visibility.mockReturnValue('visible');
    vi.advanceTimersByTime(2_000);
    expect(t.fake.reads).toHaveLength(2);
    visibility.mockRestore();
  });

  it('closing the tab stops the poll', () => {
    const t = setup();
    t.fake.reads[0]?.result.next([job('01J1', 'running')]);
    t.fixture.destroy();
    vi.advanceTimersByTime(60_000);
    expect(t.fake.reads).toHaveLength(1);
  });
});
