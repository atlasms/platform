// The HSM client against a fake HSM over real HTTP: a placement is signed over the bytes' digest
// and the query carries the provenance; a read is hashed on the way in and refused when it does
// not match the digest HSM sent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyInternalDigest, verifyInternal } from '@atlas/service-kit';
import { hsmFileStore } from '../src/index.ts';

const KEY = 'k'.repeat(40);
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

async function fakeHsm(content: Buffer, advertised: string) {
  const seen: { url: string; bytes: Buffer; verified: boolean }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const bytes = Buffer.concat(chunks);
      const header = req.headers['x-atlas-internal'] as string;
      if (req.method === 'PUT') {
        const verified = verifyInternalDigest(
          [KEY],
          { method: 'PUT', path: req.url!, bodySha256: sha(bytes) },
          header,
        ).ok;
        seen.push({ url: req.url!, bytes, verified });
        res.writeHead(verified ? 201 : 401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            storage: { path: 'ch12/a/original/b1' },
            sizeBytes: bytes.length,
            checksum: { value: sha(bytes) },
          }),
        );
        return;
      }
      const ok = verifyInternal([KEY], { method: 'GET', path: req.url! }, header).ok;
      res.writeHead(ok ? 200 : 401, { 'x-atlas-sha256': advertised });
      res.end(ok ? content : undefined);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((r) => server.close(r)),
  };
}

test('a placement is streamed signed over its digest, with the provenance in the signed query', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hsm-client-'));
  const hsm = await fakeHsm(Buffer.alloc(0), '');
  try {
    const file = join(dir, 'original.mov');
    await writeFile(file, 'the master');
    const placed = await hsmFileStore({ origin: hsm.origin, key: KEY }).place(
      {
        channelId: 'ch12',
        assetId: '01ASSET000000000000000000A',
        kind: 'original',
        producedBy: 'ingest',
        jobId: '01JOB00000000000000000000A',
      },
      file,
      sha('the master'),
    );
    assert.equal(placed.path, 'ch12/a/original/b1');
    assert.equal(hsm.seen[0]!.verified, true);
    assert.equal(hsm.seen[0]!.bytes.toString(), 'the master');
    const query = new URL(hsm.seen[0]!.url, 'http://x').searchParams;
    assert.deepEqual(
      [query.get('producedBy'), query.get('channelId'), query.get('profile')],
      ['ingest', 'ch12', null],
    );
  } finally {
    await hsm.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a read is hashed on the way in: what matches HSM’s digest lands, what does not is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hsm-client-'));
  const good = await fakeHsm(Buffer.from('proxy bytes'), sha('proxy bytes'));
  const bad = await fakeHsm(Buffer.from('rotten bytes'), sha('proxy bytes'));
  try {
    const dest = join(dir, 'in', 'proxy');
    const got = await hsmFileStore({ origin: good.origin, key: KEY }).fetch(
      '01ASSET000000000000000000A',
      'proxy',
      undefined,
      dest,
    );
    assert.deepEqual(got, { sha256: sha('proxy bytes'), sizeBytes: 11 });
    assert.equal((await readFile(dest)).toString(), 'proxy bytes');
    await assert.rejects(
      hsmFileStore({ origin: bad.origin, key: KEY }).fetch(
        '01ASSET000000000000000000A',
        'proxy',
        undefined,
        join(dir, 'x'),
      ),
      /arrived as .* not HSM's/,
    );
  } finally {
    await good.close();
    await bad.close();
    await rm(dir, { recursive: true, force: true });
  }
});
