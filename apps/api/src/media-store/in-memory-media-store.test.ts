import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { describe, expect, test } from 'vitest';
import { InMemoryMediaStore } from './in-memory-media-store.js';

describe('InMemoryMediaStore', () => {
  test('round-trips a buffer with its type and length', async () => {
    const store = new InMemoryMediaStore();

    await store.put({
      key: 'messaging/one',
      body: Buffer.from('png-bytes'),
      contentType: 'image/png',
    });

    const stored = await store.get('messaging/one');

    expect(stored).toMatchObject({
      contentType: 'image/png',
      contentLength: 9,
    });
    expect(await text(stored?.body ?? Readable.from([]))).toBe('png-bytes');
    expect(store.keys()).toEqual(['messaging/one']);
  });

  test('accepts a stream body whose length matches', async () => {
    const store = new InMemoryMediaStore();

    await store.put({
      key: 'recordings/one',
      body: Readable.from([Buffer.from('ab'), Buffer.from('cd')]),
      contentType: 'audio/wav',
      contentLength: 4,
    });

    const stored = await store.get('recordings/one');

    expect(stored?.contentLength).toBe(4);
    expect(await text(stored?.body ?? Readable.from([]))).toBe('abcd');
  });

  test('rejects a stream body whose length does not match', async () => {
    const store = new InMemoryMediaStore();

    await expect(
      store.put({
        key: 'recordings/one',
        body: Readable.from(Buffer.from('abcd')),
        contentType: 'audio/wav',
        contentLength: 3,
      }),
    ).rejects.toThrow(/4 bytes but 3 were announced/);
    expect(store.keys()).toEqual([]);
  });

  test('heads an object for its type and length', async () => {
    const store = new InMemoryMediaStore();
    await store.put({
      key: 'messaging/one',
      body: Buffer.from('hello'),
      contentType: 'text/plain',
    });

    await expect(store.head('messaging/one')).resolves.toEqual({
      contentType: 'text/plain',
      contentLength: 5,
    });
  });

  test('resolves null for a missing key and tolerates deleting one', async () => {
    const store = new InMemoryMediaStore();

    await expect(store.get('missing')).resolves.toBeNull();
    await expect(store.head('missing')).resolves.toBeNull();
    await expect(store.delete('missing')).resolves.toBeUndefined();
  });

  test('forgets a deleted object', async () => {
    const store = new InMemoryMediaStore();
    await store.put({
      key: 'messaging/one',
      body: Buffer.from('x'),
      contentType: 'text/plain',
    });

    await store.delete('messaging/one');

    await expect(store.get('messaging/one')).resolves.toBeNull();
    expect(store.keys()).toEqual([]);
  });

  test('is always ready', async () => {
    await expect(
      new InMemoryMediaStore().assertReady(),
    ).resolves.toBeUndefined();
  });
});
