// The production routing table, held to the contracts (EP-21.1).
//
// Every path a deployed service's OpenAPI contract declares must reach THAT service through the
// gateway. The table used to be written by hand in main.ts one service at a time, and it silently
// lacked `/api/v1/search`, `/api/v1/tags` and `/api/v1/field-schemas` while MAM served them and
// Studio called them — green everywhere until the MVP acceptance journey searched through a real
// deployment. The contracts are the authority on who owns a path, so this reads them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { matchRoute, productionRoutes } from '../src/index.ts';

const OPENAPI = fileURLToPath(new URL('../../../docs/architecture/openapi/', import.meta.url));

/** The deployed services, by contract file. A new service routed by the gateway joins here. */
const DEPLOYED: Readonly<Record<string, string>> = {
  'iam.yaml': 'iam',
  'mam.yaml': 'mam',
  'logging-analytics.yaml': 'logging',
  'scheduling.yaml': 'scheduling',
  'rim.yaml': 'rim',
  'mts.yaml': 'mts',
  'hsm.yaml': 'hsm',
};

/** Paths a contract declares that are deliberately NOT routed, each with its reason. */
const NOT_ROUTED: Readonly<Record<string, string>> = {
  // The gateway answers this itself: the aggregate of every owner's reference data (EP-08.5).
  '/api/v1/reference': 'served by the gateway',
  // The gateway fetches IAM's keys directly to verify tokens; no client verifies one.
  '/.well-known/jwks.json': 'read by the gateway from IAM, not proxied',
};

const table = productionRoutes({
  iam: 'http://iam:3000',
  mam: 'http://mam:3000',
  logging: 'http://logging:3000',
  scheduling: 'http://scheduling:3000',
  rim: 'http://rim:3000',
  mts: 'http://mts:3000',
  hsm: 'http://hsm:3000',
  uploadBodyLimit: 8 * 1024 * 1024,
});

interface Contract {
  servers?: Array<{ url: string }>;
  paths?: Record<string, { servers?: Array<{ url: string }> } | undefined>;
}

/** The path as the gateway serves it: the server's path (document- or path-level) + the path. */
function servedPaths(file: string): string[] {
  const doc = parse(readFileSync(`${OPENAPI}${file}`, 'utf8')) as Contract;
  const base = (servers?: Array<{ url: string }>) =>
    new URL((servers?.[0]?.url ?? '').replace('{host}', 'h')).pathname.replace(/\/$/, '');
  return Object.entries(doc.paths ?? {}).map(([path, item]) => {
    const server = item?.servers ?? doc.servers;
    // A template parameter becomes a concrete segment, as a request carries one.
    return `${base(server)}${path.replace(/\{[^}]+\}/g, '01J0000000000000000000000X')}`;
  });
}

test('every path a deployed service’s contract declares reaches that service through the gateway', () => {
  const wrong: string[] = [];
  let checked = 0;
  for (const [file, owner] of Object.entries(DEPLOYED)) {
    for (const path of servedPaths(file)) {
      // Signed service-to-service calls (ADR-0008) — the gateway must NOT reach these; below.
      if (path.includes('/internal/')) continue;
      if (Object.keys(NOT_ROUTED).some((p) => path === p)) continue;
      checked++;
      const route = matchRoute(table, path);
      if (route?.service !== owner) {
        wrong.push(`${path} (${file}) → ${route?.service ?? 'no route'}, expected ${owner}`);
      }
    }
  }
  assert.ok(checked > 60, `the contracts were read: ${checked} paths`);
  assert.deepEqual(wrong, [], 'add the prefix to productionRoutes in src/routing.ts');
});

test('no /internal/ path is reachable, and only /auth is public', () => {
  for (const file of Object.keys(DEPLOYED)) {
    for (const path of servedPaths(file).filter((p) => p.includes('/internal/'))) {
      assert.equal(matchRoute(table, path), undefined, `${path} must not be routed`);
    }
  }
  assert.deepEqual(
    table.filter((r) => r.public).map((r) => r.prefix),
    ['/auth'],
  );
});

test('every exception names a path a contract still declares', () => {
  const declared = new Set(Object.keys(DEPLOYED).flatMap(servedPaths));
  for (const path of Object.keys(NOT_ROUTED)) {
    assert.ok(declared.has(path), `${path} is no longer in any contract — drop the exception`);
  }
});
