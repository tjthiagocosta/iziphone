import type { PrismaClient } from '@repo/db';
import {
  CachedDepartmentSchema,
  CachedRoutingSchema,
  ROUTING_CACHE,
} from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { describe, expect, test, vi } from 'vitest';
import {
  projectDepartmentRouting,
  projectUserRouting,
  RoutingCacheService,
  type RoutingDepartmentRow,
} from './routing-cache.js';

const CACHED_AT = '2026-03-20T00:00:00.000Z';
const TTL = 3600;
const PUBLIC_URL = 'https://api.example.com';
const DEPARTMENT_LINE = '+15555550101';
const DIRECT_LINE = '+15555550102';

const log = {
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as FastifyBaseLogger;

function supportDepartment(
  overrides: Partial<RoutingDepartmentRow> = {},
): RoutingDepartmentRow {
  return {
    id: 'dept-1',
    name: 'Support',
    deletedAt: null,
    users: [
      { userId: 'user-2', order: 1 },
      { userId: 'user-1', order: 0 },
    ],
    settings: {
      timezone: 'America/Sao_Paulo',
      is24Hours: false,
      openHoursRoutingType: 'FIXED_ORDER',
      ringDuration: 20,
      closedHoursRoutingType: 'VOICEMAIL',
      closedHoursExternalNumber: null,
      voicemailGreetingId: null,
      voicemailGreetingKey: null,
    },
    businessHours: [
      { dayOfWeek: 1, isOpen: true, openTime: '09:00', closeTime: '18:00' },
    ],
    holidays: [
      {
        name: 'Founders Day',
        date: new Date('2026-12-25T00:00:00.000Z'),
        isRecurring: true,
        routingType: 'VOICEMAIL',
        routingValue: null,
      },
    ],
    ...overrides,
  } as unknown as RoutingDepartmentRow;
}

function fakeRedis() {
  const set = vi.fn();
  const del = vi.fn();
  const exec = vi.fn(async () => []);
  const pipeline = { set, del, exec };
  set.mockReturnValue(pipeline);
  del.mockReturnValue(pipeline);

  return {
    redis: { pipeline: () => pipeline } as unknown as Redis,
    set,
    del,
    exec,
  };
}

function writtenValue(set: ReturnType<typeof vi.fn>, key: string): unknown {
  const call = set.mock.calls.find((args) => args[0] === key);
  expect(call, `expected a write for ${key}`).toBeDefined();
  expect(call?.[2]).toBe('EX');
  expect(call?.[3]).toBe(TTL);
  return JSON.parse(call?.[1] as string);
}

describe('routing projection', () => {
  test('should project a department into routing the controller can parse', () => {
    const routing = CachedRoutingSchema.parse(
      projectDepartmentRouting(supportDepartment(), CACHED_AT, PUBLIC_URL),
    );

    expect(routing).toEqual({
      type: 'DEPARTMENT',
      departmentId: 'dept-1',
      departmentName: 'Support',
      userIds: ['user-2', 'user-1'],
      orderedUsers: [
        { userId: 'user-2', order: 1 },
        { userId: 'user-1', order: 0 },
      ],
      settings: {
        timezone: 'America/Sao_Paulo',
        is24Hours: false,
        openHoursRoutingType: 'FIXED_ORDER',
        ringDuration: 20,
        closedHoursRoutingType: 'VOICEMAIL',
        closedHoursExternalNumber: null,
        voicemailGreetingUrl: null,
        businessHours: [
          { dayOfWeek: 1, isOpen: true, openTime: '09:00', closeTime: '18:00' },
        ],
        holidays: [
          {
            name: 'Founders Day',
            date: '2026-12-25T00:00:00.000Z',
            isRecurring: true,
            routingType: 'VOICEMAIL',
            routingValue: null,
          },
        ],
      },
      cachedAt: CACHED_AT,
    });
  });

  test('should leave settings out when a department has none yet', () => {
    const routing = CachedRoutingSchema.parse(
      projectDepartmentRouting(
        supportDepartment({ settings: null }),
        CACHED_AT,
        PUBLIC_URL,
      ),
    );

    expect(routing.settings).toBeUndefined();
  });

  test('should carry the uploaded greeting as the URL this API serves it from', () => {
    const department = supportDepartment();
    const routing = CachedRoutingSchema.parse(
      projectDepartmentRouting(
        {
          ...department,
          settings: {
            ...department.settings,
            voicemailGreetingId: 'greeting-abc',
            voicemailGreetingKey: 'greetings/dept-1/greeting-abc.mp3',
          },
        } as RoutingDepartmentRow,
        CACHED_AT,
        PUBLIC_URL,
      ),
    );

    // The controller hands this URL to Twilio as it is; nothing but the
    // public base and the id may go into it.
    expect(routing.settings?.voicemailGreetingUrl).toBe(
      'https://api.example.com/media/greetings/greeting-abc',
    );
  });

  test('should project a direct line into user routing', () => {
    expect(
      CachedRoutingSchema.parse(
        projectUserRouting({ id: 'user-9', name: null }, CACHED_AT),
      ),
    ).toEqual({
      type: 'USER',
      userIds: ['user-9'],
      userId: 'user-9',
      cachedAt: CACHED_AT,
    });
  });
});

describe('RoutingCacheService', () => {
  test('should cache department routing under the phone and department keys on lookup', async () => {
    const { redis, set, exec } = fakeRedis();
    const db = {
      phoneNumber: {
        findFirst: vi.fn(async () => ({
          voiceEnabled: true,
          department: supportDepartment(),
          user: null,
        })),
      },
    } as unknown as PrismaClient;
    const service = new RoutingCacheService(redis, db, TTL, PUBLIC_URL, log);

    const routing = await service.lookupByPhone(DEPARTMENT_LINE);

    expect(routing?.type).toBe('DEPARTMENT');
    expect(exec).toHaveBeenCalledTimes(1);
    expect(
      CachedRoutingSchema.parse(
        writtenValue(
          set,
          `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DEPARTMENT_LINE}`,
        ),
      ),
    ).toMatchObject({
      type: 'DEPARTMENT',
      departmentId: 'dept-1',
      voiceEnabled: true,
    });
    expect(
      CachedDepartmentSchema.parse(
        writtenValue(set, `${ROUTING_CACHE.DEPARTMENT_ID_KEY_PREFIX}dept-1`),
      ),
    ).toMatchObject({
      id: 'dept-1',
      name: 'Support',
      userIds: ['user-2', 'user-1'],
    });
  });

  test('should cache direct-line routing and skip deleted users on lookup', async () => {
    const { redis, set } = fakeRedis();
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        voiceEnabled: false,
        department: null,
        user: { id: 'user-9', name: 'Agent Nine', deletedAt: null },
      })
      .mockResolvedValueOnce({
        voiceEnabled: true,
        department: null,
        user: { id: 'user-11', name: 'Gone', deletedAt: new Date() },
      });
    const db = { phoneNumber: { findFirst } } as unknown as PrismaClient;
    const service = new RoutingCacheService(redis, db, TTL, PUBLIC_URL, log);

    const live = await service.lookupByPhone(DIRECT_LINE);
    const deleted = await service.lookupByPhone('+15555550103');

    // The controller refuses to call out from a number that does not do
    // voice, so the entry has to say so.
    expect(live).toMatchObject({
      type: 'USER',
      userId: 'user-9',
      voiceEnabled: false,
    });
    expect(deleted).toBeNull();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[0]).toBe(
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DIRECT_LINE}`,
    );
  });

  test('should only query active, non-deleted numbers', async () => {
    const { redis } = fakeRedis();
    const findFirst = vi.fn(async () => null);
    const db = { phoneNumber: { findFirst } } as unknown as PrismaClient;
    const service = new RoutingCacheService(redis, db, TTL, PUBLIC_URL, log);

    await service.lookupByPhone(DEPARTMENT_LINE);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          phoneNumber: DEPARTMENT_LINE,
          deletedAt: null,
          status: 'ACTIVE',
        },
      }),
    );
  });

  test('should drop the entry of a number that no longer routes on refresh', async () => {
    const { redis, set, del, exec } = fakeRedis();
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        voiceEnabled: true,
        department: null,
        user: { id: 'user-9', name: 'Agent Nine', deletedAt: null },
      });
    const db = { phoneNumber: { findFirst } } as unknown as PrismaClient;
    const service = new RoutingCacheService(redis, db, TTL, PUBLIC_URL, log);

    await service.refreshPhoneNumbers([DEPARTMENT_LINE, DIRECT_LINE]);

    expect(del).toHaveBeenCalledWith(
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DEPARTMENT_LINE}`,
    );
    expect(set.mock.calls[0]?.[0]).toBe(
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DIRECT_LINE}`,
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  test('should not touch Redis when refreshing an empty number list', async () => {
    const { redis, exec } = fakeRedis();
    const service = new RoutingCacheService(
      redis,
      {} as PrismaClient,
      TTL,
      PUBLIC_URL,
      log,
    );

    await service.refreshPhoneNumbers([]);

    expect(exec).not.toHaveBeenCalled();
  });

  test('should rewrite every active number of a department on refresh', async () => {
    const { redis, set } = fakeRedis();
    const db = {
      department: {
        findFirst: vi.fn(async () =>
          supportDepartment({
            phoneNumbers: [
              { phoneNumber: DEPARTMENT_LINE, voiceEnabled: true },
              { phoneNumber: '+15555550104', voiceEnabled: false },
            ],
          } as Partial<RoutingDepartmentRow>),
        ),
      },
    } as unknown as PrismaClient;
    const service = new RoutingCacheService(redis, db, TTL, PUBLIC_URL, log);

    await service.refreshDepartment('dept-1');

    expect(set.mock.calls.map((args) => args[0])).toEqual([
      `${ROUTING_CACHE.DEPARTMENT_ID_KEY_PREFIX}dept-1`,
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DEPARTMENT_LINE}`,
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}+15555550104`,
    ]);
    // Both numbers ring the same people, but each says for itself whether
    // it does voice.
    expect(
      CachedRoutingSchema.parse(
        writtenValue(
          set,
          `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DEPARTMENT_LINE}`,
        ),
      ),
    ).toMatchObject({ departmentId: 'dept-1', voiceEnabled: true });
    expect(
      CachedRoutingSchema.parse(
        writtenValue(set, `${ROUTING_CACHE.PHONE_KEY_PREFIX}+15555550104`),
      ),
    ).toMatchObject({ departmentId: 'dept-1', voiceEnabled: false });
  });

  test('should remove the department entry when the department is gone', async () => {
    const { redis, set, del } = fakeRedis();
    const db = {
      department: { findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    const service = new RoutingCacheService(redis, db, TTL, PUBLIC_URL, log);

    await service.refreshDepartment('dept-gone');

    expect(del).toHaveBeenCalledWith(
      `${ROUTING_CACHE.DEPARTMENT_ID_KEY_PREFIX}dept-gone`,
    );
    expect(set).not.toHaveBeenCalled();
  });

  test('should warm departments with numbers and direct lines in one pass', async () => {
    const { redis, set, exec } = fakeRedis();
    const db = {
      department: {
        findMany: vi.fn(async () => [
          supportDepartment({
            phoneNumbers: [
              { phoneNumber: DEPARTMENT_LINE, voiceEnabled: true },
            ],
          } as Partial<RoutingDepartmentRow>),
          supportDepartment({
            id: 'dept-2',
            phoneNumbers: [],
          } as Partial<RoutingDepartmentRow>),
        ]),
      },
      phoneNumber: {
        findMany: vi.fn(async () => [
          {
            phoneNumber: DIRECT_LINE,
            voiceEnabled: true,
            user: { id: 'user-9', name: 'Agent Nine' },
          },
        ]),
      },
    } as unknown as PrismaClient;
    const service = new RoutingCacheService(redis, db, TTL, PUBLIC_URL, log);

    const result = await service.warmAll();

    expect(result).toEqual({ departments: 1, users: 1 });
    expect(set.mock.calls.map((args) => args[0])).toEqual([
      `${ROUTING_CACHE.DEPARTMENT_ID_KEY_PREFIX}dept-1`,
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DEPARTMENT_LINE}`,
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DIRECT_LINE}`,
    ]);
    // A warm-up after an upgrade is what gives every entry its voice flag.
    for (const line of [DEPARTMENT_LINE, DIRECT_LINE]) {
      expect(
        CachedRoutingSchema.parse(
          writtenValue(set, `${ROUTING_CACHE.PHONE_KEY_PREFIX}${line}`),
        ),
      ).toMatchObject({ voiceEnabled: true });
    }
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
