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

test('error taxonomy maps to a consistent problem', () => {
  const p = toProblem(new NotFound('asset X'), 'corr-1');
  // `details` is OMITTED, not set to undefined, when there is none (exactOptionalPropertyTypes).
  // Identical on the wire — JSON.stringify drops undefined — but a cleaner problem+JSON body.
  assert.deepEqual(p, {
    code: 'NOT_FOUND',
    status: 404,
    message: 'asset X',
    correlationId: 'corr-1',
  });
  assert.equal('details' in p, false);
  assert.equal(toProblem(new Error('raw')).code, 'INTERNAL'); // unknown -> 500
  assert.ok(new NotFound() instanceof AppError);
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
