import { computed, effect, inject, Injectable, Injector, signal } from '@angular/core';
import type { Subscription } from 'rxjs';
import type { CatalogEntry } from './generated/bms.types.ts';
import { SessionStore } from './session.store.ts';
import { WebSocketService } from './websocket.service.ts';
import { WorkflowsService } from './workflows.service.ts';

/**
 * Every signed-in user's copy of the channel's ACTIVE workflows and their definitions (EP-22.11,
 * decided 2026-10-13): loaded when the session starts, kept current by `workflow.changed` — which
 * the WebSocket service broadcasts to everyone in the channel — and re-read on every resync (the
 * socket came back after a gap, or polling while it is down). Dropped on sign-out and when the
 * channel changes, so one channel's workflows never show in another's.
 *
 * A re-read is cheap by construction: the catalog is ETag'd with `Cache-Control: no-cache`, so the
 * browser sends `If-None-Match` itself and an unchanged catalog is a 304 served from its cache; the
 * store compares ETags and leaves the signal untouched, so nothing downstream re-renders for it.
 * Started once, by the workbench (the frame every signed-in view lives in).
 */
@Injectable({ providedIn: 'root' })
export class WorkflowCatalogStore {
  private readonly api = inject(WorkflowsService);
  private readonly session = inject(SessionStore);
  private readonly ws = inject(WebSocketService);
  private readonly injector = inject(Injector);

  private readonly _entries = signal<CatalogEntry[]>([]);
  private readonly _loaded = signal(false);
  private etag: string | undefined;
  private channelId: string | null = null;
  private inFlight: Subscription | undefined;
  private started = false;

  /** The active workflows, as the catalog lists them. */
  readonly entries = this._entries.asReadonly();
  /** True once the first read of this session's channel has landed. */
  readonly loaded = this._loaded.asReadonly();
  readonly byId = computed(() => new Map(this._entries().map((e) => [e.id, e])));

  start(): void {
    if (this.started) return;
    this.started = true;

    effect(
      () => {
        const channelId = this.session.isAuthenticated() ? this.session.channelId() : null;
        if (channelId === this.channelId) return;
        this.clear();
        this.channelId = channelId;
        if (channelId === null) return;
        void this.ws.subscribe(`atlas.${channelId}.workflow.changed`);
        this.load();
      },
      { injector: this.injector },
    );

    this.ws.events$.subscribe(({ subject }) => {
      if (this.channelId !== null && subject === `atlas.${this.channelId}.workflow.changed`)
        this.load();
    });
    this.ws.resync$.subscribe(() => {
      if (this.channelId !== null) this.load();
    });
  }

  /** Re-read the catalog. A read already in flight is replaced: the newest answer wins. */
  load(): void {
    const channelId = this.channelId;
    if (channelId === null) return;
    this.inFlight?.unsubscribe();
    this.inFlight = this.api.catalog().subscribe({
      next: (catalog) => {
        if (this.channelId !== channelId) return; // a channel switch while it was in flight
        this._loaded.set(true);
        if (catalog.etag === this.etag) return;
        this.etag = catalog.etag;
        this._entries.set(catalog.items);
      },
      // Keep the copy we have: a failed refresh is not an empty catalog. The next event or
      // resync tries again.
      error: () => undefined,
    });
  }

  private clear(): void {
    this.inFlight?.unsubscribe();
    this.inFlight = undefined;
    this.etag = undefined;
    this._entries.set([]);
    this._loaded.set(false);
  }
}
