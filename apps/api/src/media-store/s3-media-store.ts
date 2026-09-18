import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  type GetObjectCommandOutput,
  HeadBucketCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  MediaStore,
  PutObjectInput,
  StoredObject,
  StoredObjectInfo,
} from './media-store.js';

/**
 * Connection settings for any S3-compatible service. `endpoint` is null only
 * for AWS S3 itself, where the SDK derives it from the region.
 */
export interface MediaStoreConfig {
  endpoint: string | null;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Address the bucket as `<endpoint>/<bucket>` instead of `<bucket>.<endpoint>`. */
  forcePathStyle: boolean;
  /** Placed in front of every key, so one bucket can be shared with other data. */
  keyPrefix: string | null;
}

export function createS3Client(config: MediaStoreConfig): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    /*
     * Since 3.729.0 the SDK adds a CRC32 checksum to every upload, sent as an
     * aws-chunked trailer for stream bodies. S3-compatible services implement
     * that unevenly, so the checksum is only sent where an operation requires
     * one. See https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html
     */
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export class S3MediaStore implements MediaStore {
  private readonly bucket: string;
  private readonly keyPrefix: string;

  constructor(
    private readonly client: S3Client,
    options: { bucket: string; keyPrefix: string | null },
  ) {
    this.bucket = options.bucket;
    this.keyPrefix = normalizeKeyPrefix(options.keyPrefix);
  }

  async put(input: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(input.key),
        Body: input.body,
        ContentType: input.contentType,
        ContentLength:
          'contentLength' in input
            ? input.contentLength
            : input.body.byteLength,
      }),
    );
  }

  async get(key: string): Promise<StoredObject | null> {
    let response: GetObjectCommandOutput;

    try {
      response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }),
      );
    } catch (error) {
      if (isMissingObject(error)) {
        return null;
      }

      throw error;
    }

    const { Body: body, ContentLength: contentLength } = response;

    if (!(body instanceof Readable)) {
      throw new Error('Object storage returned a body that is not a stream');
    }

    if (contentLength === undefined) {
      body.destroy();
      throw new Error('Object storage returned no Content-Length');
    }

    return {
      body,
      contentType: response.ContentType ?? 'application/octet-stream',
      contentLength,
    };
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    let response: HeadObjectCommandOutput;

    try {
      response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.objectKey(key),
        }),
      );
    } catch (error) {
      if (isMissingObject(error)) {
        return null;
      }

      throw error;
    }

    if (response.ContentLength === undefined) {
      throw new Error('Object storage returned no Content-Length');
    }

    return {
      contentType: response.ContentType ?? 'application/octet-stream',
      contentLength: response.ContentLength,
    };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(key),
      }),
    );
  }

  async assertReady(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  private objectKey(key: string): string {
    if (key.length === 0 || key.startsWith('/')) {
      throw new Error(`Invalid object key: ${JSON.stringify(key)}`);
    }

    return `${this.keyPrefix}${key}`;
  }
}

/**
 * A GET answers a missing key with `NoSuchKey` in the body; a HEAD has no
 * body, so the SDK reports its 404 as `NotFound`. Both mean the same thing.
 */
function isMissingObject(error: unknown): boolean {
  return error instanceof NoSuchKey || error instanceof NotFound;
}

/** `media`, `media/` and `/media/` all namespace keys under `media/`. */
function normalizeKeyPrefix(prefix: string | null): string {
  const trimmed = prefix?.replace(/^\/+|\/+$/g, '') ?? '';
  return trimmed.length > 0 ? `${trimmed}/` : '';
}
