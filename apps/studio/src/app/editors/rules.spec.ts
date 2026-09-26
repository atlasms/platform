// Acceptance rule sets in Studio (EP-15.3): the body is what RIM reads — each rule only its kind's
// parameter, sizes typed in MiB sent in bytes, no empty label, the rule ids kept so a held job's
// `ruleId` still names its rule — a set scoped to one watcher by name, RIM's 422 under the rule it
// names, and delete closing the tab.

import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AcceptanceRuleSet,
  AcceptanceRuleSetInput,
  Watcher,
} from '../core/generated/rim.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { RulesService } from '../core/rules.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { ULID_RE } from '../core/ulid.ts';
import { WatchersService } from '../core/watchers.service.ts';
import { RulesView } from '../panels/ingest/rules-view.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { RuleSetEditor } from './rule-set-editor.ts';
import {
  describeScope,
  draftOfSet,
  inputOfSet,
  newRule,
  placeRuleSetProblems,
  scopeOf,
} from './rule-set.model.ts';

const SET = '01RULESET0000000000000000A';
const R1 = '01RULE00000000000000000001';
const R2 = '01RULE00000000000000000002';
const WATCHER = '01WATCHER0000000000000000A';

const stored = (over: Partial<AcceptanceRuleSet> = {}): AcceptanceRuleSet => ({
  id: SET,
  channelId: 'ch12',
  name: 'Playout masters',
  scope: { sourceKind: 'watch', sourceId: WATCHER },
  rules: [
    { id: R1, kind: 'container', onFail: 'reject', containers: ['mxf'], label: 'MXF only' },
    { id: R2, kind: 'minSizeBytes', onFail: 'quarantine', bytes: 50 * 1024 * 1024 },
  ],
  enabled: true,
  createdBy: 'admin',
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:00:00.000Z',
  version: 1,
  ...over,
});

const watcher: Watcher = {
  id: WATCHER,
  channelId: 'ch12',
  name: 'Playout drops',
  path: 'playout',
  settleSeconds: 10,
  afterPickup: 'delete',
  enabled: true,
  createdBy: 'admin',
  createdAt: '2026-09-26T10:00:00.000Z',
  updatedAt: '2026-09-26T10:00:00.000Z',
  version: 1,
};

describe('rule-set model', () => {
  it('sends each rule with only its parameter, MiB as bytes, no empty label, ids kept', () => {
    const d = draftOfSet(stored());
    expect(d.scope).toBe(`source:${WATCHER}`);
    expect(d.rules[1]?.mebibytes).toBe(50);
    // A rule's parameter survives a change of kind and back — nothing typed is lost.
    const flipped = { ...d.rules[0]!, kind: 'aspectRatio' as const };
    expect(inputOfSet({ ...d, rules: [{ ...flipped, kind: 'container' }] }).rules[0]).toMatchObject(
      { containers: ['mxf'] },
    );
    d.rules.push({ ...newRule('aspectRatio'), label: '   ' });
    expect(inputOfSet(d)).toEqual({
      name: 'Playout masters',
      enabled: true,
      scope: { sourceKind: 'watch', sourceId: WATCHER },
      rules: [
        { id: R1, kind: 'container', onFail: 'reject', label: 'MXF only', containers: ['mxf'] },
        { id: R2, kind: 'minSizeBytes', onFail: 'quarantine', bytes: 52428800 },
        { id: d.rules[2]!.id, kind: 'aspectRatio', onFail: 'quarantine', aspectRatio: '16:9' },
      ],
    });
    expect(d.rules[2]!.id).toMatch(ULID_RE);
    // A size box left empty is sent as nothing — RIM, not the page, says the bound is missing.
    expect(
      inputOfSet({ ...d, rules: [{ ...d.rules[1]!, mebibytes: null }] }).rules[0],
    ).not.toHaveProperty('bytes');
  });

  it('round-trips a stored set, so opening one is not an edit', () => {
    const s = stored();
    expect(inputOfSet(draftOfSet(s))).toEqual({
      name: s.name,
      enabled: true,
      scope: s.scope,
      rules: s.rules,
    });
  });

  it('maps scope both ways: every job, a kind, one watcher — and the upload source is the upload kind', () => {
    expect(scopeOf(undefined)).toBe('all');
    expect(scopeOf({})).toBe('all');
    expect(scopeOf({ sourceKind: 'upload' })).toBe('kind:upload');
    expect(scopeOf({ sourceId: 'upload' })).toBe('kind:upload');
    const t = (k: string) => k;
    const names = (id: string) => (id === WATCHER ? 'Playout drops' : undefined);
    expect(describeScope({ sourceId: WATCHER }, t, names)).toBe('Playout drops');
    expect(describeScope({ sourceId: '01GONE' }, t, names)).toBe('rules.scope.kind.watch (01GONE)');
    expect(describeScope({ sourceKind: 'upload' }, t, names)).toBe('rules.scope.kind.upload');
  });

  it("places RIM's refusal under the rule or the field it names", () => {
    expect(placeRuleSetProblems('rules[1].bytes must be a non-negative integer')).toEqual({
      fields: { 'rules.1': ['rules[1].bytes must be a non-negative integer'] },
      general: [],
    });
    expect(placeRuleSetProblems('name must be 1..200 characters').fields['name']).toHaveLength(1);
    expect(placeRuleSetProblems('rules: ids must be distinct').general).toHaveLength(1);
  });
});

class FakeRules {
  readonly lists: Subject<AcceptanceRuleSet[]>[] = [];
  readonly gets: Subject<AcceptanceRuleSet>[] = [];
  readonly creates: { body: AcceptanceRuleSetInput; result: Subject<AcceptanceRuleSet> }[] = [];
  readonly replaces: {
    id: string;
    body: AcceptanceRuleSetInput;
    result: Subject<AcceptanceRuleSet>;
  }[] = [];
  readonly deletes: { id: string; result: Subject<void> }[] = [];
  list() {
    const s = new Subject<AcceptanceRuleSet[]>();
    this.lists.push(s);
    return s;
  }
  get() {
    const s = new Subject<AcceptanceRuleSet>();
    this.gets.push(s);
    return s;
  }
  create(body: AcceptanceRuleSetInput) {
    const result = new Subject<AcceptanceRuleSet>();
    this.creates.push({ body, result });
    return result;
  }
  replace(id: string, body: AcceptanceRuleSetInput) {
    const result = new Subject<AcceptanceRuleSet>();
    this.replaces.push({ id, body, result });
    return result;
  }
  delete(id: string) {
    const result = new Subject<void>();
    this.deletes.push({ id, result });
    return result;
  }
}

class FakeWatchers {
  readonly lists: Subject<Watcher[]>[] = [];
  list() {
    const s = new Subject<Watcher[]>();
    this.lists.push(s);
    return s;
  }
}

function configure(permissions: string[] = ['ingest:admin']) {
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: RulesService, useValue: new FakeRules() },
      { provide: WatchersService, useValue: new FakeWatchers() },
      { provide: LocaleService, useValue: { t: (k: string) => k } },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'admin',
    channelId: 'ch12',
    policy: {
      subjectId: 'admin',
      permVersion: 1,
      rules: [{ id: 'r', permissions, scope: { channelIds: ['ch12'] } }],
    },
  });
  return {
    api: TestBed.inject(RulesService) as unknown as FakeRules,
    watchers: TestBed.inject(WatchersService) as unknown as FakeWatchers,
    editors: TestBed.inject(EditorStore),
  };
}

describe('RulesView', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists what each set applies to, by watcher NAME; a new set is empty, every job, and opened', () => {
    const { api, editors } = configure();
    const fixture = TestBed.createComponent(RulesView);
    fixture.componentRef.setInput('watchers', [watcher]);
    fixture.detectChanges();
    api.lists[0]?.next([stored(), stored({ id: '01OFF', name: 'Old', scope: {}, enabled: false })]);
    fixture.detectChanges();
    const rows = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.items button'),
    );
    expect(rows[0]?.textContent).toContain('Playout drops');
    expect(rows[0]?.textContent).toContain('2 rules.count');
    expect(rows[1]?.textContent).toContain('rules.scope.all');
    expect(rows[1]?.textContent).toContain('rules.disabled');

    const view = fixture.componentInstance as unknown as { name: string; create(): void };
    view.name = ' News ';
    view.create();
    expect(api.creates[0]?.body).toEqual({ name: 'News', scope: {}, rules: [], enabled: true });
    api.creates[0]?.result.next(stored({ id: '01NEWS', name: 'News', rules: [], scope: {} }));
    expect(editors.activeTab()?.type).toBe('rules');
    expect(editors.activeTab()?.resourceId).toBe('01NEWS');
  });
});

describe('RuleSetEditor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function open(t: ReturnType<typeof configure>) {
    t.editors.open({ type: 'rules', resourceId: SET, title: 'r', icon: '✓' });
    const fixture = TestBed.createComponent(RuleSetEditor);
    fixture.componentRef.setInput('setId', SET);
    fixture.componentRef.setInput('tabId', t.editors.activeTab()!.id);
    fixture.detectChanges();
    t.api.gets[0]?.next(stored());
    t.watchers.lists[0]?.next([watcher]);
    fixture.detectChanges();
    const editor = fixture.componentInstance as unknown as {
      setRule(i: number, key: string, value: unknown): void;
      addRule(): void;
      removeRule(i: number): void;
      save(): void;
      remove(): void;
    };
    return { fixture, editor, root: fixture.nativeElement as HTMLElement };
  }

  it('offers each watcher by name as a scope, saves the whole set with ids kept, and places a 422 on its rule', () => {
    const t = configure();
    const { fixture, editor, root } = open(t);
    const scopes = Array.from(root.querySelectorAll('select[name=scope] option')).map((o) =>
      o.textContent?.trim(),
    );
    expect(scopes).toContain('rules.scope.watcher Playout drops');

    editor.setRule(1, 'mebibytes', 100);
    editor.addRule();
    fixture.detectChanges();
    expect(t.editors.activeTab()?.dirty).toBe(true);
    editor.save();
    const body = t.api.replaces[0]!.body;
    expect(body.rules.map((r) => r.id)).toEqual([R1, R2, body.rules[2]!.id]);
    expect(body.rules[1]).toMatchObject({ kind: 'minSizeBytes', bytes: 100 * 1024 * 1024 });

    t.api.replaces[0]?.result.error({
      status: 422,
      error: { message: 'rules[2].containers must list at least one extension' },
    });
    fixture.detectChanges();
    const rows = root.querySelectorAll('.rules li');
    expect(rows[2]?.textContent).toContain('must list at least one extension');
    expect(rows[0]?.textContent).not.toContain('must list');

    editor.removeRule(2);
    editor.save();
    t.api.replaces[1]?.result.next(stored({ version: 2 }));
    fixture.detectChanges();
    expect(root.textContent).toContain('v2');
    expect(t.editors.activeTab()?.dirty).toBe(false);
  });

  it('deletes and closes its tab; read-only without ingest:admin', () => {
    const t = configure();
    const { editor } = open(t);
    editor.remove();
    expect(t.api.deletes[0]?.id).toBe(SET);
    t.api.deletes[0]?.result.next();
    expect(t.editors.activeTab()).toBeFalsy();

    TestBed.resetTestingModule();
    const reader = open(configure(['ingest:read']));
    expect(reader.root.querySelector('fieldset')?.disabled).toBe(true);
    expect(reader.root.querySelector('button.danger')).toBeNull();
  });
});
