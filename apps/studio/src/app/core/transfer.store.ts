import { computed, Injectable, signal } from '@angular/core';
import type { IngestJob } from './generated/rim.types.ts';

/**
 * A transfer's life (EP-20.8; FR-UI-9). `queued` → `uploading` (the parts) → `completing` (the
 * assembly) → `validating` (RIM's probe and rules, EP-15.3/15.4) → `done` with the job it became;
 * or `failed` (retryable — the parts already held are kept server-side, EP-15.1) or `cancelled`.
 */
export type TransferState =
  'queued' | 'uploading' | 'completing' | 'validating' | 'done' | 'failed' | 'cancelled';

export interface Transfer {
  /** Local to this Studio session — the tray's key, not RIM's id. */
  id: string;
  name: string;
  sizeBytes: number;
  /** Bytes the server holds, parts confirmed plus the one in flight — what the bar shows. */
  sentBytes: number;
  state: TransferState;
  /** RIM's upload, once started: what a retry resumes from. */
  uploadId?: string;
  /** The ingest job, once completed; carries the verdict when `done`. */
  job?: IngestJob;
  /** Why it failed, in words a person reads. */
  error?: string;
  startedAt: number;
}

export type TransferPatch = { [K in keyof Omit<Transfer, 'id'>]?: Transfer[K] | undefined };

const ACTIVE: readonly TransferState[] = ['queued', 'uploading', 'completing', 'validating'];
export const isActive = (t: Transfer): boolean => ACTIVE.includes(t.state);

/**
 * The transfers this session started, for the tray. A store rather than component state so an
 * upload outlives the panel that started it: navigating away from Ingest must not abort a 4 GB
 * master half-way, and the tray is where it keeps being visible.
 *
 * Studio never persists a token, and a File cannot be persisted either, so a reload loses the
 * list — but not the parts: RIM keeps them until the upload's TTL, and the next attempt at the
 * same file resumes them (upload.service.ts).
 */
@Injectable({ providedIn: 'root' })
export class TransferStore {
  private readonly _transfers = signal<readonly Transfer[]>([]);
  readonly transfers = this._transfers.asReadonly();
  readonly minimized = signal(false);

  readonly active = computed(() => this._transfers().filter(isActive));
  readonly finished = computed(() => this._transfers().filter((t) => !isActive(t)));
  /** Bytes over bytes across every ACTIVE transfer — the tray's one number. */
  readonly overallPercent = computed(() => {
    const active = this.active();
    const total = active.reduce((n, t) => n + t.sizeBytes, 0);
    if (total === 0) return active.length > 0 ? 0 : 100;
    return Math.min(100, Math.floor((active.reduce((n, t) => n + t.sentBytes, 0) / total) * 100));
  });

  add(input: { name: string; sizeBytes: number }): Transfer {
    const transfer: Transfer = {
      id: crypto.randomUUID(),
      name: input.name,
      sizeBytes: input.sizeBytes,
      sentBytes: 0,
      state: 'queued',
      startedAt: Date.now(),
    };
    this._transfers.update((list) => [transfer, ...list]);
    return transfer;
  }

  /** A field given as `undefined` is cleared — a retry drops its `error`, a swept upload its id. */
  update(id: string, patch: TransferPatch): void {
    this._transfers.update((list) =>
      list.map((t) => {
        if (t.id !== id) return t;
        const next = { ...t } as Record<string, unknown>;
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        return next as unknown as Transfer;
      }),
    );
  }

  get(id: string): Transfer | undefined {
    return this._transfers().find((t) => t.id === id);
  }

  remove(id: string): void {
    this._transfers.update((list) => list.filter((t) => t.id !== id));
  }

  /** Dismiss what is over — done, failed or cancelled. Active ones stay. */
  clearFinished(): void {
    this._transfers.update((list) => list.filter(isActive));
  }
}
