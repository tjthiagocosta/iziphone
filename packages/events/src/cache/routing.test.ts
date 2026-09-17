import { describe, expect, test } from 'vitest';
import {
  CachedRoutingSchema,
  ROUTING_CACHE,
  resolveRoutingCacheTtl,
} from './routing.js';

describe('resolveRoutingCacheTtl', () => {
  test('falls back to the default when unset or blank', () => {
    expect(resolveRoutingCacheTtl(undefined)).toBe(
      ROUTING_CACHE.DEFAULT_TTL_SECONDS,
    );
    expect(resolveRoutingCacheTtl('  ')).toBe(
      ROUTING_CACHE.DEFAULT_TTL_SECONDS,
    );
  });

  test('accepts a positive whole number of seconds', () => {
    expect(resolveRoutingCacheTtl('600')).toBe(600);
  });

  test.each(['0', '-5', '1.5', 'soon', '1e3x'])('rejects %s', (value) => {
    expect(() => resolveRoutingCacheTtl(value)).toThrow(
      /DEPARTMENT_CACHE_TTL_SECONDS/,
    );
  });
});

describe('CachedRoutingSchema', () => {
  test('accepts a direct line entry', () => {
    const result = CachedRoutingSchema.safeParse({
      type: 'USER',
      userIds: ['user-1'],
      userId: 'user-1',
      userName: 'Ada Example',
      cachedAt: '2026-04-21T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  test('accepts a department entry with settings', () => {
    const result = CachedRoutingSchema.safeParse({
      type: 'DEPARTMENT',
      userIds: ['user-1', 'user-2'],
      orderedUsers: [
        { userId: 'user-1', order: 0 },
        { userId: 'user-2', order: 1 },
      ],
      departmentId: 'dept-1',
      departmentName: 'Support',
      settings: {
        timezone: 'America/Chicago',
        is24Hours: false,
        openHoursRoutingType: 'FIXED_ORDER',
        ringDuration: 20,
        closedHoursRoutingType: 'VOICEMAIL',
        closedHoursExternalNumber: null,
        voicemailGreetingUrl: null,
        businessHours: [
          { dayOfWeek: 1, isOpen: true, openTime: '09:00', closeTime: '17:00' },
        ],
        holidays: [
          {
            name: 'Founders Day',
            date: '2026-07-04T00:00:00.000Z',
            isRecurring: true,
            routingType: 'VOICEMAIL',
            routingValue: null,
          },
        ],
      },
      cachedAt: '2026-04-21T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  test('carries whether the number does voice, and tolerates entries that do not say', () => {
    const entry = {
      type: 'USER',
      userIds: ['user-1'],
      cachedAt: '2026-04-21T12:00:00.000Z',
    };
    expect(
      CachedRoutingSchema.parse({ ...entry, voiceEnabled: false }).voiceEnabled,
    ).toBe(false);
    expect(CachedRoutingSchema.parse(entry).voiceEnabled).toBeUndefined();
    expect(
      CachedRoutingSchema.safeParse({ ...entry, voiceEnabled: 'yes' }).success,
    ).toBe(false);
  });

  test('rejects a routing type outside the contract', () => {
    const result = CachedRoutingSchema.safeParse({
      type: 'QUEUE',
      userIds: [],
      cachedAt: '2026-04-21T12:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});
