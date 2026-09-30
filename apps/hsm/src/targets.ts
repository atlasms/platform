// Storage targets (EP-14.2; ADR-0009 §2) — where bytes can live, as data. Credentials are NOT data.
//
// A target is a Tier-1 registry row: its tier, its kind (`fs` or `s3`) and the non-secret settings.
// An S3 target names a `credentialRef` — a directory in HSM's credentials Secret, mounted only into
// the HSM pod — and HSM reads `<ref>/accessKeyId` and `<ref>/secretAccessKey` from there when it
// builds the driver. No credential is ever in the database, a request, a response, an event or a log.
//
// An `fs` target's root must lie under the deployment's storage base (`ATLAS_HSM_FS_BASE`): a
// storage administrator chooses among the volumes mounted into HSM, never an arbitrary path in its
// container. A target is disabled, never deleted — ledger rows name it.

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { ValidationError } from '@atlas/service-kit';
import type { StorageDriver } from './driver.ts';
import { fsDriver } from './driver-fs.ts';
import { s3Driver } from './driver-s3.ts';
import { TIERS, type Tier } from './file.ts';

export interface StorageTarget {
  id: string;
  /** Absent: platform-wide (an unscoped `storage:admin` writes it). */
  channelId?: string;
  name: string;
  tier: Tier;
  kind: 'fs' | 's3';
  /** fs: an absolute root under the deployment's storage base. */
  root?: string;
  /** s3: the non-secret settings. */
  s3?: {
    endpoint?: string;
    region: string;
    bucket: string;
    prefix?: string;
    forcePathStyle?: boolean;
  };
  /** s3: the NAME of the credentials directory in HSM's Secret. Never the credential. */
  credentialRef?: string;
  /** Receives new placements of its tier, for its scope. At most one per (scope, tier). */
  isDefault: boolean;
  enabled: boolean;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type StorageTargetInput = Pick<
  StorageTarget,
  'name' | 'tier' | 'kind' | 'root' | 's3' | 'credentialRef' | 'isDefault' | 'enabled'
>;

const REF = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The wire body to an input, with every reason at once (`; `-joined, each starting with its field). */
export function parseTargetInput(body: unknown, fsBase: string): StorageTargetInput {
  if (!isRecord(body)) throw new ValidationError('body must be an object');
  const errors: string[] = [];
  const allowed = new Set([
    'name',
    'tier',
    'kind',
    'root',
    's3',
    'credentialRef',
    'isDefault',
    'enabled',
  ]);
  for (const k of Object.keys(body))
    if (!allowed.has(k)) errors.push(`${k} is not a storage target field`);

  const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
  if (name === '' || name.length > 100) errors.push('name is required, at most 100 characters');
  const tier = body['tier'];
  if (typeof tier !== 'string' || !(TIERS as readonly string[]).includes(tier)) {
    errors.push(`tier must be one of ${TIERS.join(', ')}`);
  }
  const kind = body['kind'];
  if (kind !== 'fs' && kind !== 's3') errors.push('kind must be fs or s3');
  const isDefault = body['isDefault'] ?? false;
  const enabled = body['enabled'] ?? true;
  if (typeof isDefault !== 'boolean') errors.push('isDefault must be a boolean');
  if (typeof enabled !== 'boolean') errors.push('enabled must be a boolean');

  let root: string | undefined;
  let s3: StorageTarget['s3'] | undefined;
  let credentialRef: string | undefined;
  if (kind === 'fs') {
    if (body['s3'] !== undefined || body['credentialRef'] !== undefined) {
      errors.push('s3 settings and credentialRef belong to an s3 target');
    }
    if (typeof body['root'] !== 'string' || !isAbsolute(body['root'])) {
      errors.push('root is required for an fs target, an absolute path');
    } else {
      root = resolve(body['root']);
      const rel = relative(resolve(fsBase), root);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        errors.push(`root must lie under the storage base mounted into HSM (${fsBase})`);
      }
    }
  } else if (kind === 's3') {
    if (body['root'] !== undefined) errors.push('root belongs to an fs target');
    const s = body['s3'];
    if (!isRecord(s)) errors.push('s3 is required for an s3 target');
    else {
      const bucket = s['bucket'];
      const region = s['region'] ?? 'us-east-1';
      if (typeof bucket !== 'string' || !BUCKET.test(bucket))
        errors.push('s3.bucket must be a valid bucket name');
      if (typeof region !== 'string' || region === '') errors.push('s3.region must be a string');
      const endpoint = s['endpoint'];
      if (endpoint !== undefined) {
        try {
          const u = new URL(String(endpoint));
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
          if (u.username || u.password)
            errors.push('s3.endpoint must not carry a credential — use credentialRef');
        } catch {
          errors.push('s3.endpoint must be an http(s) URL');
        }
      }
      const prefix = s['prefix'];
      if (prefix !== undefined && (typeof prefix !== 'string' || !PREFIX.test(prefix))) {
        errors.push('s3.prefix must be plain /-separated segments');
      }
      if (typeof bucket === 'string' && typeof region === 'string') {
        s3 = {
          region,
          bucket,
          ...(endpoint !== undefined ? { endpoint: String(endpoint) } : {}),
          ...(typeof prefix === 'string' ? { prefix } : {}),
          ...(s['forcePathStyle'] === true ? { forcePathStyle: true } : {}),
        };
      }
    }
    const ref = body['credentialRef'];
    if (ref !== undefined) {
      if (typeof ref !== 'string' || !REF.test(ref)) {
        errors.push('credentialRef must name a credentials entry: lowercase letters, digits and -');
      } else credentialRef = ref;
    }
  }
  if (errors.length > 0) throw new ValidationError(errors.join('; '));
  return {
    name,
    tier: tier as Tier,
    kind: kind as 'fs' | 's3',
    ...(root !== undefined ? { root } : {}),
    ...(s3 !== undefined ? { s3 } : {}),
    ...(credentialRef !== undefined ? { credentialRef } : {}),
    isDefault: isDefault as boolean,
    enabled: enabled as boolean,
  };
}

/** Builds a target's driver. Injected, so the suites run on temporary directories. */
export type DriverFactory = (target: StorageTarget) => Promise<StorageDriver>;

/**
 * The production factory: fs from the root; s3 with credentials read from the mounted Secret. A
 * driver is cached per target VERSION, so an edited target is rebuilt on its next use.
 */
export function driverFactory(options: { credentialsDir: string }): DriverFactory {
  const cache = new Map<string, StorageDriver>();
  return async (target) => {
    const cacheKey = `${target.id}@${target.version}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;
    let driver: StorageDriver;
    if (target.kind === 'fs') {
      driver = fsDriver(target.root!);
    } else {
      const s3 = target.s3!;
      let credentials: { accessKeyId: string; secretAccessKey: string } | undefined;
      if (target.credentialRef !== undefined) {
        const dir = join(options.credentialsDir, target.credentialRef);
        const [accessKeyId, secretAccessKey] = await Promise.all([
          readFile(join(dir, 'accessKeyId'), 'utf8'),
          readFile(join(dir, 'secretAccessKey'), 'utf8'),
        ]).catch(() => {
          // Which file, never what is in it.
          throw new Error(
            `storage target ${target.id}: credentials "${target.credentialRef}" are not mounted`,
          );
        });
        credentials = { accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim() };
      }
      driver = s3Driver({ ...s3, ...(credentials !== undefined ? { credentials } : {}) });
    }
    for (const k of cache.keys()) if (k.startsWith(`${target.id}@`)) cache.delete(k);
    cache.set(cacheKey, driver);
    return driver;
  };
}
