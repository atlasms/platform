// EP-22.11 — every signed-in user's copy of the active workflows: loaded at sign-in, refreshed on
// `workflow.changed` and on resync, dropped on sign-out. What is worth testing is what fails
// QUIETLY: a refresh that never comes, an unchanged catalog that re-renders everything, another
// channel's event that triggers a read, and a copy that outlives its session.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Catalog, CatalogEntry } from './generated/bms.types.ts';
import { SessionStore } from './session.store.ts';
import { WebSocketService } from './websocket.service.ts';
import { WorkflowCatalogStore } from './workflow-catalog.store.ts';
import { WorkflowsService } from './workflows.service.ts';

const entry = (id: string, revision = 2): CatalogEntry => ({
  id,
  name: id,
  revision,
  version: 1,
  definition: {
    id,
    channelId: 'ch12',
    name: id,
    version: 1,
    status: 'published',
    steps: [{ id: 's', kind: 'start' }],
    transitions: [],
  },
});

/** One subject per read, so a test answers exactly the read it means. */
class FakeWorkflows {
  reads: Subject<Catalog>[] = [];
  catalog() {
    const read = new Subject<Catalog>();
    this.reads.push(read);
    return read;
  }
}

function setup() {
  const fake = new FakeWorkflows();
  TestBed.configureTestingModule({ providers: [{ provide: WorkflowsService, useValue: fake }] });
  const session = TestBed.inject(SessionStore);
  const ws = TestBed.inject(WebSocketService);
  const store = TestBed.inject(WorkflowCatalogStore);
  store.start();
  const signIn = (channelId = 'ch12') =>
    session.signIn({
      userId: 'u1',
      channelId,
      policy: { subjectId: 'u1', permVersion: 1, rules: [] },
    });
  return { fake, session, ws, store, signIn };
}

describe('WorkflowCatalogStore', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('loads at sign-in — a user with no workflow grant too — and asks the socket for changes', () => {
    const { fake, ws, store, signIn } = setup();
    expect(fake.reads.length).toBe(0);
    signIn();
    TestBed.tick();
    expect(fake.reads.length).toBe(1);
    expect(ws.isSubscribed('atlas.ch12.workflow.changed')).toBe(true);

    fake.reads[0]?.next({ etag: '"a"', items: [entry('W1')] });
    expect(store.loaded()).toBe(true);
    expect(store.entries().map((e) => e.id)).toEqual(['W1']);
    expect(store.byId().get('W1')?.definition.steps.length).toBe(1);
  });

  it("re-reads on its channel's workflow.changed and on resync — not on anything else", () => {
    const { fake, ws, signIn } = setup();
    signIn();
    TestBed.tick();
    fake.reads[0]?.next({ etag: '"a"', items: [entry('W1')] });

    ws.events$.next({ subject: 'atlas.ch12.workflow.changed', payload: {} });
    expect(fake.reads.length).toBe(2);
    ws.events$.next({ subject: 'atlas.ch99.workflow.changed', payload: {} });
    ws.events$.next({ subject: 'atlas.ch12.workflow.completed', payload: {} });
    expect(fake.reads.length, 'another channel, another event: no read').toBe(2);
    ws.resync$.next('reconnected');
    expect(fake.reads.length).toBe(3);
  });

  it('an unchanged catalog (same ETag) leaves the copy untouched; a change replaces it', () => {
    const { fake, ws, store, signIn } = setup();
    signIn();
    TestBed.tick();
    fake.reads[0]?.next({ etag: '"a"', items: [entry('W1')] });
    const first = store.entries();

    ws.events$.next({ subject: 'atlas.ch12.workflow.changed', payload: {} });
    fake.reads[1]?.next({ etag: '"a"', items: [entry('W1')] });
    expect(store.entries(), 'the same array — nothing downstream re-renders').toBe(first);

    ws.events$.next({ subject: 'atlas.ch12.workflow.changed', payload: {} });
    fake.reads[2]?.next({ etag: '"b"', items: [entry('W1', 3), entry('W2')] });
    expect(store.entries().map((e) => [e.id, e.revision])).toEqual([
      ['W1', 3],
      ['W2', 2],
    ]);
  });

  it('a failed refresh keeps the copy; signing out drops it', () => {
    const { fake, ws, session, store, signIn } = setup();
    signIn();
    TestBed.tick();
    fake.reads[0]?.next({ etag: '"a"', items: [entry('W1')] });
    ws.resync$.next('poll');
    fake.reads[1]?.error(new Error('502'));
    expect(store.entries().map((e) => e.id)).toEqual(['W1']);

    session.signOut();
    TestBed.tick();
    expect(store.entries()).toEqual([]);
    expect(store.loaded()).toBe(false);
  });
});
