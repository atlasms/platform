// The storage driver suite against S3-compatible storage — a real S3-compatible server in CI (SeaweedFS).
//
// Skipped on a laptop without ATLAS_S3_URL; a missing one IN CI is a failure, because a silent
// skip there is indistinguishable from a passing suite (the Postgres/JetStream rule, AGENTS.md).

import test from 'node:test';
import { ulid } from '@atlas/contracts';
import { storageDriverConformance } from '../src/driver-conformance.ts';
import { s3Driver } from '../src/driver-s3.ts';

const url = process.env['ATLAS_S3_URL'];
const accessKeyId = process.env['ATLAS_S3_ACCESS_KEY'] ?? 'atlas-dev';
const secretAccessKey = process.env['ATLAS_S3_SECRET_KEY'] ?? 'atlas-dev-secret';

if (!url) {
  if (process.env['CI']) {
    test('ATLAS_S3_URL is set in CI', () => {
      throw new Error('ATLAS_S3_URL is not set: the S3 driver suite would silently not run');
    });
  } else {
    test(
      'S3 driver suite',
      { skip: 'ATLAS_S3_URL not set (the s3 service in infra/docker-compose.dev.yml)' },
      () => {},
    );
  }
} else {
  const bucket = 'atlas-hsm-conformance';
  storageDriverConformance('s3Driver', {
    make: async () => {
      const driver = s3Driver({
        endpoint: url,
        region: 'us-east-1',
        bucket,
        prefix: `run-${ulid().toLowerCase()}`,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
        partSizeBytes: 5 * 1024 * 1024,
      });
      await driver.ensureBucket();
      return { driver };
    },
  });
}
