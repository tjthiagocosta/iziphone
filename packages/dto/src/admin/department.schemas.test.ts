import { describe, expect, test } from 'vitest';
import {
  BusinessHoursItemSchema,
  CreateHolidaySchema,
  DepartmentListQuerySchema,
  UpdateAgentOrderSchema,
  UpdateBusinessHoursSchema,
  UpdateDepartmentSettingsSchema,
} from './department.schemas.js';

const closed = (dayOfWeek: number) => ({
  dayOfWeek,
  isOpen: false,
  openTime: null,
  closeTime: null,
});

describe('BusinessHoursItemSchema', () => {
  test('accepts an open day with a valid window', () => {
    const result = BusinessHoursItemSchema.safeParse({
      dayOfWeek: 1,
      isOpen: true,
      openTime: '09:00',
      closeTime: '17:30',
    });
    expect(result.success).toBe(true);
  });

  test('requires both times on an open day', () => {
    const result = BusinessHoursItemSchema.safeParse({
      dayOfWeek: 1,
      isOpen: true,
      openTime: '09:00',
      closeTime: null,
    });
    expect(result.success).toBe(false);
  });

  test('rejects a window that closes before it opens', () => {
    const result = BusinessHoursItemSchema.safeParse({
      dayOfWeek: 1,
      isOpen: true,
      openTime: '17:00',
      closeTime: '09:00',
    });
    expect(result.success).toBe(false);
  });

  test('ignores times on a closed day', () => {
    expect(BusinessHoursItemSchema.safeParse(closed(0)).success).toBe(true);
  });
});

describe('UpdateBusinessHoursSchema', () => {
  test('accepts one entry per weekday', () => {
    const week = [0, 1, 2, 3, 4, 5, 6].map(closed);
    expect(UpdateBusinessHoursSchema.safeParse(week).success).toBe(true);
  });

  test('rejects a duplicated day even when seven entries are sent', () => {
    const week = [0, 1, 2, 3, 4, 5, 5].map(closed);
    expect(UpdateBusinessHoursSchema.safeParse(week).success).toBe(false);
  });

  test('rejects fewer than seven entries', () => {
    expect(UpdateBusinessHoursSchema.safeParse([closed(0)]).success).toBe(
      false,
    );
  });
});

describe('CreateHolidaySchema', () => {
  test('requires a number when routing to an external number', () => {
    const result = CreateHolidaySchema.safeParse({
      name: 'Founders Day',
      date: '2026-07-04T00:00:00.000Z',
      routingType: 'EXTERNAL_NUMBER',
    });
    expect(result.success).toBe(false);
  });

  test('accepts voicemail routing without a value and defaults isRecurring', () => {
    const parsed = CreateHolidaySchema.parse({
      name: 'Founders Day',
      date: '2026-07-04T00:00:00.000Z',
      routingType: 'VOICEMAIL',
    });
    expect(parsed.isRecurring).toBe(false);
  });
});

describe('UpdateDepartmentSettingsSchema', () => {
  test('rejects unknown time zones', () => {
    const result = UpdateDepartmentSettingsSchema.safeParse({
      timezone: 'Central Time',
    });
    expect(result.success).toBe(false);
  });

  test('bounds the ring duration', () => {
    expect(
      UpdateDepartmentSettingsSchema.safeParse({ ringDuration: 9 }).success,
    ).toBe(false);
    expect(
      UpdateDepartmentSettingsSchema.safeParse({ ringDuration: 46 }).success,
    ).toBe(false);
    expect(
      UpdateDepartmentSettingsSchema.safeParse({ ringDuration: 30 }).success,
    ).toBe(true);
  });

  test('only accepts http(s) greeting URLs', () => {
    const result = UpdateDepartmentSettingsSchema.safeParse({
      voicemailGreetingUrl: 'ftp://example.com/greeting.mp3',
    });
    expect(result.success).toBe(false);
  });
});

describe('DepartmentListQuerySchema', () => {
  test('treats the string "false" as false', () => {
    const parsed = DepartmentListQuerySchema.parse({ includeDeleted: 'false' });
    expect(parsed.includeDeleted).toBe(false);
  });

  test('applies pagination defaults', () => {
    expect(DepartmentListQuerySchema.parse({})).toEqual({
      page: 1,
      limit: 20,
      includeDeleted: false,
      deletedOnly: false,
    });
  });
});

describe('UpdateAgentOrderSchema', () => {
  test('rejects a user listed twice', () => {
    const result = UpdateAgentOrderSchema.safeParse({
      agentOrder: [
        { userId: 'user-1', order: 0 },
        { userId: 'user-1', order: 1 },
      ],
    });
    expect(result.success).toBe(false);
  });
});
