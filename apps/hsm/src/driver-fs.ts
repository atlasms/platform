// The POSIX filesystem driver (ADR-0009 §1): a root directory — a SAN/NAS mount, or a
// ReadWriteMany volume on Kubernetes.
//
// A write lands in `<key>.part-<ulid>` beside its destination, is flushed to disk, then renamed
// into place: rename within one directory is atomic, so a reader sees the old file or the whole new
// one, and a crash leaves only a `.part-` file — never a truncated file under a real key. The
// directory is fsynced after the rename where the platform allows it (not on Windows).
//
// Containment: keys are checked (driver.ts), and the parent directory's REAL path must be inside the
// root's real path, so a symlink planted in the tree cannot carry a write out of it.

import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ulid } from '@atlas/contracts';
import { checkKey, Hashing, StorageMissing, type StorageDriver, type Written } from './driver.ts';

export function fsDriver(root: string): StorageDriver {
  const base = resolve(root);

  const pathOf = (key: string): string => {
    checkKey(key);
    return join(base, ...key.split('/'));
  };

  const inside = async (dir: string): Promise<void> => {
    const [real, rootReal] = await Promise.all([realpath(dir), realpath(base)]);
    if (real !== rootReal && !real.startsWith(rootReal + sep)) {
      throw new Error('storage path escapes the target root');
    }
  };

  return {
    kind: 'fs',

    async write(key: string, source: Readable): Promise<Written> {
      const target = pathOf(key);
      const dir = dirname(target);
      await mkdir(dir, { recursive: true });
      await inside(dir);
      const part = `${target}.part-${ulid()}`;
      const hashing = new Hashing();
      try {
        // `wx`: the part file is ours alone; `flush`: fsync before close, so a rename below never
        // publishes bytes still in the page cache.
        await pipeline(source, hashing, createWriteStream(part, { flags: 'wx', flush: true }));
        await rename(part, target);
      } catch (err) {
        await rm(part, { force: true });
        throw err;
      }
      await syncDir(dir);
      return { sizeBytes: hashing.bytes, sha256: hashing.digest() };
    },

    async read(key: string): Promise<Readable> {
      const path = pathOf(key);
      try {
        await inside(dirname(path));
        await access(path, constants.R_OK);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageMissing(key);
        throw err;
      }
      return createReadStream(path);
    },

    async stat(key: string) {
      try {
        const s = await stat(pathOf(key));
        return s.isFile() ? { sizeBytes: s.size } : undefined;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },

    async remove(key: string): Promise<void> {
      await rm(pathOf(key), { force: true });
    },

    async probe(): Promise<void> {
      await access(base, constants.W_OK);
    },
  };
}

/** Make a rename durable. Windows cannot open a directory for this; there it is a no-op. */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
