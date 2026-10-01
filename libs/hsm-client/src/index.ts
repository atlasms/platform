// A producer's hands on HSM (EP-14.7; ADR-0009): the only way a file reaches storage, and the way
// an input comes from it — for MTS (renditions, inputs) and RIM (an accepted original, EP-15.5).
// A producer's local copy is scratch: what it writes there is pushed to HSM and removed; what it
// reads from HSM lands there and is removed after use.
//
// A placement is signed over the file's SHA-256 (`signInternalDigest`) — the digest the producer
// computes anyway — and streamed; HSM hashes what it writes and the signature only verifies if the
// two agree. A read is signed, streamed to scratch, hashed on the way in and compared with the
// digest HSM sends: a corrupt transfer is caught here, not in FFmpeg.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { INTERNAL_SIGNATURE_HEADER, signInternal, signInternalDigest } from '@atlas/service-kit';

export interface Placed {
  /** The key on HSM's target — what the rendition's `path` becomes. */
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface Fetched {
  sha256: string;
  sizeBytes: number;
}

export interface PlacementMeta {
  channelId: string;
  assetId: string;
  kind: string;
  variant?: string;
  /** What made the file (file.schema.json `provenance.producedBy`). Default `transcode`. */
  producedBy?: 'ingest' | 'transcode' | 'editor' | 'import';
  jobId: string;
  /** The MTS profile, for a rendition; absent for an original. */
  profile?: string;
  technical?: Record<string, unknown>;
}

/** HSM, as a producer needs it. A port: `hsmFileStore` over HTTP, `memoryFileStore` for the suites. */
export interface FileStore {
  place(meta: PlacementMeta, localPath: string, sha256: string): Promise<Placed>;
  /** An asset's live file of `kind`, written to `destPath`. */
  fetch(
    assetId: string,
    kind: string,
    variant: string | undefined,
    destPath: string,
  ): Promise<Fetched>;
}

export function hsmFileStore(options: {
  origin: string;
  /** The first of HSM's internal keys: the producer signs with it. */
  key: string;
  fetchImpl?: typeof fetch;
}): FileStore {
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async place(meta, localPath, sha256) {
      const query = new URLSearchParams({
        channelId: meta.channelId,
        producedBy: meta.producedBy ?? 'transcode',
        jobId: meta.jobId,
        ...(meta.profile !== undefined ? { profile: meta.profile } : {}),
        ...(meta.variant !== undefined ? { variant: meta.variant } : {}),
        ...(meta.technical !== undefined ? { technical: JSON.stringify(meta.technical) } : {}),
      });
      const path = `/internal/v1/assets/${encodeURIComponent(meta.assetId)}/files/${encodeURIComponent(meta.kind)}?${query}`;
      const res = await doFetch(new URL(path, options.origin), {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          [INTERNAL_SIGNATURE_HEADER]: signInternalDigest(options.key, {
            method: 'PUT',
            path,
            bodySha256: sha256,
          }),
        },
        body: Readable.toWeb(createReadStream(localPath)) as unknown as RequestInit['body'],
        duplex: 'half',
      } as RequestInit);
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `HSM refused the ${meta.kind} of job ${meta.jobId}: ${res.status} ${await res.text()}`,
        );
      }
      const file = (await res.json()) as {
        storage: { path: string };
        sizeBytes: number;
        checksum: { value: string };
      };
      if (file.checksum.value !== sha256) {
        // Cannot happen if HSM verified the signature — which is why it is checked.
        throw new Error(`HSM recorded ${file.checksum.value} for bytes hashed here as ${sha256}`);
      }
      return { path: file.storage.path, sizeBytes: file.sizeBytes, sha256: file.checksum.value };
    },

    async fetch(assetId, kind, variant, destPath) {
      const path = `/internal/v1/assets/${encodeURIComponent(assetId)}/files/${encodeURIComponent(kind)}/content${
        variant !== undefined ? `?variant=${encodeURIComponent(variant)}` : ''
      }`;
      const res = await doFetch(new URL(path, options.origin), {
        method: 'GET',
        headers: {
          [INTERNAL_SIGNATURE_HEADER]: signInternal(options.key, { method: 'GET', path }),
        },
      });
      if (res.status !== 200 || !res.body) {
        throw new Error(
          `HSM has no readable ${kind} for asset ${assetId}: ${res.status} ${await res.text()}`,
        );
      }
      const expected = res.headers.get('x-atlas-sha256');
      await mkdir(dirname(destPath), { recursive: true });
      const hash = createHash('sha256');
      let sizeBytes = 0;
      await pipeline(
        Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
        new Transform({
          transform(chunk: Buffer, _enc, done) {
            hash.update(chunk);
            sizeBytes += chunk.length;
            done(null, chunk);
          },
        }),
        createWriteStream(destPath),
      );
      const sha256 = hash.digest('hex');
      if (expected !== null && expected !== sha256) {
        throw new Error(
          `the ${kind} of asset ${assetId} arrived as ${sha256}, not HSM's ${expected}`,
        );
      }
      return { sha256, sizeBytes };
    },
  };
}

/** For the suites: HSM as a map, with the same contract — the digest checked both ways. */
export function memoryFileStore(): FileStore & {
  files: Map<string, { bytes: Buffer; meta: PlacementMeta; path: string }>;
} {
  const files = new Map<string, { bytes: Buffer; meta: PlacementMeta; path: string }>();
  let n = 0;
  return {
    files,
    async place(meta, localPath, sha256) {
      const bytes = await readFile(localPath);
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== sha256) throw new Error('signature does not match the bytes');
      const path = `${meta.channelId}/${meta.assetId}/${meta.kind}/blob-${++n}`;
      files.set(`${meta.assetId}/${meta.kind}/${meta.variant ?? ''}`, { bytes, meta, path });
      return { path, sizeBytes: bytes.length, sha256 };
    },
    async fetch(assetId, kind, variant, destPath) {
      const f = files.get(`${assetId}/${kind}/${variant ?? ''}`);
      if (!f) throw new Error(`HSM has no readable ${kind} for asset ${assetId}: 404`);
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, f.bytes);
      return {
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
        sizeBytes: f.bytes.length,
      };
    },
  };
}
