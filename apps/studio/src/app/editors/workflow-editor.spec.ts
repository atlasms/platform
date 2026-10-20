import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidationIssue, WorkflowDefinition } from '@atlas/contracts/workflow-types';
import type {
  DraftInput,
  PaletteEntry,
  PublishResult,
  ValidationResult,
  Workflow,
} from '../core/generated/bms.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WorkflowsService } from '../core/workflows.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { VALIDATE_DEBOUNCE_MS, WorkflowEditor } from './workflow-editor.ts';
import { inOf, outOf } from './workflow-graph.ts';

const definition = (): WorkflowDefinition => ({
  id: '01K00000000000000000000WF1',
  channelId: 'ch12',
  name: 'Review gate',
  version: 2,
  status: 'draft',
  steps: [
    { id: 's_start', kind: 'start', name: 'Start', position: { x: 0, y: 0 }, config: {} },
    {
      id: 's_review',
      kind: 'human-task',
      name: 'Review',
      position: { x: 180, y: 0 },
      config: { taskType: 'approve', assignee: { role: 'librarian' } },
    },
    { id: 's_end', kind: 'end', name: 'Done', position: { x: 360, y: 0 }, config: {} },
  ],
  transitions: [
    { id: 't1', from: 's_start', to: 's_review' },
    { id: 't2', from: 's_review', to: 's_end' },
  ],
});

const workflow = (overrides: Partial<Workflow> = {}): Workflow => ({
  id: '01K00000000000000000000WF1',
  channelId: 'ch12',
  state: 'active',
  name: 'Review gate',
  revision: 4,
  latestVersion: 1,
  draftVersion: 2,
  draft: definition(),
  versions: [],
  createdBy: 'u1',
  createdAt: '2026-10-20T09:00:00.000Z',
  updatedAt: '2026-10-20T09:00:00.000Z',
  ...overrides,
});

const HUMAN_TASK_SCHEMA = {
  type: 'object',
  required: ['taskType', 'assignee'],
  properties: {
    taskType: { enum: ['approve', 'edit', 'review', 'generic'] },
    assignee: {
      type: 'object',
      properties: { role: { type: 'string' }, userId: { type: 'string' } },
    },
    dueIn: { type: 'string', 'x-atlas-type': 'duration' },
  },
};
const PALETTE: PaletteEntry[] = (['command', 'human-task', 'branch', 'end'] as const).map(
  (kind) =>
    ({
      kind,
      label: kind,
      configSchema: kind === 'human-task' ? HUMAN_TASK_SCHEMA : { type: 'object' },
    }) as PaletteEntry,
);

class FakeWorkflows {
  readonly gets: Subject<Workflow>[] = [];
  readonly versions: Array<{ version: number; result: Subject<WorkflowDefinition> }> = [];
  readonly palettes: Subject<PaletteEntry[]>[] = [];
  readonly validations: Array<{ input: DraftInput; result: Subject<ValidationResult> }> = [];
  readonly saves: Array<{ revision: number; input: DraftInput; result: Subject<Workflow> }> = [];
  readonly publishes: Array<{ revision: number; result: Subject<PublishResult> }> = [];
  readonly moves: Array<{ action: string; revision: number; result: Subject<Workflow> }> = [];
  publish(_id: string, revision: number) {
    const result = new Subject<PublishResult>();
    this.publishes.push({ revision, result });
    return result;
  }
  transition(_id: string, action: string, revision: number) {
    const result = new Subject<Workflow>();
    this.moves.push({ action, revision, result });
    return result;
  }
  get(_id: string) {
    const s = new Subject<Workflow>();
    this.gets.push(s);
    return s;
  }
  version(_id: string, version: number) {
    const result = new Subject<WorkflowDefinition>();
    this.versions.push({ version, result });
    return result;
  }
  palette() {
    const s = new Subject<PaletteEntry[]>();
    this.palettes.push(s);
    return s;
  }
  validate(_id: string, input: DraftInput) {
    const result = new Subject<ValidationResult>();
    this.validations.push({ input, result });
    return result;
  }
  saveDraft(_id: string, revision: number, input: DraftInput) {
    const result = new Subject<Workflow>();
    this.saves.push({ revision, input, result });
    return result;
  }
}

class FakeLocale {
  locale = () => 'en';
  loading = () => false;
  t(key: string): string {
    return key;
  }
  setLocale(_locale: 'en' | 'ar'): Promise<void> {
    return Promise.resolve();
  }
}

interface Internal {
  add(kind: string): void;
  onConnect(e: { sourceId: string; targetId: string | undefined }): void;
  onMove(e: { nodes: { id: string; position: { x: number; y: number } }[] }): void;
  onSelect(e: { nodeIds: string[]; groupIds: string[]; connectionIds: string[] }): void;
  removeSelected(): void;
  rename(id: string, name: string): void;
  configure(id: string, config: unknown): void;
  editEdge(id: string, patch: { name?: string; when?: string }): void;
  makeDefault(id: string, on: boolean): void;
  publish(): void;
  view(choice: string): void;
  move(action: 'activate' | 'deactivate' | 'archive'): void;
  archive(): void;
  canPublish: () => boolean;
  notice: () => string | null;
  save(): void;
  revert(): void;
  def: () => WorkflowDefinition | null;
  dirty: () => boolean;
  canEdit: () => boolean;
  error: () => string | null;
  issues: () => ValidationIssue[];
}

function setup(permissions = ['workflow:admin']) {
  localStorage.clear();
  const fake = new FakeWorkflows();
  TestBed.configureTestingModule({
    providers: [
      EditorStore,
      { provide: WorkflowsService, useValue: fake },
      { provide: LocaleService, useClass: FakeLocale },
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'u1',
    channelId: 'ch12',
    policy: { subjectId: 'u1', permVersion: 1, rules: [{ id: 'r', permissions }] },
  });
  const editors = TestBed.inject(EditorStore);
  editors.open({ type: 'workflow', resourceId: workflow().id, title: 'Review gate' });
  const tabId = `workflow:${workflow().id}`;
  const fixture = TestBed.createComponent(WorkflowEditor);
  fixture.componentRef.setInput('workflowId', workflow().id);
  fixture.componentRef.setInput('tabId', tabId);
  fixture.detectChanges();
  const load = (w: Workflow = workflow()) => {
    fake.gets.at(-1)?.next(w);
    fake.palettes.at(-1)?.next(PALETTE);
    fixture.detectChanges();
  };
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    component: fixture.componentInstance as unknown as Internal,
    fake,
    load,
    editors,
    tabId,
  };
}

const tabOf = (t: ReturnType<typeof setup>) =>
  t.editors
    .layout()
    .groups.flatMap((g) => g.tabs)
    .find((x) => x.id === t.tabId);

describe('WorkflowEditor', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('shows the open draft as steps and connector-to-connector edges, and asks BMS to judge it', () => {
    const t = setup();
    t.load();
    const steps = [...t.root.querySelectorAll('.step .label')].map((n) => n.textContent);
    expect(steps).toEqual(['Start', 'Review', 'Done']);
    expect(t.root.querySelectorAll('f-connection').length).toBe(2);
    expect(t.root.querySelector('.step[data-kind="start"] .port.in')).toBeNull();
    expect(t.root.querySelector('.step[data-kind="end"] .port.out')).toBeNull();
    vi.advanceTimersByTime(0);
    expect(t.fake.validations.length).toBe(1);
    expect(t.component.dirty()).toBe(false);
  });

  it('with no open draft it shows the latest published version', () => {
    const t = setup();
    const { draft: _d, draftVersion: _v, ...published } = workflow();
    t.load(published as Workflow);
    expect(t.fake.versions[0]?.version).toBe(1);
    t.fake.versions[0]?.result.next(definition());
    t.fixture.detectChanges();
    expect(t.root.querySelectorAll('.step').length).toBe(3);
  });

  it('a palette step is added right of the rest; a connection out → in becomes a transition', () => {
    const t = setup();
    t.load();
    t.component.add('command');
    const added = t.component.def()!.steps.at(-1)!;
    expect(added).toMatchObject({ id: 's_command_1', kind: 'command', position: { x: 540, y: 0 } });
    t.component.onConnect({ sourceId: outOf('s_review'), targetId: inOf('s_command_1') });
    expect(t.component.def()!.transitions.at(-1)).toEqual({
      id: 't3',
      from: 's_review',
      to: 's_command_1',
    });
    expect(t.component.dirty()).toBe(true);
    t.fixture.detectChanges();
    expect(tabOf(t)?.dirty).toBe(true);
  });

  it('a connection the canvas knows is wrong is refused with the reason, and changes nothing', () => {
    const t = setup();
    t.load();
    t.component.onConnect({ sourceId: outOf('s_review'), targetId: inOf('s_review') });
    expect(t.component.error()).toBe('workflowEditor.refused.self');
    t.component.onConnect({ sourceId: outOf('s_start'), targetId: undefined }); // dropped nowhere
    expect(t.component.def()!.transitions.length).toBe(2);
    expect(t.component.dirty()).toBe(false);
  });

  it('dragging writes positions back; removing the selection takes its edges', () => {
    const t = setup();
    t.load();
    t.component.onMove({ nodes: [{ id: 's_end', position: { x: 400, y: 80 } }] });
    expect(t.component.def()!.steps[2]!.position).toEqual({ x: 400, y: 80 });
    t.component.onSelect({ nodeIds: ['s_review'], groupIds: [], connectionIds: [] });
    t.component.removeSelected();
    expect(t.component.def()!.steps.map((s) => s.id)).toEqual(['s_start', 's_end']);
    expect(t.component.def()!.transitions).toEqual([]);
  });

  it('validation waits for the edits to settle, and only the last run paints', () => {
    const t = setup();
    t.load();
    vi.advanceTimersByTime(0);
    t.component.rename('s_review', 'R');
    t.component.rename('s_review', 'Re');
    vi.advanceTimersByTime(VALIDATE_DEBOUNCE_MS - 1);
    expect(t.fake.validations.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(t.fake.validations.length).toBe(2);
    expect(t.fake.validations[1]?.input.steps[1]).toMatchObject({ name: 'Re' });
    const issue: ValidationIssue = {
      severity: 'error',
      code: 'NO_PATH_TO_END',
      message: 'no path',
      stepId: 's_review',
    };
    t.fake.validations[0]?.result.next({ valid: true, issues: [] }); // stale — ignored
    t.fake.validations[1]?.result.next({ valid: false, issues: [issue] });
    t.fixture.detectChanges();
    expect(t.component.issues()).toEqual([issue]);
    expect(t.root.querySelector('.step[data-marker="error"] .label')?.textContent).toBe('Re');
    expect(t.root.querySelector('.issues li code')?.textContent).toBe('NO_PATH_TO_END');
  });

  it('save sends the whole graph over the revision read; a 409 reads the workflow again', () => {
    const t = setup();
    t.load();
    t.component.rename('s_review', 'Checked');
    t.component.save();
    expect(t.fake.saves[0]?.revision).toBe(4);
    expect(t.fake.saves[0]?.input).toMatchObject({ name: 'Review gate' });
    expect(t.fake.saves[0]?.input.steps.map((s) => s['name'])).toEqual([
      'Start',
      'Checked',
      'Done',
    ]);
    const saved = definition();
    saved.steps[1]!.name = 'Checked';
    t.fake.saves[0]?.result.next(workflow({ revision: 5, draft: saved }));
    expect(t.component.dirty()).toBe(false);

    t.component.rename('s_review', 'Again');
    t.component.save();
    t.fake.saves[1]?.result.error(new HttpErrorResponse({ status: 409 }));
    expect(t.component.error()).toBe('workflowEditor.moved');
    expect(t.fake.gets.length).toBe(2);
  });

  it('without workflow:admin — or once archived — the canvas is read-only', () => {
    const reader = setup(['workflow:read']);
    reader.load();
    expect(reader.component.canEdit()).toBe(false);
    expect(reader.root.querySelector('.palette')).toBeNull();
    reader.component.add('command');
    reader.component.onConnect({ sourceId: outOf('s_start'), targetId: inOf('s_end') });
    expect(reader.component.def()!.steps.length).toBe(3);
    expect(reader.component.def()!.transitions.length).toBe(2);
    expect(reader.fake.palettes.length).toBe(0); // the palette is an admin's (EP-23.1)

    TestBed.resetTestingModule();
    const archived = setup();
    archived.load(workflow({ state: 'archived' }));
    expect(archived.component.canEdit()).toBe(false);
  });

  it('a selected step’s property panel is generated from its kind’s palette schema, and edits the config', () => {
    const t = setup();
    t.load();
    t.component.onSelect({ nodeIds: ['s_review'], groupIds: [], connectionIds: [] });
    t.fixture.detectChanges();
    const config = t.root.querySelector('atlas-schema-field.config') as HTMLElement;
    const names = [...config.querySelectorAll('label.name')].map((l) =>
      l.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(names).toEqual(['Task type *', 'Role', 'User id', 'Due in']);
    const dueIn = config.querySelector('input[placeholder="PT30M"]') as HTMLInputElement;
    dueIn.value = 'P1D';
    dueIn.dispatchEvent(new Event('input'));
    expect(t.component.def()!.steps[1]!.config).toEqual({
      taskType: 'approve',
      assignee: { role: 'librarian' },
      dueIn: 'P1D',
    });
    expect(t.component.dirty()).toBe(true);
    vi.advanceTimersByTime(VALIDATE_DEBOUNCE_MS);
    expect(t.fake.validations.at(-1)?.input.steps[1]).toMatchObject({ config: { dueIn: 'P1D' } });
    t.component.configure('s_review', undefined); // emptied: `{}`, never absent
    expect(t.component.def()!.steps[1]!.config).toEqual({});
  });

  it('a selected edge out of a branch edits its name, condition and default', () => {
    const t = setup();
    const def = definition();
    def.steps.push({ id: 's_gate', kind: 'branch', position: { x: 360, y: 0 }, config: {} });
    def.transitions.push({ id: 't3', from: 's_gate', to: 's_end' });
    t.load(workflow({ draft: def }));
    t.component.onSelect({ nodeIds: [], groupIds: [], connectionIds: ['t3'] });
    t.fixture.detectChanges();
    expect(t.root.querySelector('.side input.feel')).not.toBeNull(); // a branch edge has a condition
    t.component.editEdge('t3', { when: '= vars.ok' });
    t.component.makeDefault('t3', true);
    const edge = t.component.def()!.transitions.find((x) => x.id === 't3');
    expect(edge).toMatchObject({ when: '= vars.ok', isDefault: true });
    expect(t.component.def()!.steps.find((s) => s.id === 's_gate')?.config).toEqual({
      default: 't3',
    });

    t.component.onSelect({ nodeIds: [], groupIds: [], connectionIds: ['t1'] });
    t.fixture.detectChanges();
    expect(t.root.querySelector('.side input.feel')).toBeNull(); // only a branch's edges have one
  });

  it('a reader, who has no palette, sees a step’s configuration as it is', () => {
    const t = setup(['workflow:read']);
    t.load();
    t.component.onSelect({ nodeIds: ['s_review'], groupIds: [], connectionIds: [] });
    t.fixture.detectChanges();
    expect(t.root.querySelector('atlas-schema-field')).toBeNull();
    expect(JSON.parse(t.root.querySelector('pre.json')?.textContent ?? '')).toEqual({
      taskType: 'approve',
      assignee: { role: 'librarian' },
    });
  });

  it('publish waits for a clean judgement, then publishes over the revision read', () => {
    const t = setup();
    t.load();
    expect(t.component.canPublish()).toBe(false); // BMS is still judging
    vi.advanceTimersByTime(0);
    t.fake.validations[0]?.result.next({
      valid: false,
      issues: [{ severity: 'error', code: 'E', message: 'e', stepId: 's_review' }],
    });
    expect(t.component.canPublish()).toBe(false); // it found an error
    t.component.rename('s_review', 'Fixed');
    vi.advanceTimersByTime(VALIDATE_DEBOUNCE_MS);
    t.fake.validations[1]?.result.next({ valid: true, issues: [] });
    expect(t.component.canPublish()).toBe(true);

    // Unsaved edits are saved first; the publish goes over the revision that save returned.
    t.component.publish();
    expect(t.fake.saves.length).toBe(1);
    const saved = definition();
    saved.steps[1]!.name = 'Fixed';
    t.fake.saves[0]?.result.next(workflow({ revision: 5, draft: saved }));
    expect(t.fake.publishes[0]?.revision).toBe(5);
    t.fake.publishes[0]?.result.next({
      workflowId: workflow().id,
      state: 'active',
      version: 2,
      publishedAt: '2026-10-20T10:00:00.000Z',
      revision: 6,
      warnings: [{ severity: 'warning', code: 'GAP', message: 'w' }],
    });
    expect(t.component.notice()).toBe('workflowEditor.published v2 · 1 workflowEditor.warnings');
    expect(t.fake.gets.length).toBe(2); // read again: the draft is a version now
  });

  it('a publish BMS refuses paints its issues where they belong', () => {
    const t = setup();
    t.load();
    vi.advanceTimersByTime(0);
    t.fake.validations[0]?.result.next({ valid: true, issues: [] });
    t.component.publish();
    const issue: ValidationIssue = {
      severity: 'error',
      code: 'UNKNOWN_COMMAND',
      message: 'not a command',
      stepId: 's_review',
    };
    t.fake.publishes[0]?.result.error(
      new HttpErrorResponse({
        status: 422,
        error: { code: 'VALIDATION', details: { issues: [issue] } },
      }),
    );
    t.fixture.detectChanges();
    expect(t.component.error()).toBe('workflowEditor.publishInvalid');
    expect(t.component.issues()).toEqual([issue]);
    expect(t.root.querySelector('.step[data-marker="error"] .label')?.textContent).toBe('Review');
  });

  it('a published version is shown read-only; back to the draft is editable again', () => {
    const t = setup();
    t.load(
      workflow({
        versions: [{ version: 1, publishedAt: '2026-10-19T08:00:00.000Z', publishedBy: 'u2' }],
      }),
    );
    const options = [...t.root.querySelectorAll('select.versions option')].map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(['workflowsPanel.draft v2', 'v1 · 2026-10-19 · u2']);
    t.component.view('1');
    expect(t.fake.versions.at(-1)?.version).toBe(1);
    const v1 = definition();
    v1.steps = v1.steps.slice(0, 2);
    t.fake.versions.at(-1)?.result.next(v1);
    expect(t.component.canEdit()).toBe(false);
    expect(t.component.def()!.steps.length).toBe(2);
    t.component.add('command');
    expect(t.component.def()!.steps.length).toBe(2); // a published version is immutable
    t.component.view('current');
    t.fake.gets.at(-1)?.next(workflow());
    expect(t.component.canEdit()).toBe(true);
  });

  it('lifecycle: deactivate over the revision; refused while instances run, with the count', () => {
    const t = setup();
    t.load();
    t.component.move('deactivate');
    expect(t.fake.moves[0]).toMatchObject({ action: 'deactivate', revision: 4 });
    t.fake.moves[0]?.result.error(
      new HttpErrorResponse({ status: 409, error: { code: 'CONFLICT', details: { running: 3 } } }),
    );
    expect(t.component.error()).toBe('workflowEditor.running 3');
    t.component.move('deactivate');
    t.fake.moves[1]?.result.next(workflow({ state: 'inactive', revision: 5 }));
    expect(t.component.notice()).toBe('workflowEditor.done.deactivate');
  });

  it('archiving is final, so it takes a second click', () => {
    const t = setup();
    t.load();
    t.component.archive();
    expect(t.fake.moves.length).toBe(0);
    t.fixture.detectChanges();
    expect(t.root.textContent).toContain('workflowEditor.confirmArchive');
    t.component.archive();
    expect(t.fake.moves[0]?.action).toBe('archive');
  });
});
