import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  PutObjectCommand,
  type S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { describe, expect, test, vi } from 'vitest';
import {
  createS3Client,
  type MediaStoreConfig,
  S3MediaStore,
} from './s3-media-store.js';

const config: MediaStoreConfig = {
  endpoint: 'http://storage.example.com:9000',
  region: 'auto',
  bucket: 'media',
  accessKeyId: 'not-a-real-access-key',
  secretAccessKey: 'not-a-real-secret-key',
  forcePathStyle: true,
  keyPrefix: null,
};

function stubbedClient(send: ReturnType<typeof vi.fn>) {
  return { send } as unknown as S3Client;
}

function noSuchKey() {
  return new NoSuchKey({
    message: 'The specified key does not exist.',
    $metadata: {},
  });
}

/** What the SDK raises for a 404 without a body, as a HEAD answers. */
function notFound() {
  return new NotFound({
    message: 'UnknownError',
    $metadata: { httpStatusCode: 404 },
  });
}

function accessDenied() {
  return new S3ServiceException({
    name: 'AccessDenied',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
    message: 'Access Denied',
  });
}

describe('createS3Client', () => {
  test('passes endpoint, region, credentials and path style from config', async () => {
    const client = createS3Client(config);

    expect(client.config.forcePathStyle).toBe(true);
    expect(await client.config.region()).toBe('auto');
    expect(await client.config.endpoint?.()).toMatchObject({
      protocol: 'http:',
      hostname: 'storage.example.com',
      port: 9000,
    });
    expect(await client.config.credentials()).toMatchObject({
      accessKeyId: 'not-a-real-access-key',
      secretAccessKey: 'not-a-real-secret-key',
    });
    expect(await client.config.requestChecksumCalculation()).toBe(
      'WHEN_REQUIRED',
    );
    expect(await client.config.responseChecksumValidation()).toBe(
      'WHEN_REQUIRED',
    );
  });

  test('leaves the endpoint to the SDK for AWS S3 itself', async () => {
    const client = createS3Client({
      ...config,
      endpoint: null,
      region: 'us-east-1',
      forcePathStyle: false,
    });

    expect(client.config.forcePathStyle).toBe(false);
    expect(client.config.endpoint).toBeUndefined();
    expect(await client.config.region()).toBe('us-east-1');
  });
});

describe('S3MediaStore', () => {
  test('puts a buffer with its type and length', async () => {
    const send = vi.fn(async () => ({}));
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await store.put({
      key: 'messaging/one',
      body: Buffer.from('bytes'),
      contentType: 'image/png',
    });

    const [command] = send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toEqual({
      Bucket: 'media',
      Key: 'messaging/one',
      Body: Buffer.from('bytes'),
      ContentType: 'image/png',
      ContentLength: 5,
    });
  });

  test('puts a stream with the announced length', async () => {
    const send = vi.fn(async () => ({}));
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });
    const body = Readable.from(Buffer.from('streamed'));

    await store.put({
      key: 'messaging/two',
      body,
      contentType: 'audio/wav',
      contentLength: 8,
    });

    const [command] = send.mock.calls[0] ?? [];
    expect((command as PutObjectCommand).input).toMatchObject({
      Body: body,
      ContentType: 'audio/wav',
      ContentLength: 8,
    });
  });

  test('namespaces every key under the configured prefix', async () => {
    const send = vi.fn(async () => ({}));
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'shared',
      keyPrefix: '/iziphone/',
    });

    await store.delete('messaging/one');

    const [command] = send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect((command as DeleteObjectCommand).input).toEqual({
      Bucket: 'shared',
      Key: 'iziphone/messaging/one',
    });
  });

  test('refuses keys that would escape the layout', async () => {
    const send = vi.fn(async () => ({}));
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await expect(store.get('')).rejects.toThrow(/Invalid object key/);
    await expect(store.get('/absolute')).rejects.toThrow(/Invalid object key/);
    expect(send).not.toHaveBeenCalled();
  });

  test('gets an object as a stream with its type and length', async () => {
    const send = vi.fn(async () => ({
      Body: Readable.from(Buffer.from('png-bytes')),
      ContentType: 'image/png',
      ContentLength: 9,
    }));
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    const stored = await store.get('messaging/one');

    expect(stored).toMatchObject({
      contentType: 'image/png',
      contentLength: 9,
    });
    expect(await text(stored?.body ?? Readable.from([]))).toBe('png-bytes');

    const [command] = send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect((command as GetObjectCommand).input).toEqual({
      Bucket: 'media',
      Key: 'messaging/one',
    });
  });

  test('resolves null when the key does not exist', async () => {
    const send = vi.fn(async () => {
      throw noSuchKey();
    });
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await expect(store.get('messaging/missing')).resolves.toBeNull();
  });

  test('resolves null on a bare 404 from get as well', async () => {
    const send = vi.fn(async () => {
      throw notFound();
    });
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await expect(store.get('messaging/missing')).resolves.toBeNull();
  });

  test('heads an object for its type and length without a body', async () => {
    const send = vi.fn(async () => ({
      ContentType: 'image/png',
      ContentLength: 3,
    }));
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: 'iziphone',
    });

    await expect(store.head('messaging/one')).resolves.toEqual({
      contentType: 'image/png',
      contentLength: 3,
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(HeadObjectCommand);
    expect((command as HeadObjectCommand).input).toEqual({
      Bucket: 'media',
      Key: 'iziphone/messaging/one',
    });
  });

  test('heads a missing key as null and propagates other errors', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(notFound())
      .mockRejectedValueOnce(accessDenied());
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await expect(store.head('messaging/missing')).resolves.toBeNull();
    await expect(store.head('messaging/one')).rejects.toMatchObject({
      name: 'AccessDenied',
    });
  });

  test('rejects a head response without a length instead of guessing', async () => {
    const send = vi.fn(async () => ({ ContentType: 'image/png' }));
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await expect(store.head('messaging/one')).rejects.toThrow(
      /no Content-Length/,
    );
  });

  test('propagates every other error from get', async () => {
    const send = vi.fn(async () => {
      throw accessDenied();
    });
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await expect(store.get('messaging/one')).rejects.toMatchObject({
      name: 'AccessDenied',
    });
  });

  test('rejects a response without a length instead of guessing', async () => {
    const body = Readable.from(Buffer.from('x'));
    const send = vi.fn(async () => ({ Body: body, ContentType: 'image/png' }));
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await expect(store.get('messaging/one')).rejects.toThrow(
      /no Content-Length/,
    );
    expect(body.destroyed).toBe(true);
  });

  test('is ready when the bucket answers HeadBucket', async () => {
    const send = vi.fn(async () => ({}));
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await expect(store.assertReady()).resolves.toBeUndefined();

    const [command] = send.mock.calls[0] ?? [];
    expect(command).toBeInstanceOf(HeadBucketCommand);
    expect((command as HeadBucketCommand).input).toEqual({ Bucket: 'media' });
  });

  test('is not ready when HeadBucket fails, and says why', async () => {
    const send = vi.fn(async () => {
      throw accessDenied();
    });
    const store = new S3MediaStore(stubbedClient(send), {
      bucket: 'media',
      keyPrefix: null,
    });

    await expect(store.assertReady()).rejects.toMatchObject({
      name: 'AccessDenied',
    });
  });
});
