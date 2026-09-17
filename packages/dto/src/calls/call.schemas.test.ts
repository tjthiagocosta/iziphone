import { describe, expect, test } from 'vitest';
import { CallListQuerySchema } from './call.schemas.js';

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
