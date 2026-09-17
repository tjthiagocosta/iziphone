import { describe, expect, test } from 'vitest';
import {
  CallListQuerySchema,
  OutboundCallLinesResponseSchema,
} from './call.schemas.js';

describe('CallListQuerySchema', () => {
  test('applies defaults and coerces query strings', () => {
    expect(CallListQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(CallListQuerySchema.parse({ limit: '20', offset: '40' })).toEqual({
      limit: 20,
      offset: 40,
    });
  });

  test('rejects a page larger than the maximum', () => {
    expect(CallListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(CallListQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
  });
});

describe('OutboundCallLinesResponseSchema', () => {
  const line = {
    id: 'pn-1',
    phoneNumber: '+15555550100',
    label: 'Support',
    ownerType: 'department',
    ownerId: 'dept-1',
    ownerName: 'Support',
    isPrimary: true,
  };

  test('accepts the lines a user may call from, and none at all', () => {
    expect(OutboundCallLinesResponseSchema.parse({ lines: [line] })).toEqual({
      lines: [line],
    });
    expect(OutboundCallLinesResponseSchema.parse({ lines: [] })).toEqual({
      lines: [],
    });
  });

  test('rejects a line whose owner is neither a user nor a department', () => {
    expect(
      OutboundCallLinesResponseSchema.safeParse({
        lines: [{ ...line, ownerType: 'queue' }],
      }).success,
    ).toBe(false);
  });
});
