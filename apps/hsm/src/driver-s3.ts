// The S3-compatible driver (ADR-0009 §1): MinIO on-prem, AWS, anything that speaks S3.
//
// A write is a multipart `Upload` fed from a stream that hashes as it passes, so a master of any
// size is never buffered whole and the checksum is of the bytes sent. `leavePartsOnError: false`
// aborts the multipart upload on failure: no partial object ever appears under the key (S3 publishes
// an object only when the upload completes). Credentials are handed in by the caller — HSM reads
// them from its own mounted Secret (targets.ts) — and never logged.

import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { checkKey, Hashing, StorageMissing, type StorageDriver, type Written } from './driver.ts';

export interface S3DriverOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  /** Prepended to every key — several targets can share a bucket. No leading or trailing `/`. */
  prefix?: string;
  /** Path-style addressing (`endpoint/bucket/key`) — MinIO and most on-prem stores need it. */
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Bytes per multipart part; S3's floor is 5 MiB. */
  partSizeBytes?: number;
}

const notFound = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
};

export function s3Driver(options: S3DriverOptions): StorageDriver & {
  /** For tests and first-run setup: create the bucket if it is not there. */
  ensureBucket(): Promise<void>;
} {
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle ?? false,
    ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
  });
  const Bucket = options.bucket;
  const objectKey = (key: string): string => {
    checkKey(key);
    return options.prefix ? `${options.prefix}/${key}` : key;
  };

  return {
    kind: 's3',

    async write(key: string, source: Readable): Promise<Written> {
      const Key = objectKey(key);
      const hashing = new Hashing();
      const body = new PassThrough();
      // The pipeline ends `body` when the source ends, and destroys it if the source fails — which
      // makes the upload reject, and abort.
      const feeding = pipeline(source, hashing, body);
      const upload = new Upload({
        client,
        params: { Bucket, Key, Body: body },
        partSize: Math.max(options.partSizeBytes ?? 8 * 1024 * 1024, 5 * 1024 * 1024),
        queueSize: 4,
        leavePartsOnError: false,
      });
      try {
        await Promise.all([feeding, upload.done()]);
      } catch (err) {
        await upload.abort().catch(() => undefined);
        body.destroy();
        throw err;
      }
      return { sizeBytes: hashing.bytes, sha256: hashing.digest() };
    },

    async read(key: string): Promise<Readable> {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket, Key: objectKey(key) }));
        if (!(out.Body instanceof Readable)) throw new Error('S3 returned no stream body');
        return out.Body;
      } catch (err) {
        if (notFound(err)) throw new StorageMissing(key);
        throw err;
      }
    },

    async stat(key: string) {
      try {
        const out = await client.send(new HeadObjectCommand({ Bucket, Key: objectKey(key) }));
        return { sizeBytes: out.ContentLength ?? 0 };
      } catch (err) {
        if (notFound(err)) return undefined;
        throw err;
      }
    },

    async remove(key: string): Promise<void> {
      // S3 answers a delete of a missing key with success: idempotent already.
      await client.send(new DeleteObjectCommand({ Bucket, Key: objectKey(key) }));
    },

    async probe(): Promise<void> {
      await client.send(new HeadBucketCommand({ Bucket }));
    },

    async ensureBucket(): Promise<void> {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket }));
      }
    },
  };
}
