import { describe, expect, test } from 'vitest';
import { CreateUserSchema, UserListQuerySchema } from './user.schemas.js';

describe('CreateUserSchema', () => {
  test('defaults the role to AGENT and trims the name', () => {
    const parsed = CreateUserSchema.parse({
      email: 'ada@example.com',
      name: '  Ada Example ',
      password: 'correct-horse-battery',
    });
    expect(parsed.role).toBe('AGENT');
    expect(parsed.name).toBe('Ada Example');
  });

  test.each([
    ['not-an-email', 'Ada', 'correct-horse-battery'],
    ['ada@example.com', '', 'correct-horse-battery'],
    ['ada@example.com', 'Ada', 'short'],
    ['ada@example.com', 'Ada', 'x'.repeat(129)],
  ])('rejects email=%s name=%j password length=%s', (email, name, password) => {
    expect(CreateUserSchema.safeParse({ email, name, password }).success).toBe(
      false,
    );
  });

  test('rejects roles outside the enum', () => {
    const result = CreateUserSchema.safeParse({
      email: 'ada@example.com',
      name: 'Ada',
      password: 'correct-horse-battery',
      role: 'ROOT',
    });
    expect(result.success).toBe(false);
  });
});

describe('UserListQuerySchema', () => {
  test('filters by role and parses boolean flags from strings', () => {
    expect(
      UserListQuerySchema.parse({ role: 'ADMIN', deletedOnly: 'true' }),
    ).toEqual({
      page: 1,
      limit: 20,
      role: 'ADMIN',
      includeDeleted: false,
      deletedOnly: true,
    });
  });
});
