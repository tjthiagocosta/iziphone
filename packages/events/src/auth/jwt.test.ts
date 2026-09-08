import { errors } from 'jose';
import { describe, expect, test } from 'vitest';
import { ZodError } from 'zod';
import { signJWT, verifyJWT } from './jwt.js';

const secret = 'test-secret-that-is-long-enough';
const claims = {
  sub: 'user-1',
  email: 'ada@example.com',
  role: 'AGENT',
} as const;

describe('signJWT / verifyJWT', () => {
  test('round-trips the user claims', async () => {
    const token = await signJWT(claims, secret);

    const verified = await verifyJWT(token, secret);

    expect(verified).toMatchObject(claims);
    expect(verified.exp).toBeGreaterThan(verified.iat);
  });

  test('rejects a token signed with another secret', async () => {
    const token = await signJWT(claims, 'someone-elses-secret');

    await expect(verifyJWT(token, secret)).rejects.toBeInstanceOf(
      errors.JWSSignatureVerificationFailed,
    );
  });

  test('rejects an expired token', async () => {
    const token = await signJWT(claims, secret, { expiresIn: '-1s' });

    await expect(verifyJWT(token, secret)).rejects.toBeInstanceOf(
      errors.JWTExpired,
    );
  });

  test('rejects a token whose claims do not match the contract', async () => {
    const token = await signJWT({ ...claims, role: 'ROOT' as 'AGENT' }, secret);

    await expect(verifyJWT(token, secret)).rejects.toBeInstanceOf(ZodError);
  });

  test('refuses to work with an empty secret', async () => {
    await expect(signJWT(claims, '')).rejects.toThrow(/secret/);
    await expect(verifyJWT('a.b.c', '')).rejects.toThrow(/secret/);
  });
});
