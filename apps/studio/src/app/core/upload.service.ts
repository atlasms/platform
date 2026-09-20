import { HttpClient, HttpEventType, type HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { API_BASE_URL } from './api.ts';
import { ApiClient, urlOf } from './api-client.ts';
import type { IngestJob, Upload } from './generated/rim.types.ts';
import { RimOperations as ops } from './generated/rim.operations.ts';
import { TransferStore, type Transfer } from './transfer.store.ts';

/**
 * The uploader (the rest of EP-20.3) against RIM's chunked, resumable upload (EP-15.1).
 *
 * THE SERVER SIZES THE PARTS. `POST /uploads` answers with `partSizeBytes` and `partCount`; the
 * file is sliced that way, every part but the last exactly that long, and sent one at a time —
 * a part is 8 MiB, and one at a time is what a browser tab's upload bandwidth serves best without
 * starving the session's other requests. Each part's bytes are counted as they leave (the
 * request's upload progress), so the bar moves inside a part, not only between them.
 *
 * RESUME IS ONE MORE ATTEMPT, NOT A SPECIAL PATH. A failed transfer keeps its `uploadId`; Retry
 * asks `GET /uploads/{id}` which parts the server already holds and sends the rest — the parts
 * are on the server (EP-15.1), not in this tab. A part that fails on the way is sent again up to
 * three times with a growing pause; a part the server refuses (4xx) is not, since the same bytes
 * would be refused the same way.
 *
 * COMPLETION IS THE HAND-OFF. `POST /complete` answers the job at `detected`; the verdict — the
 * probe, the acceptance rules — follows on the server (EP-15.3/15.4), so the transfer polls
 * `GET /ingest/{id}` until the state settles and shows it: accepted, quarantined, rejected.
 */
export interface UploadOptions {
  /** Pause before the n-th retry of a part; injected so a test does not wait. */
  backoffMs?: (attempt: number) => number;
  /** Between polls of the job's state after completion. */
  pollIntervalMs?: number;
  /** Give up polling after this — the job stays `validating` in the tray, not lost. */
  pollTimeoutMs?: number;
}

const PART_ATTEMPTS = 3;
const SETTLED: readonly IngestJob['state'][] = [
  'accepted',
  'quarantined',
  'rejected',
  'registered',
];

class Cancelled extends Error {
  override readonly name = 'Cancelled';
}

@Injectable({ providedIn: 'root' })
export class UploadService {
  private readonly api = inject(ApiClient);
  private readonly http = inject(HttpClient);
  private readonly base = inject(API_BASE_URL);
  private readonly transfers = inject(TransferStore);

  /** The File behind each transfer — never in the store: a File is not state, it is a handle. */
  private readonly files = new Map<string, File>();
  private readonly cancels = new Map<string, AbortController>();
  private options: Required<UploadOptions> = {
    backoffMs: (attempt) => 1000 * 2 ** (attempt - 1),
    pollIntervalMs: 1000,
    pollTimeoutMs: 120_000,
  };

  configure(options: UploadOptions): void {
    this.options = { ...this.options, ...options };
  }

  /** Enqueue a file and run it. Resolves with the transfer as it ended — done, failed or cancelled. */
  start(file: File): Promise<Transfer> {
    const transfer = this.transfers.add({ name: file.name, sizeBytes: file.size });
    this.files.set(transfer.id, file);
    return this.run(transfer.id);
  }

  /** One more attempt at a failed transfer, from the parts the server already holds. */
  retry(id: string): Promise<Transfer> {
    const transfer = this.transfers.get(id);
    if (!transfer || transfer.state !== 'failed' || !this.files.has(id)) {
      return Promise.resolve(transfer ?? this.missing(id));
    }
    this.transfers.update(id, { state: 'queued', error: undefined });
    return this.run(id);
  }

  /** Stop an active transfer and abandon its upload server-side. */
  async cancel(id: string): Promise<void> {
    this.cancels.get(id)?.abort();
    const transfer = this.transfers.get(id);
    if (!transfer) return;
    this.transfers.update(id, { state: 'cancelled' });
    this.files.delete(id);
    if (transfer.uploadId && transfer.state !== 'validating' && transfer.state !== 'done') {
      // Best effort: the sweeper takes an abandoned upload anyway (ATLAS_UPLOAD_TTL_MS).
      await firstValueFrom(
        this.api.call(ops.abortUpload, { params: { id: transfer.uploadId } }).as<void>(),
      ).catch(() => undefined);
    }
  }

  // --- the attempt ------------------------------------------------------------------------------------

  private async run(id: string): Promise<Transfer> {
    const file = this.files.get(id);
    if (!file) return this.missing(id);
    const controller = new AbortController();
    this.cancels.set(id, controller);
    try {
      const upload = await this.startOrResume(id, file);
      await this.sendParts(id, file, upload, controller.signal);
      this.transfers.update(id, { state: 'completing' });
      const job = await firstValueFrom(
        this.api.call(ops.completeUpload, { params: { id: upload.uploadId } }).as<IngestJob>(),
      );
      this.transfers.update(id, { state: 'validating', job, sentBytes: file.size });
      const settled = await this.awaitVerdict(job, controller.signal);
      this.transfers.update(id, { state: 'done', job: settled });
      this.files.delete(id);
    } catch (err) {
      if (!(err instanceof Cancelled)) {
        this.transfers.update(id, { state: 'failed', error: describe(err) });
      }
    } finally {
      this.cancels.delete(id);
    }
    return this.transfers.get(id) ?? this.missing(id);
  }

  /** The upload to send to: the one already started (a retry), else a new one. */
  private async startOrResume(id: string, file: File): Promise<Upload> {
    this.transfers.update(id, { state: 'uploading' });
    const existing = this.transfers.get(id)?.uploadId;
    if (existing) {
      try {
        return await firstValueFrom(
          this.api.call(ops.getUpload, { params: { id: existing } }).as<Upload>(),
        );
      } catch (err) {
        // Swept (past its TTL) since the last attempt: nothing to resume, start over.
        if ((err as HttpErrorResponse).status !== 404) throw err;
        this.transfers.update(id, { uploadId: undefined, sentBytes: 0 });
      }
    }
    const upload = await firstValueFrom(
      this.api
        .call(ops.startUpload, {
          body: {
            filename: file.name,
            sizeBytes: file.size,
            ...(file.type ? { contentType: file.type } : {}),
          },
        })
        .as<Upload>(),
    );
    this.transfers.update(id, { uploadId: upload.uploadId });
    return upload;
  }

  private async sendParts(
    id: string,
    file: File,
    upload: Upload,
    signal: AbortSignal,
  ): Promise<void> {
    const { partSizeBytes, partCount } = upload;
    const held = new Set(upload.received);
    const bytesOf = (n: number): number =>
      n === partCount ? file.size - partSizeBytes * (partCount - 1) : partSizeBytes;
    let confirmed = [...held].reduce((sum, n) => sum + bytesOf(n), 0);
    this.transfers.update(id, { sentBytes: confirmed });

    for (let n = 1; n <= partCount; n += 1) {
      if (held.has(n)) continue;
      if (signal.aborted) throw new Cancelled();
      const start = partSizeBytes * (n - 1);
      const slice = file.slice(start, start + bytesOf(n));
      await this.sendPart(id, upload.uploadId, n, slice, confirmed, signal);
      confirmed += slice.size;
      this.transfers.update(id, { sentBytes: confirmed });
    }
  }

  /** One part, with the retries; progress inside the part is reported against `confirmed`. */
  private async sendPart(
    id: string,
    uploadId: string,
    n: number,
    slice: Blob,
    confirmed: number,
    signal: AbortSignal,
  ): Promise<void> {
    const url = urlOf(this.base, ops.putUploadPart, { params: { id: uploadId, n: String(n) } });
    for (let attempt = 1; ; attempt += 1) {
      if (signal.aborted) throw new Cancelled();
      try {
        await new Promise<void>((resolve, reject) => {
          const subscription = this.http
            .request('PUT', url, {
              body: slice,
              headers: { 'content-type': 'application/octet-stream' },
              reportProgress: true,
              observe: 'events',
            })
            .subscribe({
              next: (event) => {
                if (event.type === HttpEventType.UploadProgress) {
                  this.transfers.update(id, { sentBytes: confirmed + event.loaded });
                }
              },
              error: reject,
              complete: resolve,
            });
          signal.addEventListener(
            'abort',
            () => {
              subscription.unsubscribe();
              reject(new Cancelled());
            },
            { once: true },
          );
        });
        return;
      } catch (err) {
        if (err instanceof Cancelled) throw err;
        const status = (err as HttpErrorResponse).status;
        // The server refused these bytes: sending them again changes nothing. Anything else —
        // a dropped connection, a 5xx, a gateway timeout — may be the network, and is retried.
        const refused = status >= 400 && status < 500;
        if (refused || attempt >= PART_ATTEMPTS || signal.aborted) throw err;
        await sleep(this.options.backoffMs(attempt), signal);
      }
    }
  }

  /** Poll the job until RIM has decided, or the budget is spent — then it is still `validating`. */
  private async awaitVerdict(job: IngestJob, signal: AbortSignal): Promise<IngestJob> {
    const deadline = Date.now() + this.options.pollTimeoutMs;
    let current = job;
    while (!SETTLED.includes(current.state) && Date.now() < deadline) {
      await sleep(this.options.pollIntervalMs, signal);
      current = await firstValueFrom(
        this.api.call(ops.getIngestJob, { params: { id: job.id } }).as<IngestJob>(),
      );
    }
    return current;
  }

  private missing(id: string): Transfer {
    return {
      id,
      name: '',
      sizeBytes: 0,
      sentBytes: 0,
      state: 'failed',
      error: 'no such transfer',
      startedAt: 0,
    };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Cancelled());
      },
      { once: true },
    );
  });
}

/** The problem document's message when there is one; the transport's otherwise. */
function describe(err: unknown): string {
  const response = err as HttpErrorResponse;
  const problem = response?.error as { message?: string; detail?: string } | undefined;
  if (problem && typeof problem === 'object') {
    const text = problem.message ?? problem.detail;
    if (text) return text;
  }
  if (typeof response?.status === 'number' && response.status > 0) {
    return `${response.status} ${response.statusText || ''}`.trim();
  }
  return (err as Error)?.message || 'upload failed';
}
