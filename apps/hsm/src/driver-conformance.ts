// One behaviour suite every StorageDriver passes (ADR-0009 §1) — the filesystem everywhere, S3 on
// real MinIO in CI. What must hold on the storage a deployment actually uses:
//   - a write returns the size and SHA-256 of the bytes that reached storage, and reads back as them;
//   - a write replaces what was under its key, whole;
//   - a write that fails part-way leaves NOTHING under its key (not a prefix of the bytes);
//   - a large write streams (several parts / chunks) and still hashes right;
//   - a missing key is `StorageMissing` on read and `undefined` on stat; remove is idempotent;
//   - a key that is not plain is refused before anything touches storage.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ulid } from '@atlas/contracts';
import { StorageMissing, type StorageDriver } from './driver.ts';

export interface DriverHarness {
  make: () => Promise<{ driver: StorageDriver; cleanup?: () => Promise<void> }>;
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function bytesOf(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** A stream that yields `before` bytes and then fails, like a producer dying mid-upload. */
function failingAfter(before: Buffer): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(before);
      } else {
        this.destroy(new Error('the producer went away'));
      }
    },
  });
}

export function storageDriverConformance(name: string, harness: DriverHarness): void {
  async function withDriver(fn: (driver: StorageDriver) => Promise<void>): Promise<void> {
    const { driver, cleanup } = await harness.make();
    try {
      await fn(driver);
    } finally {
      await cleanup?.();
    }
  }
  const key = (): string => `ch12/${ulid()}/proxy/${ulid()}`;

  test(`[${name}] a write reports the size and SHA-256 of what reached storage, and reads back as it`, async () => {
    await withDriver(async (driver) => {
      const k = key();
      const body = Buffer.from('a rendition, byte for byte');
      const written = await driver.write(k, Readable.from([body]));
      assert.deepEqual(written, { sizeBytes: body.length, sha256: sha(body) });
      assert.deepEqual(await driver.stat(k), { sizeBytes: body.length });
      assert.deepEqual(await bytesOf(await driver.read(k)), body);
      await driver.probe();
    });
  });

  test(`[${name}] a write replaces what was under its key, whole`, async () => {
    await withDriver(async (driver) => {
      const k = key();
      await driver.write(k, Readable.from([Buffer.from('the first, longer version of the file')]));
      const second = Buffer.from('the second');
      await driver.write(k, Readable.from([second]));
      assert.deepEqual(await bytesOf(await driver.read(k)), second);
    });
  });

  test(`[${name}] a write that fails part-way leaves nothing under its key`, async () => {
    await withDriver(async (driver) => {
      const k = key();
      await assert.rejects(driver.write(k, failingAfter(Buffer.alloc(64 * 1024, 7))), /went away/);
      assert.equal(await driver.stat(k), undefined, 'no partial file or object');
      await assert.rejects(driver.read(k), StorageMissing);
    });
  });

  test(`[${name}] a large write streams in many chunks and still hashes right`, async () => {
    await withDriver(async (driver) => {
      const k = key();
      // 12 MiB in 64 KiB chunks: more than one S3 part at the 5 MiB floor the tests use.
      const chunk = Buffer.alloc(64 * 1024);
      const all: Buffer[] = [];
      for (let i = 0; i < 192; i++) {
        const c = Buffer.from(chunk.map((_, j) => (i * 31 + j) % 251));
        all.push(c);
      }
      const whole = Buffer.concat(all);
      const written = await driver.write(k, Readable.from(all));
      assert.equal(written.sizeBytes, whole.length);
      assert.equal(written.sha256, sha(whole));
      assert.equal(sha(await bytesOf(await driver.read(k))), sha(whole));
    });
  });

  test(`[${name}] missing is missing; remove is idempotent`, async () => {
    await withDriver(async (driver) => {
      const k = key();
      assert.equal(await driver.stat(k), undefined);
      await assert.rejects(driver.read(k), StorageMissing);
      await driver.remove(k);
      await driver.write(k, Readable.from([Buffer.from('x')]));
      await driver.remove(k);
      await driver.remove(k);
      assert.equal(await driver.stat(k), undefined);
    });
  });

  test(`[${name}] a key that is not plain is refused before storage is touched`, async () => {
    await withDriver(async (driver) => {
      for (const bad of ['../escape', 'ch12/../../etc/passwd', '/abs/path', 'a//b', 'a/./b', '']) {
        await assert.rejects(
          driver.write(bad, Readable.from([Buffer.from('x')])),
          /invalid storage key/,
        );
      }
    });
  });
}
