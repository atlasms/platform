import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  AppError,
  NotFound,
  ValidationError,
  toProblem,
  runWithContext,
  correlationId,
  HealthRegistry,
  generateTestKey,
  verifyJwt,
  requirePermission,
  Unauthorized,
  Forbidden,
  createLogger,
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TITLES,
  problemOf,
  type ErrorCode,
} from '../src/index.ts';

test('loadConfig coerces types and applies defaults', () => {
  const cfg = loadConfig(
    {
      port: { env: 'PORT', type: 'number', default: 3000 },
      debug: { env: 'DEBUG', type: 'boolean', default: false },
      name: { env: 'NAME', type: 'string', required: true },
    },
    { PORT: '8080', DEBUG: 'true', NAME: 'mam' },
  );
  assert.deepEqual(cfg, { port: 8080, debug: true, name: 'mam' });
});

test('loadConfig fails fast with all problems', () => {
  try {
    loadConfig(
      {
        port: { env: 'PORT', type: 'number', required: true },
        tier: { env: 'TIER', type: 'string', enum: ['a', 'b'] },
      },
      { PORT: 'nope', TIER: 'z' },
    );
    assert.fail('should throw');
  } catch (e) {
    assert.ok(e instanceof ValidationError);
    assert.equal((e as ValidationError).status, 422);
    assert.deepEqual((e as ValidationError).details, [
      'PORT must be a number',
      'TIER must be one of a, b',
    ]);
  }
});

test('error taxonomy maps to ONE problem document — RFC 9457, with the platform keys kept', () => {
  const p = toProblem(new NotFound('asset X'), '01ARZ3NDEKTSV4RRFFQ69G5FAV');
  // `details` is OMITTED, not set to undefined, when there is none (exactOptionalPropertyTypes).
  assert.deepEqual(p, {
    // RFC 9457 members — derived, so they cannot disagree with the platform's
    type: 'https://atlas.example/problems/not_found',
    title: 'Not found',
    status: 404,
    detail: 'asset X',
    instance: 'urn:atlas:correlation:01ARZ3NDEKTSV4RRFFQ69G5FAV',
    // the platform's, which every client and every test keys on
    code: 'NOT_FOUND',
    message: 'asset X',
    correlationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  });
  assert.equal('details' in p, false);

  // Unknown -> 500, opaque, and still a complete document.
  const internal = toProblem(new Error('raw'));
  assert.equal(internal.code, 'INTERNAL');
  assert.equal(internal.title, 'Internal error');
  assert.equal(internal.detail, 'Internal error', 'the raw message never reaches the caller');
  assert.equal('instance' in internal, false, 'no correlation id, no instance');
  assert.ok(new NotFound() instanceof AppError);

  // Every code has a title and a type; a new code without them is a compile error, but pin it.
  for (const code of Object.keys(PROBLEM_TITLES) as ErrorCode[]) {
    const doc = problemOf({ code, status: 400, message: 'm' });
    assert.equal(doc.type, `https://atlas.example/problems/${code.toLowerCase()}`);
    assert.ok(doc.title.length > 0);
  }
  assert.equal(PROBLEM_CONTENT_TYPE, 'application/problem+json');
});

test('correlation context threads through async work', async () => {
  const seen: (string | undefined)[] = [];
  await runWithContext({ correlationId: 'abc' }, async () => {
    seen.push(correlationId());
    await new Promise((r) => setTimeout(r, 1));
    seen.push(correlationId()); // still 'abc' after an await
  });
  assert.equal(correlationId(), undefined); // cleared outside
  assert.deepEqual(seen, ['abc', 'abc']);
});

test('readiness: non-critical failure stays ready, critical failure does not', async () => {
  const h = new HealthRegistry()
    .register('db', () => true, { critical: true })
    .register('cache', () => false, { critical: false });
  assert.equal((await h.readiness()).status, 'ready');
  h.register('broker', () => false, { critical: true });
  assert.equal((await h.readiness()).status, 'not_ready');
  assert.equal(h.liveness().status, 'ok');
});

test('JWT verifies against a JWKS and enforces permissions', async () => {
  const key = await generateTestKey();
  const token = await key.sign(
    { sub: 'user-42', permissions: ['asset:approve'], channelId: 'ch12' },
    { issuer: 'iam', audience: 'atlas' },
  );
  const claims = await verifyJwt(token, key.jwks, { issuer: 'iam', audience: 'atlas' });
  assert.equal(claims.sub, 'user-42');
  requirePermission(claims, 'asset:approve'); // no throw
  assert.throws(() => requirePermission(claims, 'asset:delete'), Forbidden);
});

test('JWT rejects expired / wrong-key / tampered tokens', async () => {
  const key = await generateTestKey();
  const other = await generateTestKey('other-kid');

  const expired = await key.sign({ sub: 'u' }, { expiresIn: '-1s' });
  await assert.rejects(verifyJwt(expired, key.jwks), Unauthorized);

  const wrongKey = await other.sign({ sub: 'u' });
  await assert.rejects(verifyJwt(wrongKey, key.jwks), Unauthorized); // kid not in this JWKS

  const good = await key.sign({ sub: 'u' });
  await assert.rejects(verifyJwt(good + 'x', key.jwks), Unauthorized); // tampered signature
});

test('logger emits structured JSON with the ambient correlationId', () => {
  const lines: string[] = [];
  const log = createLogger('mam', (l) => lines.push(l));
  runWithContext({ correlationId: 'corr-9' }, () => log.info('created', { assetId: 'A1' }));
  const rec = JSON.parse(lines[0] ?? '{}');
  assert.equal(rec.service, 'mam');
  assert.equal(rec.msg, 'created');
  assert.equal(rec.correlationId, 'corr-9');
  assert.equal(rec.assetId, 'A1');
});
