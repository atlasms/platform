// The storage port (ADR-0009 §1): what HSM needs from a place bytes can live, and nothing more.
//
// Two implementations — a POSIX filesystem (driver-fs.ts) and S3-compatible object storage
// (driver-s3.ts) — held to ONE conformance suite (driver-conformance.ts). Every write hashes the
// bytes AS IT WRITES THEM: the checksum HSM records is of what reached storage, never a claim.
// A write is all or nothing — a reader never sees half a file under a key.

import { createHash, type Hash } from 'node:crypto';
import { Transform, type Readable, type TransformCallback } from 'node:stream';

export interface Written {
  sizeBytes: number;
  /** Hex SHA-256 of the bytes written. */
  sha256: string;
}

export interface StorageDriver {
  readonly kind: 'fs' | 's3';
  /** Stream `source` to `key`, replacing anything there; resolves once the bytes are durable. */
  write(key: string, source: Readable): Promise<Written>;
  /** The bytes at `key`; `StorageMissing` if there are none. */
  read(key: string): Promise<Readable>;
  stat(key: string): Promise<{ sizeBytes: number } | undefined>;
  /** Idempotent: removing what is not there is not an error. */
  remove(key: string): Promise<void>;
  /** Readiness: can this target be written right now? Throws with the reason if not. */
  probe(): Promise<void>;
}

/** The bytes a key names are not in storage. */
export class StorageMissing extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`no bytes at ${key}`);
    this.name = 'StorageMissing';
    this.key = key;
  }
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * A storage key HSM will use: relative, `/`-separated, each segment plain — no `..`, no `.`, no
 * empty segment, nothing a filesystem or an object store would read as anything but a name. Keys
 * are HSM's own (`<channel>/<asset>/<kind>/<fileId>`), so a refusal here is a bug upstream.
 */
export function checkKey(key: string): void {
  if (key.length === 0 || key.length > 1024) throw new Error(`invalid storage key: length`);
  for (const segment of key.split('/')) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new Error(`invalid storage key: ${JSON.stringify(key)}`);
    }
  }
}

/** A pass-through that hashes and counts what flows through it. */
export class Hashing extends Transform {
  private readonly hash: Hash = createHash('sha256');
  bytes = 0;

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    done(null, chunk);
  }

  /** Call once, after the stream has ended. */
  digest(): string {
    return this.hash.digest('hex');
  }
}
