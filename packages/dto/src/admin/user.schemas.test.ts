import { describe, expect, test } from 'vitest';
import {
  CreateUserSchema,
  UpdateUserSchema,
  UserListQuerySchema,
} from './user.schemas.js';

describe('CreateUserSchema', () => {
  test('defaults the role to AGENT and trims the name', () => {
    const parsed = CreateUserSchema.parse({
      email: 'ada@example.com',
      name: '  Ada Example ',
    });
    expect(parsed.role).toBe('AGENT');
    expect(parsed.name).toBe('Ada Example');
  });

  test('lower-cases the email, which is how sign-in looks it up', () => {
    expect(
      CreateUserSchema.parse({ email: 'Ada.Example@Example.COM', name: 'Ada' })
        .email,
    ).toBe('ada.example@example.com');
  });

  test('has no password field: a user is invited, never given one', () => {
    const parsed = CreateUserSchema.parse({
      email: 'ada@example.com',
      name: 'Ada',
      password: 'correct-horse-battery',
    });
    expect(parsed).not.toHaveProperty('password');
  });

  test.each([
    ['not-an-email', 'Ada'],
    ['ada@example.com', ''],
    [`${'a'.repeat(250)}@example.com`, 'Ada'],
  ])('rejects email=%s name=%j', (email, name) => {
    expect(CreateUserSchema.safeParse({ email, name }).success).toBe(false);
  });

  test('rejects roles outside the enum', () => {
    const result = CreateUserSchema.safeParse({
      email: 'ada@example.com',
      name: 'Ada',
      role: 'ROOT',
    });
    expect(result.success).toBe(false);
  });
});

describe('UpdateUserSchema', () => {
  test('drops a password an older client still sends', () => {
    expect(
      UpdateUserSchema.parse({ password: 'correct-horse-battery' }),
    ).toEqual({});
  });

  test('lower-cases a changed email', () => {
    expect(UpdateUserSchema.parse({ email: 'Grace@Example.com' }).email).toBe(
      'grace@example.com',
    );
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
