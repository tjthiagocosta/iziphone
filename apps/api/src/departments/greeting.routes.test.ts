import type { PrismaClient } from '@repo/db';
import { ROUTING_CACHE } from '@repo/events';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { InMemoryMediaStore } from '../media-store/index.js';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../test/route-test-helpers.js';
import { adminDepartmentRoutes } from './admin.routes.js';
import { departmentGreetingRoutes } from './greeting.routes.js';

const DEPARTMENT_LINE = '+15555550101';
const MP3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(40)]);
const WAV = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WAVE', 'latin1'),
  Buffer.alloc(40),
]);
const AIFF = Buffer.concat([
  Buffer.from('FORM', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('AIFF', 'latin1'),
  Buffer.alloc(40),
]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(40),
]);

interface SettingsRow {
  voicemailGreetingId: string | null;
  voicemailGreetingKey: string | null;
}

/**
 * One department with a settings row that follows every update, a media
 * store nothing leaves, and a Redis pipeline that records what the routing
 * cache writes. The admin app mutates; the public app serves.
 */
function buildApps(initial: SettingsRow) {
  const row: SettingsRow = { ...initial };
  const auditCreate = vi.fn(async () => ({}));
  const pipelineSet = vi.fn();
  const pipeline = {
    set: pipelineSet,
    del: vi.fn(),
    exec: vi.fn(async () => []),
  };
  pipelineSet.mockReturnValue(pipeline);
  const db = {
    departmentSettings: {
      /*
       * Serves both `findSettings` (filters by departmentId) and `open`
       * (filters by voicemailGreetingId).
       */
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { voicemailGreetingId?: string; departmentId?: string };
        }) =>
          where.voicemailGreetingId !== undefined &&
          where.voicemailGreetingId !== row.voicemailGreetingId
            ? null
            : { ...row },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { voicemailGreetingId: string | null };
          data: SettingsRow;
        }) => {
          if (row.voicemailGreetingId !== where.voicemailGreetingId) {
            return { count: 0 };
          }

          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    department: {
      findFirst: vi.fn(async () => ({
        id: 'dept-1',
        name: 'Support',
        deletedAt: null,
        users: [{ userId: 'user-1', order: 0 }],
        settings: {
          timezone: 'America/Sao_Paulo',
          is24Hours: false,
          openHoursRoutingType: 'FIXED_ORDER',
          ringDuration: 20,
          closedHoursRoutingType: 'VOICEMAIL',
          closedHoursExternalNumber: null,
          ...row,
        },
        businessHours: [],
        holidays: [],
        phoneNumbers: [{ phoneNumber: DEPARTMENT_LINE, voiceEnabled: true }],
      })),
    },
    auditLog: { create: auditCreate },
    $transaction: async (run: (tx: unknown) => unknown) => run(db),
  };
  const mediaStore = new InMemoryMediaStore();
  const shared = {
    db: db as unknown as Partial<PrismaClient>,
    redis: { pipeline: () => pipeline } as unknown as Partial<Redis>,
    mediaStore,
  };

  return {
    row,
    auditCreate,
    pipelineSet,
    mediaStore,
    admin: () =>
      createApiRouteApp(withAuthenticatedUser(adminDepartmentRoutes), shared),
    public: () =>
      createApiRouteApp(departmentGreetingRoutes, { ...shared, user: null }),
  };
}

/** What the routing cache last wrote for the department's line. */
function cachedGreetingUrl(pipelineSet: ReturnType<typeof vi.fn>) {
  const writes = pipelineSet.mock.calls.filter(
    (args) => args[0] === `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DEPARTMENT_LINE}`,
  );
  const last = writes.at(-1);
  expect(last, 'expected the routing cache to be refreshed').toBeDefined();
  return JSON.parse(last?.[1] as string).settings.voicemailGreetingUrl;
}

describe('department greeting routes', () => {
  let apps: ReturnType<typeof buildApps>;
  let admin: FastifyInstance;
  let served: FastifyInstance;

  beforeEach(async () => {
    apps = buildApps({ voicemailGreetingId: null, voicemailGreetingKey: null });
    admin = await apps.admin();
    served = await apps.public();
  });

  afterEach(async () => {
    await admin.close();
    await served.close();
  });

  test('uploads a greeting, serves it by its URL, and puts the URL in the routing cache', async () => {
    const upload = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'audio/mpeg' },
      payload: MP3,
    });

    expect(upload.statusCode).toBe(200);
    const { voicemailGreetingUrl } = upload.json();
    expect(voicemailGreetingUrl).toMatch(
      /^https:\/\/api\.example\.com\/media\/greetings\/[0-9a-f-]{36}$/,
    );
    expect(cachedGreetingUrl(apps.pipelineSet)).toBe(voicemailGreetingUrl);
    expect(apps.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'department.greeting_uploaded',
        entityType: 'Department',
        entityId: 'dept-1',
        userId: 'user-1',
      }),
    });

    const playback = await served.inject({
      method: 'GET',
      url: new URL(voicemailGreetingUrl).pathname,
    });

    expect(playback.statusCode).toBe(200);
    expect(playback.headers['content-type']).toBe('audio/mpeg');
    expect(playback.headers['content-length']).toBe(String(MP3.byteLength));
    expect(playback.headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(playback.headers['x-content-type-options']).toBe('nosniff');
    expect(playback.rawPayload).toEqual(MP3);
  });

  test('a replacement gets a new URL and the previous one stops answering', async () => {
    const first = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'audio/mpeg' },
      payload: MP3,
    });
    const firstUrl: string = first.json().voicemailGreetingUrl;

    const second = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'audio/wav' },
      payload: WAV,
    });
    const secondUrl: string = second.json().voicemailGreetingUrl;

    expect(second.statusCode).toBe(200);
    expect(secondUrl).not.toBe(firstUrl);
    expect(cachedGreetingUrl(apps.pipelineSet)).toBe(secondUrl);
    expect(apps.mediaStore.keys()).toEqual([apps.row.voicemailGreetingKey]);
    expect(
      (await served.inject({ method: 'GET', url: new URL(firstUrl).pathname }))
        .statusCode,
    ).toBe(404);
    const playback = await served.inject({
      method: 'GET',
      url: new URL(secondUrl).pathname,
    });
    expect(playback.headers['content-type']).toBe('audio/wav');
    expect(playback.rawPayload).toEqual(WAV);
  });

  test('removing the greeting clears the cache entry and the file', async () => {
    const upload = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'audio/mpeg' },
      payload: MP3,
    });
    const url: string = upload.json().voicemailGreetingUrl;

    const removal = await admin.inject({
      method: 'DELETE',
      url: '/dept-1/greeting',
    });

    expect(removal.statusCode).toBe(204);
    expect(cachedGreetingUrl(apps.pipelineSet)).toBeNull();
    expect(apps.mediaStore.keys()).toEqual([]);
    expect(apps.auditCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: 'department.greeting_removed',
        entityId: 'dept-1',
        userId: 'user-1',
      }),
    });
    expect(
      (await served.inject({ method: 'GET', url: new URL(url).pathname }))
        .statusCode,
    ).toBe(404);
  });

  test('removing a greeting a department does not have is a quiet 204', async () => {
    const removal = await admin.inject({
      method: 'DELETE',
      url: '/dept-1/greeting',
    });

    expect(removal.statusCode).toBe(204);
    expect(apps.auditCreate).not.toHaveBeenCalled();
  });

  test('refuses an image that calls itself audio, storing and auditing nothing', async () => {
    const response = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'audio/mpeg' },
      payload: PNG,
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({
      error: 'Unsupported Media Type',
      message: 'The file is not a MP3 recording',
    });
    expect(apps.mediaStore.keys()).toEqual([]);
    expect(apps.auditCreate).not.toHaveBeenCalled();
    expect(apps.pipelineSet).not.toHaveBeenCalled();
  });

  test('takes a file the browser could not name a type for, deciding from its bytes', async () => {
    const upload = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'application/octet-stream' },
      payload: AIFF,
    });

    expect(upload.statusCode).toBe(200);
    expect(apps.mediaStore.keys()).toEqual([
      expect.stringMatching(/^greetings\/dept-1\/[0-9a-f-]{36}\.aiff$/),
    ]);

    const playback = await served.inject({
      method: 'GET',
      url: new URL(upload.json().voicemailGreetingUrl).pathname,
    });

    expect(playback.headers['content-type']).toBe('audio/aiff');
  });

  test('refuses an unnamed file whose bytes are no accepted format', async () => {
    const response = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'application/octet-stream' },
      payload: PNG,
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().message).toBe(
      'The file is not an MP3, WAV or AIFF recording',
    );
    expect(apps.mediaStore.keys()).toEqual([]);
  });

  test('refuses a type <Play> does not support before reading the body', async () => {
    const response = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'audio/ogg' },
      payload: MP3,
    });

    expect(response.statusCode).toBe(415);
    expect(apps.mediaStore.keys()).toEqual([]);
  });

  test('refuses a JSON body as an unsupported type', async () => {
    const response = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      payload: { voicemailGreetingUrl: 'https://example.com/greeting.mp3' },
    });

    expect(response.statusCode).toBe(415);
    expect(response.json().message).toBe('Upload an MP3, WAV or AIFF file');
  });

  test('refuses an empty upload', async () => {
    const response = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'audio/mpeg' },
      payload: Buffer.alloc(0),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe('The file is empty');
  });

  test('takes a greeting larger than the default body limit, up to the cap', async () => {
    const twoMebibytes = Buffer.concat([MP3, Buffer.alloc(2 * 1024 * 1024)]);

    const response = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'audio/mpeg' },
      payload: twoMebibytes,
    });

    expect(response.statusCode).toBe(200);
    expect(apps.mediaStore.keys()).toHaveLength(1);
  });

  test('refuses a file over the cap with a 413 before it is read in full', async () => {
    const response = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(5 * 1024 * 1024 + 1),
      },
      payload: MP3,
    });

    expect(response.statusCode).toBe(413);
    expect(apps.mediaStore.keys()).toEqual([]);
  });

  test('answers 404 for an unknown greeting id', async () => {
    const response = await served.inject({
      method: 'GET',
      url: '/media/greetings/no-such-greeting',
    });

    expect(response.statusCode).toBe(404);
  });

  test('HEAD answers with the same headers as GET and no body, without opening the file', async () => {
    const upload = await admin.inject({
      method: 'PUT',
      url: '/dept-1/greeting',
      headers: { 'content-type': 'audio/mpeg' },
      payload: MP3,
    });
    const url: string = upload.json().voicemailGreetingUrl;
    const getSpy = vi.spyOn(apps.mediaStore, 'get');

    const head = await served.inject({
      method: 'HEAD',
      url: new URL(url).pathname,
    });

    expect(getSpy).not.toHaveBeenCalled();

    const get = await served.inject({
      method: 'GET',
      url: new URL(url).pathname,
    });

    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toBe(get.headers['content-type']);
    expect(head.headers['content-length']).toBe(get.headers['content-length']);
    expect(head.headers['cache-control']).toBe(get.headers['cache-control']);
    expect(head.headers['x-content-type-options']).toBe(
      get.headers['x-content-type-options'],
    );
    expect(head.rawPayload).toEqual(Buffer.alloc(0));
  });

  test('HEAD answers 404 for an unknown greeting id', async () => {
    const response = await served.inject({
      method: 'HEAD',
      url: '/media/greetings/no-such-greeting',
    });

    expect(response.statusCode).toBe(404);
    expect(response.rawPayload).toEqual(Buffer.alloc(0));
  });
});

describe('department greeting HEAD route for a soft-deleted department', () => {
  test('answers 404, the same as GET, because the settings lookup joins on department.deletedAt', async () => {
    // Mirrors what Postgres would do: `findFirst`'s `department: { deletedAt:
    // null }` filter excludes the row once the department is soft-deleted,
    // so the greeting id no longer resolves to a key.
    const db = {
      departmentSettings: { findFirst: vi.fn(async () => null) },
    };
    const mediaStore = new InMemoryMediaStore();
    await mediaStore.put({
      key: 'greetings/dept-1/greeting-1.mp3',
      contentType: 'audio/mpeg',
      body: MP3,
    });
    const getSpy = vi.spyOn(mediaStore, 'get');
    const app = await createApiRouteApp(departmentGreetingRoutes, {
      db: db as unknown as Partial<PrismaClient>,
      mediaStore,
      user: null,
    });

    try {
      const head = await app.inject({
        method: 'HEAD',
        url: '/media/greetings/greeting-1',
      });
      const get = await app.inject({
        method: 'GET',
        url: '/media/greetings/greeting-1',
      });

      expect(head.statusCode).toBe(404);
      expect(get.statusCode).toBe(404);
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('department greeting routes for a missing department', () => {
  test('answer 404 on upload and removal without touching the store', async () => {
    const mediaStore = new InMemoryMediaStore();
    const app = await createApiRouteApp(
      withAuthenticatedUser(adminDepartmentRoutes),
      {
        db: {
          departmentSettings: { findFirst: vi.fn(async () => null) },
        } as unknown as Partial<PrismaClient>,
        mediaStore,
      },
    );

    try {
      const upload = await app.inject({
        method: 'PUT',
        url: '/dept-404/greeting',
        headers: { 'content-type': 'audio/mpeg' },
        payload: MP3,
      });
      const removal = await app.inject({
        method: 'DELETE',
        url: '/dept-404/greeting',
      });

      expect(upload.statusCode).toBe(404);
      expect(upload.json()).toEqual({
        error: 'Not Found',
        message: 'Department not found',
      });
      expect(removal.statusCode).toBe(404);
      expect(mediaStore.keys()).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
