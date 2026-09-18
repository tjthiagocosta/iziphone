import { buffer } from 'node:stream/consumers';
import type { PrismaClient } from '@repo/db';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, test, vi } from 'vitest';
import type { AuditLogService } from '../admin/index.js';
import { InMemoryMediaStore } from '../media-store/index.js';
import type { RoutingCacheService } from '../routing/index.js';
import {
  DepartmentGreetingService,
  GreetingChangedError,
  GreetingRejectedError,
} from './greeting.service.js';

const PUBLIC_URL = 'https://api.example.com';
const MP3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.alloc(32)]);
const WAV = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WAVE', 'latin1'),
  Buffer.alloc(32),
]);

interface SettingsRow {
  voicemailGreetingId: string | null;
  voicemailGreetingKey: string | null;
}

/** A department whose settings row starts as given and follows every update. */
function buildService(
  settings: SettingsRow | null,
  options: {
    mediaStore?: InMemoryMediaStore;
    transactionFails?: boolean;
    departmentDeleted?: boolean;
  } = {},
) {
  const row = settings ? { ...settings } : null;
  const departmentDeleted = options.departmentDeleted ?? false;
  /* Writes only when the row still holds the id the caller read, like Postgres would. */
  const settingsUpdateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: { voicemailGreetingId: string | null };
      data: SettingsRow;
    }) => {
      if (!row || row.voicemailGreetingId !== where.voicemailGreetingId) {
        return { count: 0 };
      }

      Object.assign(row, data);
      return { count: 1 };
    },
  );
  /*
   * Serves both `findSettings` (filters by departmentId) and `open` (filters
   * by voicemailGreetingId); both exclude a soft-deleted department.
   */
  const settingsFindFirst = vi.fn(
    async ({
      where,
    }: {
      where: { voicemailGreetingId?: string; departmentId?: string };
    }) => {
      if (!row || departmentDeleted) {
        return null;
      }
      if (
        where.voicemailGreetingId !== undefined &&
        where.voicemailGreetingId !== row.voicemailGreetingId
      ) {
        return null;
      }

      return { ...row };
    },
  );
  const db = {
    departmentSettings: {
      findFirst: settingsFindFirst,
      updateMany: settingsUpdateMany,
    },
    $transaction: async (run: (tx: unknown) => unknown) => {
      if (options.transactionFails) {
        throw new Error('connection reset');
      }

      return run(db);
    },
  };
  const auditCreate = vi.fn(async () => undefined);
  const refreshDepartment = vi.fn(async () => undefined);
  const log = { warn: vi.fn() };
  const mediaStore = options.mediaStore ?? new InMemoryMediaStore();
  const service = new DepartmentGreetingService({
    db: db as unknown as PrismaClient,
    mediaStore,
    publicUrl: PUBLIC_URL,
    auditLog: { create: auditCreate } as unknown as AuditLogService,
    routingCache: { refreshDepartment } as unknown as RoutingCacheService,
    log: log as unknown as FastifyBaseLogger,
  });

  return {
    service,
    row,
    db,
    mediaStore,
    auditCreate,
    refreshDepartment,
    settingsUpdateMany,
    settingsFindFirst,
    log,
  };
}

const noGreeting: SettingsRow = {
  voicemailGreetingId: null,
  voicemailGreetingKey: null,
};

describe('DepartmentGreetingService.upload', () => {
  test('stores the file, names it on the settings row, audits and refreshes routing', async () => {
    const { service, row, mediaStore, auditCreate, refreshDepartment, db } =
      buildService(noGreeting);

    const url = await service.upload(
      'dept-1',
      { contentType: 'audio/mpeg', bytes: MP3 },
      'admin-1',
      '203.0.113.7',
    );

    const greetingId = row?.voicemailGreetingId;
    expect(greetingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(url).toBe(`${PUBLIC_URL}/media/greetings/${greetingId}`);
    expect(row?.voicemailGreetingKey).toBe(
      `greetings/dept-1/${greetingId}.mp3`,
    );
    expect(mediaStore.keys()).toEqual([`greetings/dept-1/${greetingId}.mp3`]);
    const stored = await mediaStore.get(`greetings/dept-1/${greetingId}.mp3`);
    expect(stored?.contentType).toBe('audio/mpeg');
    expect(await buffer(stored?.body ?? [])).toEqual(MP3);
    expect(auditCreate).toHaveBeenCalledWith(
      {
        action: 'department.greeting_uploaded',
        entityType: 'Department',
        entityId: 'dept-1',
        userId: 'admin-1',
        changes: {
          greetingId,
          contentType: 'audio/mpeg',
          sizeBytes: MP3.byteLength,
          replacedGreetingId: null,
        },
        ipAddress: '203.0.113.7',
      },
      db,
    );
    expect(refreshDepartment).toHaveBeenCalledWith('dept-1');
  });

  test('stores a WAV under its own extension and canonical type whatever the browser called it', async () => {
    const { service, row, mediaStore } = buildService(noGreeting);

    await service.upload(
      'dept-1',
      { contentType: 'audio/x-wav', bytes: WAV },
      'admin-1',
    );

    expect(row?.voicemailGreetingKey).toMatch(/\.wav$/);
    expect(
      (await mediaStore.get(row?.voicemailGreetingKey ?? ''))?.contentType,
    ).toBe('audio/wav');
  });

  test('gives every upload a new id and drops the previous file', async () => {
    const mediaStore = new InMemoryMediaStore();
    await mediaStore.put({
      key: 'greetings/dept-1/old-greeting.mp3',
      contentType: 'audio/mpeg',
      body: MP3,
    });
    const { service, row, auditCreate } = buildService(
      {
        voicemailGreetingId: 'old-greeting',
        voicemailGreetingKey: 'greetings/dept-1/old-greeting.mp3',
      },
      { mediaStore },
    );

    const url = await service.upload(
      'dept-1',
      { contentType: 'audio/wav', bytes: WAV },
      'admin-1',
    );

    expect(url).not.toContain('old-greeting');
    expect(row?.voicemailGreetingId).not.toBe('old-greeting');
    expect(mediaStore.keys()).toEqual([row?.voicemailGreetingKey]);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: expect.objectContaining({
          replacedGreetingId: 'old-greeting',
        }),
      }),
      expect.anything(),
    );
  });

  test('resolves null and stores nothing for an unknown department', async () => {
    const { service, mediaStore, auditCreate, refreshDepartment } =
      buildService(null);

    expect(
      await service.upload(
        'dept-gone',
        { contentType: 'audio/mpeg', bytes: MP3 },
        'admin-1',
      ),
    ).toBeNull();
    expect(mediaStore.keys()).toEqual([]);
    expect(auditCreate).not.toHaveBeenCalled();
    expect(refreshDepartment).not.toHaveBeenCalled();
  });

  test.each([
    ['image/png', MP3, 415, 'unsupported_type'],
    ['audio/mpeg', WAV, 415, 'not_audio'],
    ['audio/mpeg', Buffer.alloc(0), 400, 'empty'],
  ])(
    'refuses %s with the bytes of something else as a %i and changes nothing',
    async (contentType, bytes, statusCode, reason) => {
      const { service, mediaStore, auditCreate, refreshDepartment, row } =
        buildService(noGreeting);

      const attempt = service.upload(
        'dept-1',
        { contentType, bytes },
        'admin-1',
      );

      await expect(attempt).rejects.toBeInstanceOf(GreetingRejectedError);
      await expect(attempt).rejects.toMatchObject({
        statusCode,
        rejection: expect.objectContaining({ reason }),
      });
      expect(mediaStore.keys()).toEqual([]);
      expect(row).toEqual(noGreeting);
      expect(auditCreate).not.toHaveBeenCalled();
      expect(refreshDepartment).not.toHaveBeenCalled();
    },
  );

  test('takes the new file back out of the store when the row cannot be updated', async () => {
    const { service, mediaStore, refreshDepartment } = buildService(
      noGreeting,
      { transactionFails: true },
    );

    await expect(
      service.upload(
        'dept-1',
        { contentType: 'audio/mpeg', bytes: MP3 },
        'admin-1',
      ),
    ).rejects.toThrow('connection reset');

    expect(mediaStore.keys()).toEqual([]);
    expect(refreshDepartment).not.toHaveBeenCalled();
  });

  test('refuses to overwrite a greeting another admin set while the file was being stored', async () => {
    const mediaStore = new InMemoryMediaStore();
    const { service, row, auditCreate, refreshDepartment } = buildService(
      noGreeting,
      { mediaStore },
    );
    const put = mediaStore.put.bind(mediaStore);
    vi.spyOn(mediaStore, 'put').mockImplementation(async (input) => {
      await put(input);
      // The other admin's upload, bytes and all, lands between this one's
      // read and write.
      await put({
        key: 'greetings/dept-1/theirs.mp3',
        contentType: 'audio/mpeg',
        body: WAV,
      });
      Object.assign(row ?? {}, {
        voicemailGreetingId: 'theirs',
        voicemailGreetingKey: 'greetings/dept-1/theirs.mp3',
      });
    });

    const attempt = service.upload(
      'dept-1',
      { contentType: 'audio/mpeg', bytes: MP3 },
      'admin-1',
    );

    await expect(attempt).rejects.toBeInstanceOf(GreetingChangedError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 409 });
    expect(row).toEqual({
      voicemailGreetingId: 'theirs',
      voicemailGreetingKey: 'greetings/dept-1/theirs.mp3',
    });
    // The file this request stored is taken back out; theirs is kept.
    expect(mediaStore.keys()).toEqual(['greetings/dept-1/theirs.mp3']);
    expect(auditCreate).not.toHaveBeenCalled();
    expect(refreshDepartment).not.toHaveBeenCalled();
  });

  test('keeps the new greeting when the previous file cannot be deleted, and says so', async () => {
    const mediaStore = new InMemoryMediaStore();
    vi.spyOn(mediaStore, 'delete').mockRejectedValue(new Error('bucket away'));
    const { service, row, refreshDepartment, log } = buildService(
      {
        voicemailGreetingId: 'old-greeting',
        voicemailGreetingKey: 'greetings/dept-1/old-greeting.mp3',
      },
      { mediaStore },
    );

    const url = await service.upload(
      'dept-1',
      { contentType: 'audio/mpeg', bytes: MP3 },
      'admin-1',
    );

    expect(url).toContain(row?.voicemailGreetingId);
    expect(refreshDepartment).toHaveBeenCalledWith('dept-1');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        departmentId: 'dept-1',
        key: 'greetings/dept-1/old-greeting.mp3',
      }),
      expect.stringContaining('Could not delete'),
    );
  });
});

describe('DepartmentGreetingService.remove', () => {
  test('clears the row, drops the file, audits and refreshes routing', async () => {
    const mediaStore = new InMemoryMediaStore();
    await mediaStore.put({
      key: 'greetings/dept-1/old-greeting.mp3',
      contentType: 'audio/mpeg',
      body: MP3,
    });
    const { service, row, auditCreate, refreshDepartment, db } = buildService(
      {
        voicemailGreetingId: 'old-greeting',
        voicemailGreetingKey: 'greetings/dept-1/old-greeting.mp3',
      },
      { mediaStore },
    );

    expect(await service.remove('dept-1', 'admin-1', '203.0.113.7')).toBe(true);

    expect(row).toEqual(noGreeting);
    expect(mediaStore.keys()).toEqual([]);
    expect(auditCreate).toHaveBeenCalledWith(
      {
        action: 'department.greeting_removed',
        entityType: 'Department',
        entityId: 'dept-1',
        userId: 'admin-1',
        changes: { greetingId: 'old-greeting' },
        ipAddress: '203.0.113.7',
      },
      db,
    );
    expect(refreshDepartment).toHaveBeenCalledWith('dept-1');
  });

  test('refuses to remove a greeting that was replaced since it was read', async () => {
    const mediaStore = new InMemoryMediaStore();
    await mediaStore.put({
      key: 'greetings/dept-1/current.mp3',
      contentType: 'audio/mpeg',
      body: MP3,
    });
    const { service, row, settingsFindFirst, auditCreate, refreshDepartment } =
      buildService(
        {
          voicemailGreetingId: 'current',
          voicemailGreetingKey: 'greetings/dept-1/current.mp3',
        },
        { mediaStore },
      );
    // What this request read, before the other admin's upload committed.
    settingsFindFirst.mockResolvedValueOnce({
      voicemailGreetingId: 'stale',
      voicemailGreetingKey: 'greetings/dept-1/stale.mp3',
    });

    const attempt = service.remove('dept-1', 'admin-1');

    await expect(attempt).rejects.toBeInstanceOf(GreetingChangedError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 409 });
    expect(row?.voicemailGreetingId).toBe('current');
    expect(mediaStore.keys()).toEqual(['greetings/dept-1/current.mp3']);
    expect(auditCreate).not.toHaveBeenCalled();
    expect(refreshDepartment).not.toHaveBeenCalled();
  });

  test('leaves a department without a greeting alone', async () => {
    const { service, settingsUpdateMany, auditCreate, refreshDepartment } =
      buildService(noGreeting);

    expect(await service.remove('dept-1', 'admin-1')).toBe(true);

    expect(settingsUpdateMany).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(refreshDepartment).not.toHaveBeenCalled();
  });

  test('resolves false for an unknown department', async () => {
    const { service } = buildService(null);

    expect(await service.remove('dept-gone', 'admin-1')).toBe(false);
  });

  test('only looks at departments that are not deleted', async () => {
    const { service, settingsFindFirst } = buildService(noGreeting);

    await service.remove('dept-1', 'admin-1');

    expect(settingsFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { departmentId: 'dept-1', department: { deletedAt: null } },
      }),
    );
  });
});

describe('DepartmentGreetingService.open', () => {
  test('streams the file the id names with its stored type and length', async () => {
    const mediaStore = new InMemoryMediaStore();
    await mediaStore.put({
      key: 'greetings/dept-1/greeting-1.mp3',
      contentType: 'audio/mpeg',
      body: MP3,
    });
    const { service } = buildService(
      {
        voicemailGreetingId: 'greeting-1',
        voicemailGreetingKey: 'greetings/dept-1/greeting-1.mp3',
      },
      { mediaStore },
    );

    const greeting = await service.open('greeting-1');

    expect(greeting).toMatchObject({
      contentType: 'audio/mpeg',
      contentLength: MP3.byteLength,
    });
    expect(await buffer(greeting?.body ?? [])).toEqual(MP3);
  });

  test('resolves null for an id no department uses', async () => {
    const { service } = buildService({
      voicemailGreetingId: 'greeting-1',
      voicemailGreetingKey: 'greetings/dept-1/greeting-1.mp3',
    });

    expect(await service.open('greeting-2')).toBeNull();
  });

  test('resolves null when the row names a file the store no longer has', async () => {
    const { service } = buildService({
      voicemailGreetingId: 'greeting-1',
      voicemailGreetingKey: 'greetings/dept-1/greeting-1.mp3',
    });

    expect(await service.open('greeting-1')).toBeNull();
  });

  test('resolves null once the owning department is soft-deleted', async () => {
    const mediaStore = new InMemoryMediaStore();
    await mediaStore.put({
      key: 'greetings/dept-1/greeting-1.mp3',
      contentType: 'audio/mpeg',
      body: MP3,
    });
    const { service } = buildService(
      {
        voicemailGreetingId: 'greeting-1',
        voicemailGreetingKey: 'greetings/dept-1/greeting-1.mp3',
      },
      { mediaStore, departmentDeleted: true },
    );

    expect(await service.open('greeting-1')).toBeNull();
  });
});
