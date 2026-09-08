import { describe, expect, test } from 'vitest';
import { PaginationQuerySchema } from './pagination.js';

describe('PaginationQuerySchema', () => {
  test('applies defaults', () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
  });

  test('coerces query-string numbers', () => {
    expect(PaginationQuerySchema.parse({ page: '3', limit: '50' })).toEqual({
      page: 3,
      limit: 50,
    });
  });

  test.each([
    [{ page: 0 }],
    [{ page: 1.5 }],
    [{ limit: 0 }],
    [{ limit: 101 }],
    [{ page: 'abc' }],
  ])('rejects %j', (query) => {
    expect(PaginationQuerySchema.safeParse(query).success).toBe(false);
  });
});
