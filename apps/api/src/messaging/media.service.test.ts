import { text } from 'node:stream/consumers';
import type { PrismaClient } from '@repo/db';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InMemoryMediaStore } from '../media-store/index.js';
import {
  type MessagingMediaError,
  MessagingMediaService,
} from './media.service.js';

const CREDENTIALS = {
  accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  authToken: 'not-a-real-twilio-token',
};

describe('MessagingMediaService', () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(''));
  const preparedMediaStore = new Map<string, Record<string, unknown>>();
  const messageMediaStore = new Map<string, Record<string, unknown>>();
  const log = { warn: vi.fn() };

  let mediaStore: InMemoryMediaStore;
  let service: MessagingMediaService;

  beforeEach(() => {
    fetchMock.mockImplementation(async () => new Response('bytes'));
    preparedMediaStore.clear();
    messageMediaStore.clear();
    mediaStore = new InMemoryMediaStore();

    service = new MessagingMediaService({
      db: buildDbMock(preparedMediaStore, messageMediaStore),
      mediaStore,
      publicUrl: 'https://api.example.com',
      credentials: CREDENTIALS,
      log,
      fetch: fetchMock,
    });
  });

  test('should create, upload, complete, and serve a prepared media slot', async () => {
    const slot = await service.requestUploadSlot('user-1', {
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 128000,
    });
    const uploadToken = new URL(slot.uploadUrl).searchParams.get('token');

    expect(slot.uploadUrl).toBe(
      `https://api.example.com/api/user/messages/media/uploads/${slot.preparedMedia.id}?token=${uploadToken}`,
    );
    expect(slot.preparedMedia.publicUrl).toBe(
      `https://api.example.com/media/messaging/prepared/${slot.preparedMedia.id}`,
    );

    await service.uploadPreparedMedia({
      preparedMediaId: slot.preparedMedia.id,
      token: uploadToken ?? '',
      body: Buffer.from('png-bytes'),
      contentType: 'image/png',
    });

    const completed = await service.completeUpload(
      'user-1',
      slot.preparedMedia.id,
    );

    expect(completed.id).toBe(slot.preparedMedia.id);
    expect(completed.sizeBytes).toBe(9);
    expect(mediaStore.keys()).toEqual([
      `messaging/prepared/${slot.preparedMedia.id}`,
    ]);

    const served = await service.openPreparedMedia(slot.preparedMedia.id);
    expect(served.mimeType).toBe('image/png');
    expect(served.sizeBytes).toBe(9);
    expect(await text(served.content)).toBe('png-bytes');
  });

  test('should reject uploads with the wrong token or content type', async () => {
    const slot = await service.requestUploadSlot('user-1', {
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 128000,
    });
    const uploadToken = new URL(slot.uploadUrl).searchParams.get('token');

    await expect(
      service.uploadPreparedMedia({
        preparedMediaId: slot.preparedMedia.id,
        token: 'wrong-token',
        body: Buffer.from('png-bytes'),
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({
      name: 'MessagingMediaError',
      code: 'not_found',
    } satisfies Partial<MessagingMediaError>);

    await expect(
      service.uploadPreparedMedia({
        preparedMediaId: slot.preparedMedia.id,
        token: uploadToken ?? '',
        body: Buffer.from('png-bytes'),
        contentType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({
      code: 'content_type_mismatch',
    } satisfies Partial<MessagingMediaError>);
  });

  test('should report a missing upload as a typed error when completing', async () => {
    const slot = await service.requestUploadSlot('user-1', {
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 128000,
    });

    await expect(
      service.completeUpload('user-1', slot.preparedMedia.id),
    ).rejects.toMatchObject({
      code: 'not_uploaded',
    } satisfies Partial<MessagingMediaError>);
  });

  test('should report unknown or missing media as not found', async () => {
    await expect(service.openPreparedMedia('missing')).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<MessagingMediaError>);
    await expect(service.openMessageMedia('missing')).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<MessagingMediaError>);

    messageMediaStore.set('media-orphan', {
      id: 'media-orphan',
      mimeType: 'image/png',
    });
    await expect(
      service.openMessageMedia('media-orphan'),
    ).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<MessagingMediaError>);
  });

  test('should promote prepared media into a message attachment', async () => {
    const slot = await service.requestUploadSlot('user-1', {
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 128000,
    });
    const uploadToken = new URL(slot.uploadUrl).searchParams.get('token');

    await service.uploadPreparedMedia({
      preparedMediaId: slot.preparedMedia.id,
      token: uploadToken ?? '',
      body: Buffer.from('png-bytes'),
      contentType: 'image/png',
    });
    await service.completeUpload('user-1', slot.preparedMedia.id);

    const media = await service.promotePreparedMediaToMessage({
      messageId: 'message-1',
      preparedMediaId: slot.preparedMedia.id,
    });

    expect(media.storageUrl).toBe(
      `https://api.example.com/media/messaging/messages/${media.id}`,
    );
    expect(mediaStore.keys()).toContain(`messaging/messages/${media.id}`);

    const served = await service.openMessageMedia(media.id);
    expect(await text(served.content)).toBe('png-bytes');
    await expect(
      service.getPreparedMediaForSend('user-1', slot.preparedMedia.id),
    ).rejects.toMatchObject({
      code: 'not_found',
    } satisfies Partial<MessagingMediaError>);
  });

  test('should write nothing to the database when the attachment copy fails', async () => {
    const slot = await service.requestUploadSlot('user-1', {
      fileName: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 128000,
    });
    const uploadToken = new URL(slot.uploadUrl).searchParams.get('token');

    await service.uploadPreparedMedia({
      preparedMediaId: slot.preparedMedia.id,
      token: uploadToken ?? '',
      body: Buffer.from('png-bytes'),
      contentType: 'image/png',
    });
    await service.completeUpload('user-1', slot.preparedMedia.id);
    vi.spyOn(mediaStore, 'put').mockRejectedValueOnce(
      new Error('bucket unavailable'),
    );

    await expect(
      service.promotePreparedMediaToMessage({
        messageId: 'message-1',
        preparedMediaId: slot.preparedMedia.id,
      }),
    ).rejects.toThrow('bucket unavailable');

    expect(messageMediaStore.size).toBe(0);
    expect(
      preparedMediaStore.get(slot.preparedMedia.id)?.consumedAt,
    ).toBeNull();
  });

  test('should store inbound media under the attachment id', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response('jpeg-bytes', {
          headers: { 'content-type': 'image/jpeg' },
        }),
    );

    await service.ingestInboundMedia('message-1', [
      {
        url: 'https://provider.example.com/media/1',
        mimeType: 'image/jpeg',
        fileName: 'photo.jpg',
      },
    ]);

    const mediaRecord = [...messageMediaStore.values()][0];
    expect(mediaRecord).toEqual(
      expect.objectContaining({ mimeType: 'image/jpeg', sizeBytes: 10 }),
    );
    expect(mediaStore.keys()).toEqual([
      `messaging/messages/${mediaRecord?.id}`,
    ]);

    const served = await service.openMessageMedia(mediaRecord?.id as string);
    expect(served.mimeType).toBe('image/jpeg');
    expect(await text(served.content)).toBe('jpeg-bytes');
  });

  test('should persist inbound media metadata even when download fails', async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response('nope', { status: 500 }),
    );

    await service.ingestInboundMedia('message-1', [
      {
        url: 'https://provider.example.com/media/1',
        mimeType: 'image/png',
        fileName: 'photo.png',
      },
    ]);

    const mediaRecord = [...messageMediaStore.values()][0];
    expect(mediaRecord).toEqual(
      expect.objectContaining({
        messageId: 'message-1',
        originalUrl: 'https://provider.example.com/media/1',
        mimeType: 'image/png',
        sizeBytes: null,
      }),
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(mediaStore.keys()).toEqual([]);
  });

  test('should send account credentials only to the Twilio API host', async () => {
    await service.ingestInboundMedia('message-1', [
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME1',
        mimeType: 'image/png',
        fileName: null,
      },
      {
        url: 'https://media.api.twilio.com/ME2',
        mimeType: 'image/png',
        fileName: null,
      },
      {
        url: 'https://provider.example.com/media/3',
        mimeType: 'image/png',
        fileName: null,
      },
      {
        url: 'https://api.twilio.com.example.com/media/4',
        mimeType: 'image/png',
        fileName: null,
      },
    ]);

    const expectedAuth = `Basic ${Buffer.from(
      `${CREDENTIALS.accountSid}:${CREDENTIALS.authToken}`,
    ).toString('base64')}`;
    const authHeaders = fetchMock.mock.calls.map(
      ([, init]) =>
        (init?.headers as Record<string, string> | undefined)?.authorization,
    );

    expect(authHeaders).toEqual([
      expectedAuth,
      expectedAuth,
      undefined,
      undefined,
    ]);
  });

  test('should download inbound media without credentials when none are configured', async () => {
    const unconfigured = new MessagingMediaService({
      db: buildDbMock(preparedMediaStore, messageMediaStore),
      mediaStore,
      publicUrl: 'https://api.example.com',
      credentials: null,
      log,
      fetch: fetchMock,
    });

    await unconfigured.ingestInboundMedia('message-1', [
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/MM1/Media/ME1',
        mimeType: 'image/png',
        fileName: null,
      },
    ]);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toEqual({});
  });
});

function buildDbMock(
  preparedMediaStore: Map<string, Record<string, unknown>>,
  messageMediaStore: Map<string, Record<string, unknown>>,
) {
  const db = {
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
      run(db),
    ),
    messagePreparedMedia: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const record = {
          ...data,
          uploadedAt: null,
          consumedAt: null,
          createdAt: new Date(),
        };
        preparedMediaStore.set(record.id as string, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return preparedMediaStore.get(where.id) ?? null;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          for (const record of preparedMediaStore.values()) {
            if (
              record.id === where.id &&
              record.uploadedByUserId === where.uploadedByUserId &&
              (!('consumedAt' in where) ||
                record.consumedAt === where.consumedAt)
            ) {
              return record;
            }
          }

          return null;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const current = preparedMediaStore.get(where.id);
          if (!current) {
            throw new Error('Prepared media not found');
          }
          const next = { ...current, ...data };
          preparedMediaStore.set(where.id, next);
          return next;
        },
      ),
    },
    messageMedia: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        messageMediaStore.set(data.id as string, data);
        return data;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return messageMediaStore.get(where.id) ?? null;
      }),
    },
  };

  return db as unknown as PrismaClient;
}
