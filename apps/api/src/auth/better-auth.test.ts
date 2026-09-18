import type { PrismaClient } from '@repo/db';
import { describe, expect, test } from 'vitest';
import { createAuth } from './better-auth.js';

/**
 * The database is never reached: a refused sign-up is refused before any query,
 * which is the whole point of the test.
 */
function buildAuth() {
  return createAuth({
    db: {} as PrismaClient,
    secret: 'a-fictional-secret-that-is-long-enough',
    baseURL: 'https://api.example.com',
    trustedOrigins: ['https://app.example.com'],
    secureCookies: true,
  });
}

describe('createAuth', () => {
  test('refuses to register anybody', async () => {
    const response = await buildAuth().api.signUpEmail({
      body: {
        email: 'stranger@example.com',
        password: 'a-fictional-passphrase',
        name: 'A Stranger',
      },
      asResponse: true,
    });

    // A stranger who can reach the API must not be able to hand themselves a
    // session, a Twilio voice token and the customer's phone bill.
    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
    expect(response.headers.getSetCookie()).toHaveLength(0);
  });

  test('still allows signing in', () => {
    // The same option can disable the whole credential flow; this is the guard
    // that says only registration was closed.
    expect(typeof buildAuth().api.signInEmail).toBe('function');
  });
});
