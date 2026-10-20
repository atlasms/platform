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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
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
  WorkflowInstance,
} from '../core/generated/bms.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
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
import { FeelInput } from './feel-input.ts';
import { OVERLAY_REFRESH_MS, isLive, stepStatuses } from './instance-overlay.model.ts';
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
  imports: [FFlowModule, FlowTheme, SchemaField, FeelInput],
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
        @if (instances().length > 0) {
          <select
            class="instances"
            [attr.aria-label]="locale.t('workflowEditor.instances')"
            [disabled]="busy() || dirty()"
            (change)="watch($any($event.target).value)"
          >
            <option value="" [selected]="!overlay()">
              {{ locale.t('workflowEditor.design') }}
            </option>
            @for (i of instances(); track i.id) {
              <option [value]="i.id" [selected]="overlay()?.id === i.id">
                {{ i.startedAt.slice(0, 16).replace('T', ' ') }} ·
                {{ locale.t('workflowEditor.instanceState.' + i.state) }} · v{{ i.version }}
              </option>
            }
          </select>
        }
        @if (versionChoices().length > 1 && !overlay()) {
          <select
            class="versions"
            [attr.aria-label]="locale.t('workflowEditor.versions')"
            [disabled]="busy() || dirty()"
            (change)="view($any($event.target).value)"
          >
            @for (v of versionChoices(); track v.value) {
              <option [value]="v.value" [selected]="v.value === viewingValue()">
                {{ v.label }}
              </option>
            }
          </select>
        }
        <span class="actions">
          @if (canEdit()) {
            <button type="button" [disabled]="busy() || !dirty()" (click)="save()">
              {{ locale.t('workflowEditor.save') }}
            </button>
            <button type="button" class="link" [disabled]="busy() || !dirty()" (click)="revert()">
              {{ locale.t('workflowEditor.revert') }}
            </button>
            @if (w.draftVersion !== undefined || dirty()) {
              <button
                type="button"
                class="primary"
                [disabled]="!canPublish()"
                [attr.title]="publishBlocked() ? locale.t('workflowEditor.publishBlocked') : null"
                (click)="publish()"
              >
                {{ locale.t(dirty() ? 'workflowEditor.saveAndPublish' : 'workflowEditor.publish') }}
              </button>
            }
          } @else {
            <span class="muted">{{ locale.t('workflowEditor.readOnly') }}</span>
          }
          @if (isAdmin() && viewing() === null) {
            @if (w.state === 'active') {
              <button type="button" class="link" [disabled]="busy()" (click)="move('deactivate')">
                {{ locale.t('workflowEditor.deactivate') }}
              </button>
            } @else if (w.state === 'inactive') {
              <button type="button" class="link" [disabled]="busy()" (click)="move('activate')">
                {{ locale.t('workflowEditor.activate') }}
              </button>
            }
            @if (w.state === 'active' || w.state === 'inactive') {
              <button type="button" class="link danger" [disabled]="busy()" (click)="archive()">
                {{
                  locale.t(
                    confirmArchive() ? 'workflowEditor.confirmArchive' : 'workflowEditor.archive'
                  )
                }}
              </button>
            }
          }
        </span>
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
                  [attr.data-status]="n.status ?? null"
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
          @if (overlay(); as run) {
            <section class="run" [attr.data-state]="run.state">
              <h3>{{ locale.t('workflowEditor.run') }}</h3>
              <p>
                {{ locale.t('workflowEditor.instanceState.' + run.state) }} · v{{ run.version }}
                @if (live()) {
                  <span class="muted">· {{ locale.t('workflowEditor.following') }}</span>
                }
              </p>
              <p class="muted">
                {{ locale.t('workflowEditor.startedBy') }} {{ run.startedBy }} ·
                {{ run.startedAt.slice(0, 16).replace('T', ' ') }}
                @if (run.endedAt) {
                  → {{ run.endedAt.slice(0, 16).replace('T', ' ') }}
                }
              </p>
              @if (run.error) {
                <p class="error">{{ run.error }}</p>
              }
              <ol class="history">
                @for (h of run.history ?? []; track h.seq) {
                  <li [attr.data-event]="h.event">
                    <span class="at">{{ h.at.slice(11, 19) }}</span>
                    {{ stepName(h.stepId) }} — {{ locale.t('workflowEditor.event.' + h.event) }}
                  </li>
                }
              </ol>
            </section>
          }
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
                [vars]="varNames()"
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
              <div class="when">
                <span>{{ locale.t('workflowEditor.when') }}</span>
                <atlas-feel-input
                  [value]="e.when ?? ''"
                  [readOnly]="!canEdit()"
                  [vars]="varNames()"
                  [ariaLabel]="locale.t('workflowEditor.when')"
                  (valueChange)="editEdge(e.id, { when: $event })"
                />
              </div>
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
    .actions button.danger {
      margin-inline-start: 0;
    }
    button.primary {
      color: var(--color-fg-on-accent);
      background: var(--color-accent);
    }
    .history {
      margin: 0;
      padding-inline-start: var(--space-3);
      font-size: 0.75rem;
    }
    .history [data-event='failed'] {
      color: var(--color-danger);
    }
    .history .at {
      color: var(--color-fg-muted);
      font-family: ui-monospace, monospace;
    }
    .run p {
      margin: 0 0 var(--space-1);
      font-size: 0.75rem;
    }
    .instances,
    .versions {
      padding: var(--space-1);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
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
    .step[data-status='done'] {
      border-color: var(--color-success);
      background: var(--color-success-bg);
    }
    .step[data-status='active'],
    .step[data-status='waiting'] {
      border-color: var(--color-accent);
      background: var(--color-accent-bg);
      box-shadow: 0 0 0 2px var(--color-accent);
    }
    .step[data-marker='warning'],
    .step[data-status='compensated'] {
      border-color: var(--color-warning);
    }
    .step[data-marker='error'],
    .step[data-status='failed'] {
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
    .side .when {
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
  private readonly ws = inject(WebSocketService);
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
  private followTimer: ReturnType<typeof setInterval> | undefined;
  private validation = 0;

  /** UX only — BMS enforces `workflow:admin` on every write. */
  protected readonly isAdmin = computed(() => {
    this.session.policy(); // the dependency; the check reads it internally
    const w = this.workflow();
    return !!w && w.state !== 'archived' && this.permissions.can('workflow:admin');
  });
  /** A published version picked from the list (EP-23.7); null is the editable one. */
  protected readonly viewing = signal<number | null>(null);
  /** Editable: an admin, on the draft (or the latest version, which saving makes a draft). */
  protected readonly canEdit = computed(
    () => this.isAdmin() && this.viewing() === null && this.overlay() === null,
  );
  /** The workflow's recent instances (EP-23.9), for the overlay's picker. */
  protected readonly instances = signal<WorkflowInstance[]>([]);
  /** The instance painted on the canvas, or null — the designer as such. */
  protected readonly overlay = signal<WorkflowInstance | null>(null);
  protected readonly live = computed(() => {
    const run = this.overlay();
    return !!run && isLive(run.state);
  });
  protected readonly confirmArchive = signal(false);
  protected readonly viewingValue = computed(() => String(this.viewing() ?? 'current'));
  /** The editable definition first, then every other published version, newest first. */
  protected readonly versionChoices = computed(() => {
    const w = this.workflow();
    if (!w) return [];
    const current =
      w.draftVersion !== undefined
        ? `${this.locale.t('workflowsPanel.draft')} v${w.draftVersion}`
        : `v${w.latestVersion} · ${this.locale.t('workflowEditor.latest')}`;
    const published = w.versions
      .filter((v) => w.draftVersion !== undefined || v.version !== w.latestVersion)
      .map((v) => ({
        value: String(v.version),
        label: `v${v.version} · ${v.publishedAt.slice(0, 10)} · ${v.publishedBy}`,
      }));
    return [{ value: 'current', label: current }, ...published];
  });
  /** Publish waits for a clean judgement: never while BMS is judging, or has found an error. */
  protected readonly publishBlocked = computed(
    () => this.validating() || this.issues().some((i) => i.severity === 'error'),
  );
  protected readonly canPublish = computed(
    () => this.canEdit() && !this.busy() && !this.publishBlocked(),
  );
  protected readonly graph = computed(() => {
    const d = this.def();
    const run = this.overlay();
    if (!d) return { nodes: [], edges: [] };
    // A run is painted by its statuses alone: the validator's markers are about the draft.
    return run
      ? toGraph(d, [], stepStatuses(run.history ?? [], run.currentSteps))
      : toGraph(d, this.issues());
  });
  protected readonly dirty = computed(() => {
    const d = this.def();
    return !!d && this.saved() !== null && graphOf(d) !== this.saved();
  });
  protected readonly selectedStep = computed(() => {
    const ids = this.selectedSteps();
    return ids.length === 1 ? this.def()?.steps.find((s) => s.id === ids[0]) : undefined;
  });
  /** The declared vars, offered and checked by every FEEL field (EP-23.6). */
  protected readonly varNames = computed(() => (this.def()?.vars ?? []).map((v) => v.name));
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
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.validateTimer);
      this.stopFollowing();
    });
  }

  ngOnInit(): void {
    this.load();
  }

  /** The workflow, and the definition to show: its open draft, else its latest published version. */
  protected load(): void {
    this.error.set(null);
    this.viewing.set(null);
    this.overlay.set(null);
    this.confirmArchive.set(false);
    this.api.instances(this.workflowId()).subscribe({
      next: (page) => this.instances.set(page.items),
      error: () => this.instances.set([]), // no runs to show is not the designer's error
    });
    this.api.get(this.workflowId()).subscribe({
      next: (w) => {
        this.workflow.set(w);
        if (w.draft) this.show(w.draft);
        else if (w.latestVersion > 0)
          this.api.version(w.id, w.latestVersion).subscribe({
            next: (d) => this.show(d),
            error: () => this.error.set(this.locale.t('workflowEditor.loadError')),
          });
        if (this.isAdmin() && this.palette().length === 0)
          this.api.palette().subscribe({
            next: (p) => this.palette.set(p),
            error: () => this.error.set(this.locale.t('workflowEditor.paletteError')),
          });
      },
      error: () => this.error.set(this.locale.t('workflowEditor.loadError')),
    });
  }

  private show(d: WorkflowDefinition, judge = true): void {
    this.def.set(d);
    this.saved.set(graphOf(d));
    this.selectedSteps.set([]);
    this.selectedEdges.set([]);
    if (judge) this.scheduleValidation(0);
    else {
      clearTimeout(this.validateTimer);
      this.validating.set(false);
      this.issues.set([]);
    }
  }

  protected stepName(stepId: string): string {
    return this.def()?.steps.find((s) => s.id === stepId)?.name ?? stepId;
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
    // Pending from the edit on, not from the request: a graph waiting out the debounce has not
    // been judged, and publish must not be offered on it.
    this.validating.set(true);
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

  /** The draft saved; `then` runs with the saved workflow (Save and publish). */
  save(then?: (saved: Workflow) => void): void {
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
        then?.(view);
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

  // --- the live-instance overlay (EP-23.9) ---------------------------------------------------

  /**
   * An instance on the canvas — the version it is PINNED to, read-only, each step coloured by
   * where the run is — or, with no id, back to designing. A live run is re-read every
   * {@link OVERLAY_REFRESH_MS} and whenever an event names it: BMS publishes no event per step,
   * so the history is read, not pushed.
   */
  watch(instanceId: string): void {
    const w = this.workflow();
    if (!w || this.dirty()) return;
    this.stopFollowing();
    if (instanceId === '') {
      this.load();
      return;
    }
    this.error.set(null);
    this.api.instance(instanceId).subscribe({
      next: (run) => {
        this.api.version(w.id, run.version).subscribe({
          next: (d) => {
            this.overlay.set(run);
            this.show(d, false);
            this.follow();
          },
          error: () => this.error.set(this.locale.t('workflowEditor.loadError')),
        });
      },
      error: () => this.error.set(this.locale.t('workflowEditor.runError')),
    });
  }

  private follow(): void {
    this.stopFollowing();
    if (!this.live()) return;
    this.followTimer = setInterval(() => this.reread(), OVERLAY_REFRESH_MS);
  }

  private stopFollowing(): void {
    clearInterval(this.followTimer);
    this.followTimer = undefined;
  }

  /** The run read again; it stops being followed once it can no longer move. */
  private reread(): void {
    const run = this.overlay();
    if (!run) return this.stopFollowing();
    this.api.instance(run.id).subscribe({
      next: (fresh) => {
        if (this.overlay()?.id !== fresh.id) return; // left, or another run picked, meanwhile
        this.overlay.set(fresh);
        if (!isLive(fresh.state)) this.stopFollowing();
      },
      error: () => undefined, // the next tick tries again; a run read once stays on the canvas
    });
  }

  // `workflow.*` events reach a holder of workflow:read (websocket eligibility). One that names
  // the instance on the canvas re-reads it at once rather than at the next tick.
  private readonly wsSubscription = effect(() => {
    const channelId = this.session.channelId();
    if (channelId) void this.ws.subscribe(`atlas.${channelId}.workflow.>`);
  });
  private readonly wsEvents = this.ws.events$
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(({ payload }) => {
      const id = (payload as { payload?: { instanceId?: unknown } } | null)?.payload?.instanceId;
      if (typeof id === 'string' && id === this.overlay()?.id) this.reread();
    });

  // --- versions, publish, lifecycle (EP-23.7) ------------------------------------------------

  /** A published version shown read-only — or, `current`, back to the editable one. */
  view(choice: string): void {
    const w = this.workflow();
    if (!w || this.dirty()) return;
    if (choice === 'current') {
      this.load();
      return;
    }
    const version = Number(choice);
    this.api.version(w.id, version).subscribe({
      next: (d) => {
        this.viewing.set(version);
        this.show(d);
      },
      error: () => this.error.set(this.locale.t('workflowEditor.loadError')),
    });
  }

  /**
   * The draft published as an immutable version: saved first when it has unsaved edits, over
   * the revision that save returned. BMS judges it again — a 422's issues are painted where they
   * belong, a 403 is its reason (the authority a command step needs), a 409 a re-read.
   */
  publish(): void {
    if (!this.canPublish()) return;
    if (this.dirty()) {
      this.save((saved) => this.publishAt(saved));
      return;
    }
    const w = this.workflow();
    if (w) this.publishAt(w);
  }

  private publishAt(w: Workflow): void {
    this.busy.set(true);
    this.error.set(null);
    this.api.publish(w.id, w.revision).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.load();
        const warnings = result.warnings?.length ?? 0;
        this.notice.set(
          `${this.locale.t('workflowEditor.published')} v${result.version}` +
            (warnings > 0 ? ` · ${warnings} ${this.locale.t('workflowEditor.warnings')}` : ''),
        );
      },
      error: (err: unknown) => {
        this.busy.set(false);
        if (err instanceof HttpErrorResponse && err.status === 422) {
          const body = err.error as { details?: { issues?: ValidationIssue[] } } | null;
          if (body?.details?.issues) this.issues.set(body.details.issues);
          this.error.set(this.locale.t('workflowEditor.publishInvalid'));
        } else if (err instanceof HttpErrorResponse && err.status === 409) {
          this.load();
          this.error.set(this.locale.t('workflowEditor.moved'));
        } else this.error.set(reasonOf(err) ?? this.locale.t('workflowEditor.publishError'));
      },
    });
  }

  /** Archiving is final, so it takes a second click. */
  archive(): void {
    if (!this.confirmArchive()) {
      this.confirmArchive.set(true);
      return;
    }
    this.confirmArchive.set(false);
    this.move('archive');
  }

  /** A lifecycle move; refused while instances run, which BMS counts (`details.running`). */
  move(action: 'activate' | 'deactivate' | 'archive'): void {
    const w = this.workflow();
    if (!w || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api.transition(w.id, action, w.revision).subscribe({
      next: (view) => {
        this.busy.set(false);
        this.workflow.set(view);
        this.notice.set(this.locale.t(`workflowEditor.done.${action}`));
      },
      error: (err: unknown) => {
        this.busy.set(false);
        const body =
          err instanceof HttpErrorResponse
            ? (err.error as { details?: { running?: unknown } } | null)
            : null;
        const running = body?.details?.running;
        if (typeof running === 'number' && running > 0) {
          this.error.set(`${this.locale.t('workflowEditor.running')} ${running}`);
        } else if (err instanceof HttpErrorResponse && err.status === 409) {
          this.load();
          this.error.set(this.locale.t('workflowEditor.moved'));
        } else this.error.set(reasonOf(err) ?? this.locale.t('workflowEditor.moveError'));
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
