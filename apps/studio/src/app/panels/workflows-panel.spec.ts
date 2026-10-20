import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  DraftInput,
  Workflow,
  WorkflowPage,
  WorkflowSummary,
} from '../core/generated/bms.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { WorkflowsService } from '../core/workflows.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { WorkflowsPanel, fileNameOf } from './workflows-panel.ts';

const summary = (overrides: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  id: '01K00000000000000000000WF1',
  channelId: 'ch12',
  name: 'Ingest to air',
  state: 'active',
  revision: 3,
  latestVersion: 2,
  ...overrides,
});

class FakeWorkflows {
  readonly lists: Array<{
    options: { after?: string; limit?: number };
    result: Subject<WorkflowPage>;
  }> = [];
  readonly imports: Array<{ xml: string; result: Subject<Workflow> }> = [];
  readonly exports: Array<{ id: string; result: Subject<string> }> = [];
  readonly creates: Array<{ input: DraftInput; result: Subject<Workflow> }> = [];
  create(input: DraftInput) {
    const result = new Subject<Workflow>();
    this.creates.push({ input, result });
    return result;
  }
  list(options: { after?: string; limit?: number } = {}) {
    const result = new Subject<WorkflowPage>();
    this.lists.push({ options, result });
    return result;
  }
  importBpmn(xml: string) {
    const result = new Subject<Workflow>();
    this.imports.push({ xml, result });
    return result;
  }
  exportBpmn(id: string) {
    const result = new Subject<string>();
    this.exports.push({ id, result });
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
  import(xml: string): void;
  export(w: WorkflowSummary): void;
  more(): void;
  download: (filename: string, text: string, type: string) => void;
  error: () => string | null;
  notice: () => string | null;
  refused: () => { elementId?: string; elementType: string; reason?: string }[];
  items: () => WorkflowSummary[];
  open(w: { id: string; name: string }): void;
  create(event: Event): void;
  newName: { set(v: string): void };
}

function setup(permissions = ['workflow:admin']) {
  localStorage.clear();
  const fake = new FakeWorkflows();
  const ws = { resync$: new Subject<string>(), events$: new Subject<{ subject: string }>() };
  TestBed.configureTestingModule({
    providers: [
      { provide: WorkflowsService, useValue: fake },
      { provide: LocaleService, useClass: FakeLocale },
      { provide: WebSocketService, useValue: ws },
      EditorStore,
    ],
  });
  TestBed.inject(SessionStore).signIn({
    userId: 'u1',
    channelId: 'ch12',
    policy: { subjectId: 'u1', permVersion: 1, rules: [{ id: 'r', permissions }] },
  });
  const fixture = TestBed.createComponent(WorkflowsPanel);
  fixture.detectChanges();
  const component = fixture.componentInstance as unknown as Internal;
  const downloads: Array<{ filename: string; text: string; type: string }> = [];
  component.download = (filename, text, type) => downloads.push({ filename, text, type });
  const page = (items: WorkflowSummary[], nextCursor?: string) => {
    fake.lists.at(-1)?.result.next({ items, ...(nextCursor ? { nextCursor } : {}) });
    fixture.detectChanges();
  };
  return {
    fixture,
    root: fixture.nativeElement as HTMLElement,
    component,
    fake,
    ws,
    page,
    downloads,
    editors: TestBed.inject(EditorStore),
  };
}

const unprocessable = (details: unknown) =>
  new HttpErrorResponse({ status: 422, error: { code: 'VALIDATION', detail: 'no', details } });

describe('WorkflowsPanel', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists the channel’s workflows with their state and versions, and reads them again on a change or a resync', () => {
    const t = setup();
    expect(t.fake.lists[0]?.options).toEqual({ limit: 50 });
    t.page([
      summary({ draftVersion: 3 }),
      summary({ id: 'w2', name: 'Re-review', state: 'draft', latestVersion: 0, draftVersion: 1 }),
    ]);
    const rows = [...t.root.querySelectorAll('.items li')].map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(rows[0]).toContain('workflowsPanel.state.active · v2 · workflowsPanel.draft v3');
    expect(rows[1]).toContain('workflowsPanel.state.draft · workflowsPanel.draft v1');
    expect(rows[1]).not.toContain('v0');

    t.ws.events$.next({ subject: 'atlas.ch12.workflow.changed' });
    t.ws.events$.next({ subject: 'atlas.ch12.asset.updated' });
    t.ws.resync$.next('reconnected');
    expect(t.fake.lists.length).toBe(3);
  });

  it('the next page is read from the cursor and appended', () => {
    const t = setup();
    t.page([summary()], 'w1');
    t.component.more();
    expect(t.fake.lists[1]?.options).toEqual({ after: 'w1', limit: 50 });
    t.page([summary({ id: 'w2' })]);
    expect(t.component.items().map((w) => w.id)).toEqual([summary().id, 'w2']);
    expect(t.root.querySelector('.more')).toBeNull();
  });

  it('import is offered to workflow:admin only — a reader exports', () => {
    const admin = setup(['workflow:admin']);
    expect(admin.root.querySelector('input[type=file]')).not.toBeNull();
    TestBed.resetTestingModule();
    const reader = setup(['workflow:read']);
    reader.page([summary()]);
    expect(reader.root.querySelector('input[type=file]')).toBeNull();
    expect(reader.root.querySelector('.items button:not(.title)')?.textContent?.trim()).toBe(
      'workflowsPanel.export',
    );
  });

  it('an import sends the file as it is, says so, and lists again', () => {
    const t = setup();
    t.page([]);
    t.component.import('<bpmn:definitions/>');
    expect(t.fake.imports[0]?.xml).toBe('<bpmn:definitions/>');
    t.fake.imports[0]?.result.next({ ...summary({ id: 'new', name: 'From Camunda' }) } as Workflow);
    expect(t.component.notice()).toBe('workflowsPanel.imported “From Camunda”');
    expect(t.fake.lists.length).toBe(2);
  });

  it('a refused import names every construct BMS refused; a file that is not BPMN says that', () => {
    const t = setup();
    t.component.import('<x/>');
    t.fake.imports[0]?.result.error(
      unprocessable({
        code: 'UNSUPPORTED_BPMN',
        unsupported: [
          { elementId: 'ig', elementType: 'bpmn:InclusiveGateway' },
          { elementId: 'l1', elementType: 'bpmn:Lane', reason: 'lanes' },
        ],
      }),
    );
    t.fixture.detectChanges();
    expect(t.component.error()).toBe('workflowsPanel.unsupported');
    const listed = [...t.root.querySelectorAll('.refused li')].map((li) =>
      li.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(listed).toEqual(['bpmn:InclusiveGateway “ig”', 'bpmn:Lane “l1” — lanes']);

    t.component.import('nope');
    expect(t.component.refused()).toEqual([]);
    t.fake.imports[1]?.result.error(unprocessable({ code: 'MALFORMED_XML', unsupported: [] }));
    expect(t.component.error()).toBe('workflowsPanel.malformed');

    t.component.import('<x/>');
    t.fake.imports[2]?.result.error(
      new HttpErrorResponse({ status: 403, error: { detail: 'Forbidden' } }),
    );
    expect(t.component.error()).toBe('Forbidden');
  });

  it('an export downloads the BPMN under the workflow’s name', () => {
    const t = setup(['workflow:read']);
    const w = summary({ name: 'Ingest / to: air' });
    t.page([w]);
    t.component.export(w);
    expect(t.fake.exports[0]?.id).toBe(w.id);
    t.fake.exports[0]?.result.next('<bpmn:definitions/>');
    expect(t.downloads).toEqual([
      { filename: 'Ingest-to-air.bpmn', text: '<bpmn:definitions/>', type: 'application/xml' },
    ]);
  });

  it('a workflow opens in the designer — one tab per workflow', () => {
    const t = setup(['workflow:read']);
    const w = summary();
    t.page([w]);
    (t.root.querySelector('.items .title') as HTMLButtonElement).click();
    (t.root.querySelector('.items .title') as HTMLButtonElement).click();
    const tabs = t.editors.layout().groups.flatMap((g) => g.tabs);
    expect(tabs.map((x) => x.id)).toEqual([`workflow:${w.id}`]);
    expect(tabs[0]?.title).toBe(w.name);
  });

  it('an admin creates a workflow — a start and nothing else — and it opens in the designer', () => {
    const t = setup();
    t.page([]);
    t.component.newName.set('  Proxy only  ');
    t.component.create(new Event('submit'));
    expect(t.fake.creates[0]?.input).toEqual({
      name: 'Proxy only',
      steps: [
        {
          id: 's_start',
          kind: 'start',
          name: 'workflowEditor.kind.start',
          position: { x: 0, y: 0 },
          config: {},
        },
      ],
      transitions: [],
    });
    t.fake.creates[0]?.result.next({ ...summary({ id: 'new1', name: 'Proxy only' }) } as Workflow);
    expect(
      t.editors
        .layout()
        .groups.flatMap((g) => g.tabs)
        .map((x) => x.id),
    ).toEqual(['workflow:new1']);
    expect(t.fake.lists.length).toBe(2);
    TestBed.resetTestingModule();
    const reader = setup(['workflow:read']);
    expect(reader.root.querySelector('form.create')).toBeNull();
  });
});

describe('fileNameOf', () => {
  it('keeps a name readable and safe on every OS — Arabic included', () => {
    expect(fileNameOf('Ingest to air')).toBe('Ingest-to-air.bpmn');
    expect(fileNameOf('a\\b/c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j.bpmn');
    expect(fileNameOf('مسار العمل')).toBe('مسار-العمل.bpmn');
    expect(fileNameOf('  ///  ')).toBe('workflow.bpmn');
  });
});
