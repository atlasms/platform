#!/usr/bin/env node
// EP-26.1 spike — a tiny static server for the scrubbing harness.
//
//   node spikes/editor-scrubbing/serve.mjs            # → http://localhost:8126/harness.html
//
// It MUST honour HTTP Range requests: a <video> element seeks by asking for byte ranges, and a
// server that answers every request with the whole file (200, not 206) makes currentTime seeking
// either fail or re-download the file each time — which would poison the very latency we measure.
// So this is not just `http-server`; the 206 path is the point.

import { createReadStream, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8126);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = normalize(urlPath === '/' ? '/harness.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(HERE, rel);
  if (!file.startsWith(HERE) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }

  const { size } = statSync(file);
  const type = TYPES[extname(file)] ?? 'application/octet-stream';
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      if (start > end || end >= size) {
        res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
        'cache-control': 'no-store',
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': size,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Scrubbing harness: http://localhost:${PORT}/harness.html?gop=12`);
  console.log('Proxies come from spikes/editor-scrubbing/out (run make-proxies.mjs first).');
  console.log('Ctrl-C to stop.');
});
