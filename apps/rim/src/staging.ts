// RIM's staging area — where uploaded parts land and where a completed upload is assembled.
//
// This is NOT the platform's storage. rim.md §7: HSM places the bytes, RIM never writes storage
// directly (FR-HSM-5). Staging is the landing zone an upload needs before there is anything to
// hand over: one directory per upload, one file per part, and on completion one received file —
// assembled once, in part order, hashed on the way, so the checksum is of what was written.
//
// Every write is temp-file-then-rename. A part that is being re-sent (a resume) must not leave a
// half-written file with the right name behind; a rename is the one atomic operation a
// filesystem gives.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { checkFilename } from './upload.ts';

export interface Staging {
  /** Store part `n` of an upload. Returns its length and sha256. */
  writePart(
    uploadId: string,
    n: number,
    bytes: Uint8Array,
  ): Promise<{ sizeBytes: number; sha256: string }>;
  /** Which parts are on disk — the ground truth a resume answers from. */
  parts(uploadId: string): Promise<number[]>;
  /**
   * Concatenate parts 1..partCount into the received file, hashing as it goes. The parts are
   * removed afterwards; the received file stays until HSM has placed it (EP-14).
   */
  assemble(
    uploadId: string,
    partCount: number,
    filename: string,
  ): Promise<{ path: string; sizeBytes: number; sha256: string }>;
  /**
   * Copy a file a watcher found into a directory of its own (EP-15.2), hashing on the way — the
   * received file a watched job points at, exactly as an assembled upload is. A COPY, not a move:
   * the source may be on another filesystem (a network share), and `keep` leaves it where it is.
   */
  adopt(
    id: string,
    sourcePath: string,
    filename: string,
  ): Promise<{ path: string; sizeBytes: number; sha256: string }>;
  /** Remove everything the upload left — parts, the received file, the directory. */
  discard(uploadId: string): Promise<void>;
  /**
   * Remove a received file and the directory it sits in — a rejected job's bytes (EP-15.3). The
   * path must be inside the staging area: a row is data, and a path from a row is not trusted
   * to name what it says any more than a client's id is.
   */
  discardReceived(path: string): Promise<void>;
}

const PART = /^part-(\d+)$/;

export function fsStaging(root: string): Staging {
  const base = resolve(root);
  const dirOf = (uploadId: string): string => {
    // The id is a ULID the service minted, but the check costs nothing and a path built from a
    // client-supplied id must never be trusted by construction alone.
    const dir = resolve(base, uploadId);
    if (!dir.startsWith(base + sep))
      throw new Error(`upload id "${uploadId}" is not a path segment`);
    return dir;
  };

  return {
    async writePart(uploadId, n, bytes) {
      const dir = dirOf(uploadId);
      await mkdir(dir, { recursive: true });
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const tmp = join(dir, `part-${n}.tmp-${process.pid}-${Date.now()}`);
      await writeFile(tmp, bytes);
      await rename(tmp, join(dir, `part-${n}`));
      return { sizeBytes: bytes.byteLength, sha256 };
    },

    async parts(uploadId) {
      let names: string[];
      try {
        names = await readdir(dirOf(uploadId));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      return names
        .map((name) => PART.exec(name)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
        .sort((a, b) => a - b);
    },

    async assemble(uploadId, partCount, filename) {
      const dir = dirOf(uploadId);
      const name = checkFilename(filename);
      const target = join(dir, name);
      const tmp = join(dir, `.assembling-${process.pid}-${Date.now()}`);
      const hash = createHash('sha256');
      const out = createWriteStream(tmp, { flags: 'w' });
      try {
        for (let n = 1; n <= partCount; n += 1) {
          const part = createReadStream(join(dir, `part-${n}`));
          part.on('data', (chunk: Buffer | string) => hash.update(chunk));
          // `end: false` keeps the output open across parts; pipeline would close it after one.
          await pipeline(part, out, { end: false });
        }
      } finally {
        await new Promise<void>((done) => out.end(done));
      }
      await rename(tmp, target);
      for (let n = 1; n <= partCount; n += 1) await rm(join(dir, `part-${n}`), { force: true });
      const written = await stat(target);
      return { path: target, sizeBytes: written.size, sha256: hash.digest('hex') };
    },

    async adopt(id, sourcePath, filename) {
      const dir = dirOf(id);
      await mkdir(dir, { recursive: true });
      const target = join(dir, checkFilename(filename));
      const tmp = join(dir, `.adopting-${process.pid}-${Date.now()}`);
      const hash = createHash('sha256');
      const source = createReadStream(sourcePath);
      source.on('data', (chunk: Buffer | string) => hash.update(chunk));
      await pipeline(source, createWriteStream(tmp, { flags: 'w' }));
      await rename(tmp, target);
      const written = await stat(target);
      return { path: target, sizeBytes: written.size, sha256: hash.digest('hex') };
    },

    async discard(uploadId) {
      await rm(dirOf(uploadId), { recursive: true, force: true });
    },

    async discardReceived(path) {
      const dir = dirname(resolve(path));
      if (!dir.startsWith(base + sep) || dir === base) {
        throw new Error(`"${path}" is not a received file in the staging area`);
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
