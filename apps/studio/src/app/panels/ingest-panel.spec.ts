// EP-20.3 — the Ingest/Import panel.
//
// The panel is `available: false` until RIM (EP-15) exists, which is precisely why it needs a spec:
// nothing else will exercise it for months. What it got wrong was reading the contract — three
// fields the contract leaves OPTIONAL were typed required in a hand-written "generated" file, so
// the panel rendered "NaN GB" and a raw undefined against a perfectly valid response.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IngestJob } from '../core/generated/rim.types.ts';
import { IngestService } from '../core/ingest.service.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { IngestPanel } from './ingest-panel.ts';

const job = (over: Partial<IngestJob> = {}): IngestJob => ({
  id: '01ABC',
  channelId: 'ch12',
  source: 'watch/news',
  state: 'quarantined',
  sizeBytes: 1024,
  ...over,
});

/**
 * A job the contract allows and the old types did not: detected, not yet sized or sourced.
 *
 * Written as a literal rather than `job({ sizeBytes: undefined })` because
 * `exactOptionalPropertyTypes` is on — an absent key and a key holding `undefined` are different
 * statements, and only the absent one is what RIM would actually send.
 */
const unsizedJob: IngestJob = { id: '01DEF', channelId: 'ch12', state: 'detected' };

class FakeIngest {
  listCalls: { limit?: number; cursor?: string }[] = [];
  lists: Subject<IngestJob[]>[] = [];
  accepts: Subject<IngestJob>[] = [];
  rejectCalls: { id: string; reason: string }[] = [];
  rejects: Subject<IngestJob>[] = [];

  list(options: { limit?: number; cursor?: string } = {}) {
    this.listCalls.push(options);
    const subject = new Subject<IngestJob[]>();
    this.lists.push(subject);
    return subject;
  }
  accept(_id: string) {
    const subject = new Subject<IngestJob>();
    this.accepts.push(subject);
    return subject;
  }
  reject(id: string, reason: string) {
    this.rejectCalls.push({ id, reason });
    const subject = new Subject<IngestJob>();
    this.rejects.push(subject);
    return subject;
  }
}

class FakeLocale {
  locale = () => 'en';
  loading = () => false;
  t(key: string): string {
    return key;
  }
}

/** The panel's own template gates on `ingest:*`; these tests drive the class, not the gate. */
class FakePermissions {
  can(): boolean {
    return true;
  }
}

interface InternalIngestPanel {
  jobs: () => IngestJob[];
  error: () => string | null;
  loading: () => boolean;
  formatSize(bytes: number | undefined): string;
  accept(job: IngestJob): void;
  reject(job: IngestJob, reason: string): void;
}

function setup() {
  const fake = new FakeIngest();
  TestBed.configureTestingModule({
    providers: [
      { provide: IngestService, useValue: fake },
      { provide: LocaleService, useClass: FakeLocale },
      { provide: PermissionService, useClass: FakePermissions },
    ],
  });
  const fixture = TestBed.createComponent(IngestPanel);
  return { fixture, component: fixture.componentInstance as unknown as InternalIngestPanel, fake };
}

describe('IngestPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a job with no size yet reads as unknown, not as NaN', () => {
    // rim.yaml requires only id, channelId and state: a `detected` job exists before the watcher
    // has finished sizing the file. `undefined / 1024**3` is NaN, and "NaN GB" is a bug report
    // from the operator, not a size.
    const { component } = setup();
    expect(component.formatSize(undefined)).toBe('—');
    expect(component.formatSize(0)).toBe('0 B');
    expect(component.formatSize(2048)).toBe('2.0 KB');
    expect(component.formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(component.formatSize(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('loads the queue on mount and renders what came back', () => {
    const { component, fake } = setup();
    expect(fake.listCalls).toEqual([{ limit: 100 }]);

    fake.lists[0]?.next([job(), unsizedJob]);
    expect(component.jobs()).toHaveLength(2);
    expect(component.loading()).toBe(false);
    expect(component.error()).toBeNull();
  });

  it('accepting splices the returned job in rather than refetching the whole queue', () => {
    const { component, fake } = setup();
    fake.lists[0]?.next([job(), job({ id: '01DEF' })]);

    component.accept(job());
    fake.accepts[0]?.next(job({ state: 'accepted' }));

    expect(component.jobs().map((j) => j.state)).toEqual(['accepted', 'quarantined']);
    expect(fake.listCalls).toHaveLength(1);
  });

  it('rejecting carries the operator reason through to the service', () => {
    const { component, fake } = setup();
    fake.lists[0]?.next([job()]);

    component.reject(job(), 'wrong aspect ratio');
    expect(fake.rejectCalls).toEqual([{ id: '01ABC', reason: 'wrong aspect ratio' }]);

    fake.rejects[0]?.next(job({ state: 'rejected', reason: 'wrong aspect ratio' }));
    expect(component.jobs()[0]?.state).toBe('rejected');
  });

  it('a failed load reports without leaving the panel stuck on "loading"', () => {
    const { component, fake } = setup();
    fake.lists[0]?.error(new Error('404 — RIM does not exist yet'));

    expect(component.error()).toBe('Could not load ingest queue.');
    expect(component.loading()).toBe(false);
  });
});
