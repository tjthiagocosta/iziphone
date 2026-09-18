import { describe, expect, test } from 'vitest';
import {
  AccessLinkResponseSchema,
  ForgotPasswordSchema,
  SetPasswordLinkSchema,
  SetPasswordSchema,
} from './access-link.schemas.js';

describe('ForgotPasswordSchema', () => {
  test('lower-cases the address before it is looked up', () => {
    expect(ForgotPasswordSchema.parse({ email: ' Ada@Example.com ' })).toEqual({
      email: 'ada@example.com',
    });
  });

  test('rejects anything that is not an address', () => {
    expect(ForgotPasswordSchema.safeParse({ email: 'ada' }).success).toBe(
      false,
    );
  });
});

describe('SetPasswordSchema', () => {
  test('accepts a token and a password that meets the policy', () => {
    expect(
      SetPasswordSchema.parse({
        token: 'a-fictional-token',
        password: 'correct-horse-battery',
      }),
    ).toEqual({
      token: 'a-fictional-token',
      password: 'correct-horse-battery',
    });
  });

  test.each([
    ['', 'correct-horse-battery'],
    ['a-fictional-token', 'short'],
    ['a-fictional-token', 'x'.repeat(129)],
  ])('rejects token=%j password length=%s', (token, password) => {
    expect(SetPasswordSchema.safeParse({ token, password }).success).toBe(
      false,
    );
  });
});

describe('AccessLinkResponseSchema', () => {
  test('carries the link, its expiry and whether the email went out', () => {
    const parsed = AccessLinkResponseSchema.parse({
      purpose: 'INVITE',
      url: 'https://app.example.com/set-password?token=a-fictional-token',
      expiresAt: '2026-09-25T08:00:00.000Z',
      emailSent: false,
      emailError: 'Email is not configured',
    });
    expect(parsed.emailSent).toBe(false);
  });

  test('refuses a link that is not a URL', () => {
    expect(
      AccessLinkResponseSchema.safeParse({
        purpose: 'RESET',
        url: 'not-a-url',
        expiresAt: '2026-09-25T08:00:00.000Z',
        emailSent: true,
        emailError: null,
      }).success,
    ).toBe(false);
  });
});

describe('SetPasswordLinkSchema', () => {
  test('a dead link names no purpose and carries a message instead', () => {
    expect(
      SetPasswordLinkSchema.parse({
        valid: false,
        purpose: null,
        message: 'This link has expired.',
      }).purpose,
    ).toBeNull();
  });
});
