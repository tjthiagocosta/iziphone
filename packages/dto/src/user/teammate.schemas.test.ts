import { describe, expect, test } from 'vitest';
import { TeammatesResponseSchema } from './teammate.schemas.js';

describe('TeammatesResponseSchema', () => {
  test('accepts a teammate with or without departments', () => {
    const parsed = TeammatesResponseSchema.parse({
      teammates: [
        { id: 'user-2', name: 'Alex Rivers', departments: ['Support'] },
        { id: 'user-3', name: 'sam@example.com', departments: [] },
      ],
    });

    expect(parsed.teammates).toHaveLength(2);
  });

  test('keeps only the fields a picker needs', () => {
    const parsed = TeammatesResponseSchema.parse({
      teammates: [
        {
          id: 'user-2',
          name: 'Alex Rivers',
          departments: [],
          email: 'alex@example.com',
        },
      ],
    });

    expect(parsed.teammates[0]).toEqual({
      id: 'user-2',
      name: 'Alex Rivers',
      departments: [],
    });
  });

  test('rejects a teammate without a display name', () => {
    expect(
      TeammatesResponseSchema.safeParse({
        teammates: [{ id: 'user-2', name: null, departments: [] }],
      }).success,
    ).toBe(false);
  });
});
