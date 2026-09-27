// The recorder worker's side of the hand-off (EP-39; ADR-0008): a finished capture's file, sent to
// RIM through the SIGNED internal routes as the upload's own server-sized parts.
//
// Each request is signed over exactly the bytes sent. A part is read from disk at its offset —
// an hour at 50 Mb/s is 22 GB, and none of it is held in memory beyond one part. A failure throws;
// the worker keeps the file and tries again on its next pass.

import { open, stat } from 'node:fs/promises';
import { INTERNAL_SIGNATURE_HEADER, signInternal } from '@atlas/service-kit';
import type { Capture } from './capture.ts';

export interface HandOff {
  /** Send the file; returns the ingest job it became. */
  handOver(capture: Capture, file: string): Promise<{ jobId: string }>;
}

export interface HttpHandOffOptions {
  /** RIM, directly — `http://rim:3000`, never the gateway, which does not route `/internal/`. */
  origin: string;
  /** The signing key: the first of RIM's internal keys. */
  key: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** `rec_20260914T130000Z_p1.ts` — the file's grid slot and part; nothing a path could misread. */
export function handOffFilename(capture: Pick<Capture, 'fileStart' | 'part'>): string {
  const stamp = capture.fileStart.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `rec_${stamp}_p${capture.part}.ts`;
}

export function httpHandOff(options: HttpHandOffOptions): HandOff {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  const call = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: string | Buffer,
  ): Promise<Response> => {
    const payload = body ?? '';
    const headers: Record<string, string> = {
      [INTERNAL_SIGNATURE_HEADER]: signInternal(
        options.key,
        { method, path, body: payload },
        now(),
      ),
    };
    if (body !== undefined) {
      headers['content-type'] = Buffer.isBuffer(body)
        ? 'application/octet-stream'
        : 'application/json';
    }
    const res = await doFetch(new URL(path, options.origin), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    }
    return res;
  };

  return {
    async handOver(capture, file) {
      const { size } = await stat(file);
      const started = await call(
        'POST',
        `/internal/v1/captures/${capture.id}/upload`,
        JSON.stringify({ filename: handOffFilename(capture), sizeBytes: size }),
      );
      const upload = (await started.json()) as {
        uploadId: string;
        partSizeBytes: number;
        partCount: number;
      };
      const handle = await open(file, 'r');
      try {
        for (let n = 1; n <= upload.partCount; n += 1) {
          const offset = (n - 1) * upload.partSizeBytes;
          const length = Math.min(upload.partSizeBytes, size - offset);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          if (bytesRead !== length) throw new Error(`short read at part ${n} of ${file}`);
          await call('PUT', `/internal/v1/uploads/${upload.uploadId}/parts/${n}`, buffer);
        }
      } finally {
        await handle.close();
      }
      const done = await call('POST', `/internal/v1/uploads/${upload.uploadId}/complete`);
      const job = (await done.json()) as { id: string };
      return { jobId: job.id };
    },
  };
}
