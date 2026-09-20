// The uploader (EP-20.3) as a client of RIM's contract (EP-15.1): the server's part size is
// obeyed, resume sends only what is missing, a part is retried but a refusal is not, completion
// hands off and the verdict is polled, cancel abandons the upload. Every request is asserted by
// URL and method against a fake gateway — the same shape the smoke suite drives for real.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { API_BASE_URL } from './api.ts';
import type { IngestJob, Upload } from './generated/rim.types.ts';
import { TransferStore } from './transfer.store.ts';
import { UploadService } from './upload.service.ts';

const PART = 1024;

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: '/gateway' },
    ],
  });
  const uploads = TestBed.inject(UploadService);
  uploads.configure({ backoffMs: () => 0, pollIntervalMs: 0, pollTimeoutMs: 5_000 });
  return {
    uploads,
    http: TestBed.inject(HttpTestingController),
    store: TestBed.inject(TransferStore),
  };
}

const file = (name: string, size: number): File =>
  new File([new Uint8Array(size)], name, { type: 'application/octet-stream' });

const upload = (over: Partial<Upload> = {}): Upload => ({
  uploadId: '01H00000000000000000000000',
  channelId: 'ch12',
  filename: 'clip.mxf',
  sizeBytes: PART * 2 + 100,
  partSizeBytes: PART,
  partCount: 3,
  received: [],
  state: 'open',
  expiresAt: '2026-09-22T00:00:00.000Z',
  ...over,
});

const job = (state: IngestJob['state']): IngestJob => ({
  id: '01J00000000000000000000000',
  channelId: 'ch12',
  state,
  version: 1,
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
  ...(state === 'quarantined' ? { reason: 'under the minimum' } : {}),
});

/** Let the service's awaited promises advance to the next request. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('UploadService', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('slices to the SERVER’s part size, sends every part as octet-stream, completes, and polls to the verdict', async () => {
    const { uploads, http, store } = setup();
    const done = uploads.start(file('clip.mxf', PART * 2 + 100));
    await tick();

    const start = http.expectOne({ method: 'POST', url: '/gateway/api/v1/uploads' });
    expect(start.request.body).toEqual({
      filename: 'clip.mxf',
      sizeBytes: PART * 2 + 100,
      contentType: 'application/octet-stream',
    });
    start.flush(upload(), { status: 201, statusText: 'Created' });
    await tick();

    for (const [n, size] of [
      [1, PART],
      [2, PART],
      [3, 100],
    ] as const) {
      const put = http.expectOne({
        method: 'PUT',
        url: `/gateway/api/v1/uploads/01H00000000000000000000000/parts/${n}`,
      });
      expect(put.request.headers.get('content-type')).toBe('application/octet-stream');
      expect((put.request.body as Blob).size).toBe(size);
      put.flush(null, { status: 204, statusText: 'No Content' });
      await tick();
      expect(store.transfers()[0]?.sentBytes).toBe(Math.min(PART * n, PART * 2 + 100));
    }

    expect(store.transfers()[0]?.state).toBe('completing');
    http
      .expectOne({
        method: 'POST',
        url: '/gateway/api/v1/uploads/01H00000000000000000000000/complete',
      })
      .flush(job('detected'), { status: 202, statusText: 'Accepted' });
    await tick();
    expect(store.transfers()[0]?.state).toBe('validating');

    // The verdict follows on the server; poll until it is there.
    await tick();
    http
      .expectOne({ method: 'GET', url: '/gateway/api/v1/ingest/01J00000000000000000000000' })
      .flush(job('validating'));
    await tick();
    await tick();
    http
      .expectOne({ method: 'GET', url: '/gateway/api/v1/ingest/01J00000000000000000000000' })
      .flush(job('quarantined'));

    const transfer = await done;
    expect(transfer.state).toBe('done');
    expect(transfer.job?.state).toBe('quarantined');
    expect(transfer.job?.reason).toBe('under the minimum');
    http.verify();
  });

  it('retries a part that fails on the way, gives up after three, and Retry resumes: only what the server does not hold goes', async () => {
    const { uploads, http, store } = setup();
    const done = uploads.start(file('clip.mxf', PART * 2 + 100));
    await tick();
    http.expectOne({ method: 'POST', url: '/gateway/api/v1/uploads' }).flush(upload());
    await tick();
    http
      .expectOne({
        method: 'PUT',
        url: '/gateway/api/v1/uploads/01H00000000000000000000000/parts/1',
      })
      .flush(null, { status: 204, statusText: 'No Content' });
    await tick();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      http
        .expectOne({
          method: 'PUT',
          url: '/gateway/api/v1/uploads/01H00000000000000000000000/parts/2',
        })
        .flush('upstream "rim" unreachable', { status: 502, statusText: 'Bad Gateway' });
      await tick();
      await tick();
    }
    const failed = await done;
    expect(failed.state).toBe('failed');
    expect(failed.error).toMatch(/502/);
    // Kept, so a retry resumes.
    expect(failed.uploadId).toBe('01H00000000000000000000000');

    // Retry asks what is held — part 1, and part 3 that another attempt got through — and sends
    // the rest. No new upload is started.
    const again = uploads.retry(failed.id);
    await tick();
    http.expectNone({ method: 'POST', url: '/gateway/api/v1/uploads' });
    http
      .expectOne({ method: 'GET', url: '/gateway/api/v1/uploads/01H00000000000000000000000' })
      .flush(upload({ received: [1, 3] }));
    await tick();
    expect(store.transfers()[0]?.sentBytes).toBe(PART + 100);
    http
      .expectOne({
        method: 'PUT',
        url: '/gateway/api/v1/uploads/01H00000000000000000000000/parts/2',
      })
      .flush(null, { status: 204, statusText: 'No Content' });
    await tick();
    http.expectNone({
      method: 'PUT',
      url: '/gateway/api/v1/uploads/01H00000000000000000000000/parts/1',
    });
    http.expectNone({
      method: 'PUT',
      url: '/gateway/api/v1/uploads/01H00000000000000000000000/parts/3',
    });
    http
      .expectOne({
        method: 'POST',
        url: '/gateway/api/v1/uploads/01H00000000000000000000000/complete',
      })
      .flush(job('accepted'), { status: 202, statusText: 'Accepted' });
    expect((await again).state).toBe('done');
    expect(store.transfers()).toHaveLength(1);
    http.verify();
  });

  it('a part the server REFUSES is not sent again: the same bytes would be refused the same way', async () => {
    const { uploads, http } = setup();
    const done = uploads.start(file('a.mxf', PART));
    await tick();
    http
      .expectOne({ method: 'POST', url: '/gateway/api/v1/uploads' })
      .flush(upload({ sizeBytes: PART, partCount: 1 }));
    await tick();
    http
      .expectOne({
        method: 'PUT',
        url: '/gateway/api/v1/uploads/01H00000000000000000000000/parts/1',
      })
      .flush(
        { code: 'VALIDATION', message: 'part 1 must be 1024 bytes, got 1023' },
        { status: 422, statusText: 'Unprocessable Entity' },
      );
    await tick();
    const failed = await done;
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('part 1 must be 1024 bytes, got 1023');
    http.verify();
  });

  it('a resumed upload that was swept starts over rather than failing forever', async () => {
    const { uploads, http, store } = setup();
    const first = uploads.start(file('a.mxf', PART));
    await tick();
    http
      .expectOne({ method: 'POST', url: '/gateway/api/v1/uploads' })
      .flush(upload({ sizeBytes: PART, partCount: 1 }));
    await tick();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      http
        .expectOne({
          method: 'PUT',
          url: '/gateway/api/v1/uploads/01H00000000000000000000000/parts/1',
        })
        .flush(null, { status: 0, statusText: 'network' });
      await tick();
      await tick();
    }
    expect((await first).state).toBe('failed');

    const again = uploads.retry(store.transfers()[0]!.id);
    await tick();
    http
      .expectOne({ method: 'GET', url: '/gateway/api/v1/uploads/01H00000000000000000000000' })
      .flush({ code: 'NOT_FOUND', message: 'upload' }, { status: 404, statusText: 'Not Found' });
    await tick();
    http
      .expectOne({ method: 'POST', url: '/gateway/api/v1/uploads' })
      .flush(upload({ uploadId: '01H00000000000000000000001', sizeBytes: PART, partCount: 1 }));
    await tick();
    http
      .expectOne({
        method: 'PUT',
        url: '/gateway/api/v1/uploads/01H00000000000000000000001/parts/1',
      })
      .flush(null, { status: 204, statusText: 'No Content' });
    await tick();
    http
      .expectOne({
        method: 'POST',
        url: '/gateway/api/v1/uploads/01H00000000000000000000001/complete',
      })
      .flush(job('accepted'), { status: 202, statusText: 'Accepted' });
    expect((await again).state).toBe('done');
    http.verify();
  });

  it('cancel stops the transfer where it is and abandons the upload', async () => {
    const { uploads, http, store } = setup();
    const done = uploads.start(file('clip.mxf', PART * 2 + 100));
    await tick();
    http.expectOne({ method: 'POST', url: '/gateway/api/v1/uploads' }).flush(upload());
    await tick();
    const put = http.expectOne({
      method: 'PUT',
      url: '/gateway/api/v1/uploads/01H00000000000000000000000/parts/1',
    });

    const cancelling = uploads.cancel(store.transfers()[0]!.id);
    await tick();
    expect(put.cancelled).toBe(true);
    http
      .expectOne({ method: 'DELETE', url: '/gateway/api/v1/uploads/01H00000000000000000000000' })
      .flush(null, { status: 204, statusText: 'No Content' });
    await cancelling;
    const transfer = await done;
    expect(transfer.state).toBe('cancelled');
    http.expectNone({
      method: 'PUT',
      url: '/gateway/api/v1/uploads/01H00000000000000000000000/parts/2',
    });
    http.verify();
  });
});
