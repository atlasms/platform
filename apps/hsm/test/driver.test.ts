// The storage driver suite against the filesystem driver — everywhere, in a temporary directory.
// driver-s3.test.ts runs the SAME suite against S3-compatible storage (MinIO in CI).

import { mkdtemp, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import assert from 'node:assert/strict';
import { storageDriverConformance } from '../src/driver-conformance.ts';
import { fsDriver } from '../src/driver-fs.ts';

storageDriverConformance('fsDriver', {
  make: async () => {
    const root = await mkdtemp(join(tmpdir(), 'hsm-fs-'));
    return { driver: fsDriver(root), cleanup: () => rm(root, { recursive: true, force: true }) };
  },
});

test('[fsDriver] a symlink planted in the tree cannot carry a write out of the root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hsm-fs-'));
  const outside = await mkdtemp(join(tmpdir(), 'hsm-out-'));
  try {
    await mkdir(join(root, 'ch12'), { recursive: true });
    try {
      await symlink(outside, join(root, 'ch12', 'evil'), 'dir');
    } catch {
      t.skip('this platform does not let an unprivileged user create a symlink');
      return;
    }
    await assert.rejects(
      fsDriver(root).write('ch12/evil/file', Readable.from([Buffer.from('x')])),
      /escapes the target root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
