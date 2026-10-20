import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  type OnInit,
} from '@angular/core';
import {
  FFlowModule,
  type FCreateConnectionEvent,
  type FMoveNodesEvent,
  type FSelectionChangeEvent,
} from '@foblex/flow';
import type { StepConfig, StepKind, ValidationIssue } from '@atlas/contracts/workflow-types';
import type {
  DraftInput,
  PaletteEntry,
  Workflow,
  WorkflowDefinition,
} from '../core/generated/bms.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WorkflowsService } from '../core/workflows.service.ts';
import { EditorStore } from '../workbench/editor.store.ts';
import { FlowTheme } from './flow-theme.ts';
import {
  addStep,
  connect,
  moveSteps,
  nextFreePoint,
  removeSelection,
  renameStep,
  setDefaultEdge,
  setEdge,
  setStepConfig,
  stepOfConnector,
  toGraph,
} from './workflow-graph.ts';
import { SchemaField } from './schema-field.ts';

/** How long the designer waits after an edit before asking BMS to judge the graph (DSL §12.2). */
export const VALIDATE_DEBOUNCE_MS = 400;

/** The graph part of a definition — what a save sends and what "dirty" compares. */
const graphOf = (d: WorkflowDefinition) => JSON.stringify({ s: d.steps, t: d.transitions });

/**
 * The workflow designer (EP-23.4; DSL doc §12): a workflow's graph on a Foblex Flow canvas, edited
 * THIN over the definition — every gesture is a pure operation on the definition signal
 * (workflow-graph.ts), and the canvas only renders what that signal says.
 *
 * - Steps are added from the palette (BMS's `GET /workflows/palette`, EP-23.1), dragged (their
 *   `position` written back — presentation only), connected out → in, and removed with their
 *   edges. What the canvas can know for certain it refuses at once (an edge into a start, out of
 *   an end, onto itself, or twice); the rest is BMS's validator, asked {@link VALIDATE_DEBOUNCE_MS}
 *   after each edit, whose issues are painted on the steps and edges they name.
 * - Save is the whole graph over the revision read (`PUT /draft?revision=`): a 409 is someone
 *   else's save in between, and the workflow is read again rather than written over.
 * - With no open draft the latest published version is shown; saving opens the next draft.
 *   Without `workflow:admin`, or once archived, the canvas is read-only.
 *
 * A step's configuration (23.5), a condition's FEEL (23.6) and publishing (23.7) are next.
 */
@Component({
  selector: 'atlas-workflow-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FFlowModule, FlowTheme, SchemaField],
  template: `
    <atlas-flow-theme />
    @if (workflow(); as w) {
      <header class="toolbar">
        <h2>{{ w.name }}</h2>
        <span class="meta">
          {{ locale.t('workflowsPanel.state.' + w.state) }}
          @if (w.draftVersion !== undefined) {
            · {{ locale.t('workflowsPanel.draft') }} v{{ w.draftVersion }}
          } @else if (w.latestVersion > 0) {
            · v{{ w.latestVersion }}
          }
        </span>
        @if (canEdit()) {
          <span class="actions">
            <button type="button" [disabled]="busy() || !dirty()" (click)="save()">
              {{ locale.t('workflowEditor.save') }}
            </button>
            <button type="button" class="link" [disabled]="busy() || !dirty()" (click)="revert()">
              {{ locale.t('workflowEditor.revert') }}
            </button>
          </span>
        } @else {
          <span class="muted">{{ locale.t('workflowEditor.readOnly') }}</span>
        }
      </header>

      @if (canEdit()) {
        <nav class="palette" [attr.aria-label]="locale.t('workflowEditor.palette')">
          @for (p of palette(); track p.kind) {
            <button type="button" [attr.data-kind]="p.kind" (click)="add(p.kind)">
              <span aria-hidden="true">{{ glyph(p.kind) }}</span> {{ kindLabel(p) }}
            </button>
          }
          <button
            type="button"
            class="danger"
            [disabled]="selectedSteps().length + selectedEdges().length === 0"
            (click)="removeSelected()"
          >
            {{ locale.t('workflowEditor.remove') }}
          </button>
        </nav>
      }

      @if (error()) {
        <p class="error" role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p class="notice" role="status">{{ notice() }}</p>
      }

      <div class="body">
        <f-flow
          fDraggable
          [fDraggableDisabled]="!canEdit()"
          (fCreateConnection)="onConnect($event)"
          (fMoveNodes)="onMove($event)"
          (fSelectionChange)="onSelect($event)"
          (fDeleteSelected)="removeSelected()"
        >
          <f-canvas fZoom>
            <f-connection-for-create />
            <ng-container ngProjectAs="[fConnections]">
              @for (e of graph().edges; track e.id) {
                <f-connection
                  [fConnectionId]="e.id"
                  [fSourceId]="e.source"
                  [fTargetId]="e.target"
                  fType="segment"
                  fBehavior="fixed"
                  [class.marker-error]="e.marker === 'error'"
                  [class.marker-warning]="e.marker === 'warning'"
                  [class.default]="e.isDefault"
                >
                  @if (e.label) {
                    <div fConnectionContent class="edge-label">{{ e.label }}</div>
                  }
                </f-connection>
              }
            </ng-container>
            <ng-container ngProjectAs="[fNodes]">
              @for (n of graph().nodes; track n.id) {
                <div
                  fNode
                  fDragHandle
                  class="step"
                  [fNodeId]="n.id"
                  [fNodePosition]="n.position"
                  [fNodeDraggingDisabled]="!canEdit()"
                  [attr.data-kind]="n.kind"
                  [attr.data-marker]="n.marker ?? null"
                  [attr.title]="issuesOf(n.id)"
                >
                  @if (n.target) {
                    <div
                      fConnector
                      class="port in"
                      fConnectorType="target"
                      [fConnectorId]="n.target"
                    ></div>
                  }
                  <span class="glyph" aria-hidden="true">{{ glyph(n.kind) }}</span>
                  <span class="label">{{ n.label }}</span>
                  @if (n.source) {
                    <div
                      fConnector
                      class="port out"
                      fConnectorType="source"
                      [fConnectorId]="n.source"
                    ></div>
                  }
                </div>
              }
            </ng-container>
          </f-canvas>
        </f-flow>

        <aside class="side">
          @if (selectedStep(); as s) {
            <label>
              {{ locale.t('workflowEditor.stepName') }}
              <input
                [value]="s.name ?? ''"
                [disabled]="!canEdit()"
                (input)="rename(s.id, $any($event.target).value)"
              />
            </label>
            <p class="muted">{{ locale.t('workflowEditor.kind.' + s.kind) }} · {{ s.id }}</p>
            @if (entryOf(s.kind); as entry) {
              <h3>{{ locale.t('workflowEditor.config') }}</h3>
              <atlas-schema-field
                class="config"
                [schema]="entry.configSchema"
                [value]="s.config ?? {}"
                [choices]="entry.choices"
                [readOnly]="!canEdit()"
                (valueChange)="configure(s.id, $event)"
              />
            } @else if (!canEdit() && s.config) {
              <!-- The palette is an admin's (EP-23.1): a reader sees the configuration as it is. -->
              <h3>{{ locale.t('workflowEditor.config') }}</h3>
              <pre class="json">{{ jsonOf(s.config) }}</pre>
            }
          } @else if (selectedEdge(); as e) {
            <label>
              {{ locale.t('workflowEditor.edgeName') }}
              <input
                [value]="e.name ?? ''"
                [disabled]="!canEdit()"
                (input)="editEdge(e.id, { name: $any($event.target).value })"
              />
            </label>
            @if (fromBranch(e.from)) {
              <label>
                {{ locale.t('workflowEditor.when') }}
                <input
                  class="feel"
                  placeholder="= …"
                  [value]="e.when ?? ''"
                  [disabled]="!canEdit()"
                  (input)="editEdge(e.id, { when: $any($event.target).value })"
                />
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  [checked]="e.isDefault === true"
                  [disabled]="!canEdit()"
                  (change)="makeDefault(e.id, $any($event.target).checked)"
                />
                {{ locale.t('workflowEditor.isDefault') }}
              </label>
            }
            <p class="muted">{{ e.from }} → {{ e.to }} · {{ e.id }}</p>
          }
          <h3>{{ locale.t('workflowEditor.issues') }}</h3>
          @if (validating()) {
            <p class="muted">{{ locale.t('workflowEditor.validating') }}</p>
          } @else if (issues().length === 0) {
            <p class="muted">{{ locale.t('workflowEditor.noIssues') }}</p>
          }
          <ul class="issues">
            @for (i of issues(); track $index) {
              <li [attr.data-severity]="i.severity">
                <code>{{ i.code }}</code> {{ i.message }}
              </li>
            }
          </ul>
        </aside>
      </div>
    } @else if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    } @else {
      <p class="muted">{{ locale.t('editor.loading') }}</p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      block-size: 100%;
      min-block-size: 0;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: baseline;
      padding: var(--space-2);
      border-block-end: 1px solid var(--color-border);
    }
    .toolbar h2 {
      margin: 0;
      font-size: 1rem;
    }
    .actions {
      margin-inline-start: auto;
      display: flex;
      gap: var(--space-1);
    }
    .palette {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-1);
      padding: var(--space-1) var(--space-2);
      border-block-end: 1px solid var(--color-border);
    }
    button {
      padding: var(--space-1) var(--space-2);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    button.link {
      background: none;
    }
    button.danger {
      color: var(--color-danger);
      margin-inline-start: auto;
    }
    .body {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 16rem;
      min-block-size: 0;
    }
    f-flow {
      display: block;
      block-size: 100%;
      min-block-size: 24rem;
    }
    .step {
      display: flex;
      align-items: center;
      gap: var(--space-1);
      block-size: 36px;
      min-inline-size: 7.5rem;
      max-inline-size: 10rem;
      padding: 0 var(--space-2);
      color: var(--color-fg);
      background: var(--color-bg-raised);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      font-size: 0.8125rem;
      user-select: none;
    }
    .step[data-kind='start'],
    .step[data-kind='end'] {
      border-radius: 18px;
    }
    .step[data-kind='branch'],
    .step[data-kind='parallel'] {
      border-style: dashed;
    }
    .step[data-marker='warning'] {
      border-color: var(--color-warning);
    }
    .step[data-marker='error'] {
      border-color: var(--color-danger);
      background: var(--color-danger-bg);
    }
    :host ::ng-deep .f-selected.step {
      outline: 2px solid var(--color-accent);
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .port {
      inline-size: 10px;
      block-size: 10px;
      flex: none;
      background: var(--color-bg);
      border: 2px solid var(--color-fg-muted);
      border-radius: 50%;
    }
    .port.in {
      margin-inline-start: calc(-1 * var(--space-2) - 6px);
    }
    .port.out {
      margin-inline-start: auto;
      margin-inline-end: calc(-1 * var(--space-2) - 6px);
    }
    .edge-label {
      padding: 0 var(--space-1);
      color: var(--color-fg-muted);
      background: var(--color-bg);
      font-size: 0.6875rem;
    }
    .side {
      padding: var(--space-2);
      overflow: auto;
      border-inline-start: 1px solid var(--color-border);
    }
    .side h3 {
      margin: var(--space-2) 0 var(--space-1);
      font-size: 0.75rem;
      text-transform: uppercase;
      color: var(--color-fg-muted);
    }
    .side label {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
      margin-block-end: var(--space-1);
    }
    .side label.check {
      flex-direction: row;
      align-items: center;
    }
    .json {
      margin: 0;
      font-size: 0.75rem;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .side .feel {
      font-family: ui-monospace, monospace;
    }
    .side input {
      padding: var(--space-1) var(--space-2);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
    }
    .issues {
      margin: 0;
      padding-inline-start: var(--space-3);
      font-size: 0.75rem;
    }
    .issues [data-severity='error'] {
      color: var(--color-danger);
    }
    .issues [data-severity='warning'] {
      color: var(--color-warning);
    }
    .muted,
    .meta {
      color: var(--color-fg-muted);
    }
    .error {
      margin: var(--space-1) var(--space-2);
      color: var(--color-danger);
    }
    .notice {
      margin: var(--space-1) var(--space-2);
      color: var(--color-success);
    }
  `,
})
export class WorkflowEditor implements OnInit {
  readonly workflowId = input.required<string>();
  readonly tabId = input.required<string>();

  private readonly api = inject(WorkflowsService);
  private readonly editors = inject(EditorStore);
  private readonly permissions = inject(PermissionService);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly locale = inject(LocaleService);

  protected readonly workflow = signal<Workflow | null>(null);
  /** The definition being edited — the one source of truth the canvas projects. */
  protected readonly def = signal<WorkflowDefinition | null>(null);
  /** What was last read or saved: "dirty" is the graph differing from it. */
  private readonly saved = signal<string | null>(null);
  protected readonly palette = signal<PaletteEntry[]>([]);
  protected readonly issues = signal<ValidationIssue[]>([]);
  protected readonly validating = signal(false);
  protected readonly selectedSteps = signal<string[]>([]);
  protected readonly selectedEdges = signal<string[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly notice = signal<string | null>(null);
  private validateTimer: ReturnType<typeof setTimeout> | undefined;
  private validation = 0;

  /** UX only — BMS enforces `workflow:admin` on every write. */
  protected readonly canEdit = computed(() => {
    this.session.policy(); // the dependency; the check reads it internally
    const w = this.workflow();
    return !!w && w.state !== 'archived' && this.permissions.can('workflow:admin');
  });
  protected readonly graph = computed(() => {
    const d = this.def();
    return d ? toGraph(d, this.issues()) : { nodes: [], edges: [] };
  });
  protected readonly dirty = computed(() => {
    const d = this.def();
    return !!d && this.saved() !== null && graphOf(d) !== this.saved();
  });
  protected readonly selectedStep = computed(() => {
    const ids = this.selectedSteps();
    return ids.length === 1 ? this.def()?.steps.find((s) => s.id === ids[0]) : undefined;
  });
  /** One edge selected, and no step: its own panel. */
  protected readonly selectedEdge = computed(() => {
    const ids = this.selectedEdges();
    return ids.length === 1 && this.selectedSteps().length === 0
      ? this.def()?.transitions.find((t) => t.id === ids[0])
      : undefined;
  });

  /** The palette entry a kind's property panel is generated from (EP-23.5). */
  protected entryOf(kind: StepKind): PaletteEntry | undefined {
    return this.palette().find((p) => p.kind === kind);
  }

  protected jsonOf(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  protected fromBranch(stepId: string): boolean {
    return this.def()?.steps.find((s) => s.id === stepId)?.kind === 'branch';
  }

  constructor() {
    // The tab's dot follows every edit path. `setDirty` READS the layout it writes, so it runs
    // untracked — tracked, the effect would depend on its own write and never settle.
    effect(() => {
      const tabId = this.tabId();
      const dirty = this.dirty();
      untracked(() => this.editors.setDirty(tabId, dirty));
    });
    this.destroyRef.onDestroy(() => clearTimeout(this.validateTimer));
  }

  ngOnInit(): void {
    this.load();
  }

  /** The workflow, and the definition to show: its open draft, else its latest published version. */
  protected load(): void {
    this.error.set(null);
    this.api.get(this.workflowId()).subscribe({
      next: (w) => {
        this.workflow.set(w);
        if (w.draft) this.show(w.draft);
        else if (w.latestVersion > 0)
          this.api.version(w.id, w.latestVersion).subscribe({
            next: (d) => this.show(d),
            error: () => this.error.set(this.locale.t('workflowEditor.loadError')),
          });
        if (this.canEdit() && this.palette().length === 0)
          this.api.palette().subscribe({
            next: (p) => this.palette.set(p),
            error: () => this.error.set(this.locale.t('workflowEditor.paletteError')),
          });
      },
      error: () => this.error.set(this.locale.t('workflowEditor.loadError')),
    });
  }

  private show(d: WorkflowDefinition): void {
    this.def.set(d);
    this.saved.set(graphOf(d));
    this.selectedSteps.set([]);
    this.selectedEdges.set([]);
    this.scheduleValidation(0);
  }

  protected glyph(kind: StepKind): string {
    return GLYPHS[kind];
  }

  protected kindLabel(p: PaletteEntry): string {
    const key = `workflowEditor.kind.${p.kind}`;
    const t = this.locale.t(key);
    return t === key ? p.label : t;
  }

  protected issuesOf(stepId: string): string | null {
    const mine = this.issues().filter((i) => i.stepId === stepId);
    return mine.length ? mine.map((i) => i.message).join('\n') : null;
  }

  // --- gestures: each one a pure operation on the definition ------------------------------------

  add(kind: StepKind): void {
    const d = this.def();
    if (!d || !this.canEdit()) return;
    const entry = this.palette().find((p) => p.kind === kind);
    const name = entry ? this.kindLabel(entry) : kind;
    const { def, stepId } = addStep(d, kind, name, nextFreePoint(d));
    this.edit(def);
    this.selectedSteps.set([stepId]);
    this.selectedEdges.set([]);
  }

  onConnect(event: FCreateConnectionEvent): void {
    const d = this.def();
    if (!d || !this.canEdit() || event.targetId === undefined) return;
    const result = connect(d, stepOfConnector(event.sourceId), stepOfConnector(event.targetId));
    if ('refused' in result) {
      this.notice.set(null);
      this.error.set(this.locale.t('workflowEditor.refused.' + result.refused));
      return;
    }
    this.error.set(null);
    this.edit(result.def);
  }

  onMove(event: FMoveNodesEvent): void {
    const d = this.def();
    if (!d || !this.canEdit()) return;
    this.edit(moveSteps(d, event.nodes));
  }

  onSelect(event: FSelectionChangeEvent): void {
    this.selectedSteps.set([...event.nodeIds]);
    this.selectedEdges.set([...event.connectionIds]);
  }

  removeSelected(): void {
    const d = this.def();
    if (!d || !this.canEdit()) return;
    const steps = this.selectedSteps();
    const edges = this.selectedEdges();
    if (steps.length + edges.length === 0) return;
    this.edit(removeSelection(d, steps, edges));
    this.selectedSteps.set([]);
    this.selectedEdges.set([]);
  }

  rename(stepId: string, name: string): void {
    const d = this.def();
    if (!d || !this.canEdit()) return;
    this.edit(renameStep(d, stepId, name));
  }

  /** The property panel's whole new config for a step; emptied, it is `{}`, never absent. */
  configure(stepId: string, config: unknown): void {
    const d = this.def();
    if (!d || !this.canEdit()) return;
    this.edit(setStepConfig(d, stepId, (config ?? {}) as StepConfig));
  }

  editEdge(id: string, patch: { name?: string; when?: string }): void {
    const d = this.def();
    if (!d || !this.canEdit()) return;
    this.edit(setEdge(d, id, patch));
  }

  makeDefault(id: string, on: boolean): void {
    const d = this.def();
    if (!d || !this.canEdit()) return;
    this.edit(setDefaultEdge(d, id, on));
  }

  private edit(next: WorkflowDefinition): void {
    if (next === this.def()) return;
    this.def.set(next);
    this.notice.set(null);
    this.scheduleValidation(VALIDATE_DEBOUNCE_MS);
  }

  // --- validation: BMS's rules, on the graph as it stands ----------------------------------------

  private scheduleValidation(delay: number): void {
    clearTimeout(this.validateTimer);
    this.validateTimer = setTimeout(() => this.validate(), delay);
  }

  private validate(): void {
    const w = this.workflow();
    const d = this.def();
    if (!w || !d) return;
    const run = ++this.validation;
    this.validating.set(true);
    this.api.validate(w.id, inputOf(w, d)).subscribe({
      next: (result) => {
        if (run !== this.validation) return; // an edit since — its own run will answer
        this.validating.set(false);
        this.issues.set(result.issues as ValidationIssue[]);
      },
      error: () => {
        if (run !== this.validation) return;
        this.validating.set(false);
      },
    });
  }

  // --- save -------------------------------------------------------------------------------------

  save(): void {
    const w = this.workflow();
    const d = this.def();
    if (!w || !d || !this.dirty() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.saveDraft(w.id, w.revision, inputOf(w, d)).subscribe({
      next: (view) => {
        this.busy.set(false);
        this.workflow.set(view);
        if (view.draft) this.show(view.draft);
        this.notice.set(this.locale.t('workflowEditor.saved'));
        this.editors.setDirty(this.tabId(), false);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        if (err instanceof HttpErrorResponse && err.status === 409) {
          // Someone saved in between: read theirs; never write over it. The read starts by
          // clearing the last error, so the reason is set after it.
          this.load();
          this.error.set(this.locale.t('workflowEditor.moved'));
        } else this.error.set(reasonOf(err) ?? this.locale.t('workflowEditor.saveError'));
      },
    });
  }

  /** The unsaved edits dropped: the workflow read again, as it stands on the server. */
  revert(): void {
    this.load();
  }
}

/** What a save or a validation sends: the whole graph, and the header the designer does not edit. */
export function inputOf(w: Workflow, d: WorkflowDefinition): DraftInput {
  return {
    name: d.name ?? w.name,
    ...(d.description !== undefined ? { description: d.description } : {}),
    ...(d.scope !== undefined ? { scope: d.scope } : {}),
    ...(d.vars !== undefined ? { vars: d.vars as unknown as Record<string, unknown>[] } : {}),
    steps: d.steps as unknown as Record<string, unknown>[],
    transitions: d.transitions as unknown as Record<string, unknown>[],
  };
}

const GLYPHS: Record<StepKind, string> = {
  start: '▶',
  end: '■',
  command: '⚙',
  'human-task': '☺',
  'wait-event': '✉',
  timer: '⏱',
  branch: '◇',
  parallel: '⧉',
  'sub-flow': '↳',
};

/** The service's own words for a refusal, when it gave any. */
function reasonOf(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  const body = err.error as { detail?: unknown; message?: unknown } | null;
  const text = body?.detail ?? body?.message;
  return typeof text === 'string' ? text : null;
}
