import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type OnInit,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { WorkflowSummary } from '../core/generated/bms.types.ts';
import { LocaleService } from '../core/locale.service.ts';
import { PermissionService } from '../core/permission.service.ts';
import { SessionStore } from '../core/session.store.ts';
import { WebSocketService } from '../core/websocket.service.ts';
import { WorkflowsService } from '../core/workflows.service.ts';

/** One construct BMS refused in an imported file (bms.yaml `ImportFailureDetails`). */
interface Refused {
  elementId?: string;
  elementType: string;
  reason?: string;
}

/** Saves text as a file the browser downloads. Replaced in tests, which have no object URLs. */
export function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A file name from a workflow's name: what a person would call the file, safe on every OS. */
export function fileNameOf(name: string): string {
  // Control characters and the ones a file system reserves become spaces, then dashes.
  const base = [...name.normalize('NFKC')]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .trim()
    .replace(/\s+/g, '-');
  return `${base || 'workflow'}.bpmn`;
}

/**
 * The Workflows panel (EP-23.8; bms.md, DSL §11): the channel's workflows, and BPMN 2.0 in and
 * out. BMS does the converting — a file is sent as it is and comes back as a new workflow's
 * draft, or refused with every construct outside the subset named; an export is the open draft,
 * else the latest published version, with its layout. The canvas that edits a workflow is EP-23.4.
 *
 * Import is offered to `workflow:admin` (UX only — BMS enforces it); every reader may export.
 */
@Component({
  selector: 'atlas-workflows-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="panel-title">{{ locale.t('workbench.panels.workflows') }}</h2>

    @if (canAdmin()) {
      <label class="import">
        <input
          type="file"
          class="visually-hidden"
          accept=".bpmn,.xml,application/xml,text/xml"
          [disabled]="busy()"
          (change)="pick($event)"
        />
        <span class="button">{{ locale.t('workflowsPanel.import') }}</span>
      </label>
    }

    @if (notice()) {
      <p class="notice" role="status">{{ notice() }}</p>
    }
    @if (error()) {
      <div class="error" role="alert">
        <p>{{ error() }}</p>
        @if (refused().length > 0) {
          <ul class="refused">
            @for (r of refused(); track $index) {
              <li>
                <code>{{ r.elementType }}</code>
                @if (r.elementId) {
                  “{{ r.elementId }}”
                }
                @if (r.reason) {
                  — {{ r.reason }}
                }
              </li>
            }
          </ul>
        }
      </div>
    }

    @if (loaded() && items().length === 0) {
      <p class="muted">{{ locale.t('workflowsPanel.none') }}</p>
    }
    <ul class="items">
      @for (w of items(); track w.id) {
        <li>
          <span class="title">{{ w.name }}</span>
          <span class="meta">
            {{ locale.t('workflowsPanel.state.' + w.state) }}
            @if (w.latestVersion > 0) {
              · v{{ w.latestVersion }}
            }
            @if (w.draftVersion !== undefined) {
              · {{ locale.t('workflowsPanel.draft') }} v{{ w.draftVersion }}
            }
          </span>
          <button
            type="button"
            [disabled]="busy()"
            [attr.aria-label]="locale.t('workflowsPanel.export') + ' ' + w.name"
            (click)="export(w)"
          >
            {{ locale.t('workflowsPanel.export') }}
          </button>
        </li>
      }
    </ul>
    @if (nextCursor()) {
      <button type="button" class="more" (click)="more()">
        {{ locale.t('workflowsPanel.more') }}
      </button>
    }
  `,
  styles: `
    .panel-title {
      margin: 0 0 var(--space-2);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--color-fg-muted);
    }
    .import {
      display: inline-block;
      margin-block-end: var(--space-2);
      cursor: pointer;
    }
    .button,
    button {
      padding: var(--space-1) var(--space-2);
      color: inherit;
      background: var(--color-bg-hover);
      border: 1px solid transparent;
      border-radius: var(--radius-md);
      font: inherit;
      cursor: pointer;
    }
    .import:focus-within .button {
      outline: 2px solid var(--color-accent);
    }
    .items {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .items li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0 var(--space-2);
      align-items: center;
      padding: var(--space-1) 0;
      border-block-end: 1px solid var(--color-border);
    }
    .title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .meta {
      grid-column: 1;
      color: var(--color-fg-muted);
      font-size: 0.75rem;
    }
    .items button {
      grid-column: 2;
      grid-row: 1 / span 2;
    }
    .more {
      margin-block-start: var(--space-2);
    }
    .muted {
      color: var(--color-fg-muted);
    }
    .notice {
      color: var(--color-success);
    }
    .error {
      color: var(--color-danger);
    }
    .refused {
      margin: 0;
      padding-inline-start: var(--space-3);
    }
    .visually-hidden {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class WorkflowsPanel implements OnInit {
  private readonly api = inject(WorkflowsService);
  private readonly permissions = inject(PermissionService);
  private readonly session = inject(SessionStore);
  private readonly ws = inject(WebSocketService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly locale = inject(LocaleService);

  /** Where an export goes — the browser's download, unless a test says otherwise. */
  download: (filename: string, text: string, type: string) => void = downloadText;

  protected readonly items = signal<WorkflowSummary[]>([]);
  protected readonly nextCursor = signal<string | undefined>(undefined);
  protected readonly loaded = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly refused = signal<Refused[]>([]);
  protected readonly notice = signal<string | null>(null);

  /** UX only — BMS enforces `workflow:admin` on an import. */
  protected readonly canAdmin = computed(() => {
    this.session.policy(); // the dependency; the check reads it internally
    return this.permissions.can('workflow:admin');
  });

  ngOnInit(): void {
    this.refresh();
    // The catalog store holds the subscription to `workflow.changed` (EP-22.11); the panel only
    // listens. A resync means something may have been missed.
    merge(
      this.ws.events$.pipe(filter(({ subject }) => subject.endsWith('.workflow.changed'))),
      this.ws.resync$,
    )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.refresh());
  }

  protected refresh(): void {
    this.api.list({ limit: 50 }).subscribe({
      next: (page) => {
        this.items.set(page.items);
        this.nextCursor.set(page.nextCursor);
        this.loaded.set(true);
      },
      error: () => this.error.set(this.locale.t('workflowsPanel.loadError')),
    });
  }

  protected more(): void {
    const after = this.nextCursor();
    if (!after) return;
    this.api.list({ after, limit: 50 }).subscribe({
      next: (page) => {
        this.items.update((all) => [...all, ...page.items]);
        this.nextCursor.set(page.nextCursor);
      },
      error: () => this.error.set(this.locale.t('workflowsPanel.loadError')),
    });
  }

  protected async pick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // the same file may be chosen again after a fix
    if (!file) return;
    this.import(await file.text());
  }

  /** The file as it is, to BMS; a new draft is listed first, a refusal names what was refused. */
  import(xml: string): void {
    this.busy.set(true);
    this.error.set(null);
    this.refused.set([]);
    this.notice.set(null);
    this.api.importBpmn(xml).subscribe({
      next: (w) => {
        this.busy.set(false);
        this.notice.set(`${this.locale.t('workflowsPanel.imported')} “${w.name}”`);
        this.refresh();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        const details = detailsOf(err);
        if (details?.code === 'UNSUPPORTED_BPMN') {
          this.error.set(this.locale.t('workflowsPanel.unsupported'));
          this.refused.set(details.unsupported);
        } else if (details?.code === 'MALFORMED_XML') {
          this.error.set(this.locale.t('workflowsPanel.malformed'));
        } else this.error.set(reasonOf(err) ?? this.locale.t('workflowsPanel.importError'));
      },
    });
  }

  protected export(w: WorkflowSummary): void {
    this.busy.set(true);
    this.error.set(null);
    this.refused.set([]);
    this.api.exportBpmn(w.id).subscribe({
      next: (xml) => {
        this.busy.set(false);
        this.download(fileNameOf(w.name), xml, 'application/xml');
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.error.set(reasonOf(err) ?? this.locale.t('workflowsPanel.exportError'));
      },
    });
  }
}

/** An import's refusal, when BMS said which kind (`details` of its 422). */
function detailsOf(err: unknown): { code: string; unsupported: Refused[] } | null {
  if (!(err instanceof HttpErrorResponse) || err.status !== 422) return null;
  const details = (err.error as { details?: unknown } | null)?.details as
    { code?: unknown; unsupported?: unknown } | undefined;
  if (typeof details?.code !== 'string') return null;
  return {
    code: details.code,
    unsupported: Array.isArray(details.unsupported) ? (details.unsupported as Refused[]) : [],
  };
}

/** The service's own words for a refusal, when it gave any. */
function reasonOf(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  const body = err.error as { detail?: unknown; message?: unknown } | null;
  const text = body?.detail ?? body?.message;
  return typeof text === 'string' ? text : null;
}
