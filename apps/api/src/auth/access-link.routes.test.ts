import type { PrismaClient } from '@repo/db';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { InMemoryMailer } from '../mail/index.js';
import { createApiRouteApp } from '../test/route-test-helpers.js';
import { hashAccessToken } from './access-link.js';
import { accessLinkRoutes } from './access-link.routes.js';
import { authRoutes } from './auth.routes.js';
import type { Auth } from './better-auth.js';

const TOKEN = 'a-fictional-access-token';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

/** A stored link, as the service reads it back. */
function storedLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'token-1',
    purpose: 'INVITE',
    expiresAt: FUTURE,
    consumedAt: null,
    userId: 'user-1',
    user: { email: 'new@example.com', deletedAt: null },
    ...overrides,
  };
}

function fakeDb(
  overrides: Record<string, unknown> = {},
): Partial<PrismaClient> {
  const db = {
    setPasswordToken: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({})),
    },
    account: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({})),
    },
    session: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    user: { findFirst: vi.fn(async () => null) },
    ...overrides,
  } as Record<string, unknown>;

  db.$transaction = async (run: (tx: unknown) => unknown) => run(db);

  return db as Partial<PrismaClient>;
}

function signInStub(cookie: string | null) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (cookie) {
    headers.append('set-cookie', cookie);
  }

  return vi.fn(async () => new Response('{}', { status: 200, headers }));
}

function authWith(signInEmail: unknown): Partial<Auth> {
  return { api: { signInEmail } } as unknown as Partial<Auth>;
}

/**
 * Lets the work `forgot-password` started but did not wait for finish. The
 * fake database and the in-memory mailer resolve at once, so one turn of the
 * event loop is enough and nothing here depends on a timer.
 */
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('accessLinkRoutes', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('POST /api/auth/forgot-password', () => {
    test('answers the same for an address with an account and one without', async () => {
      const mailer = new InMemoryMailer();
      app = await createApiRouteApp(accessLinkRoutes, {
        db: fakeDb({ user: { findFirst: vi.fn(async () => null) } }),
        mailer,
      });

      const unknown = await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: 'stranger@example.com' },
      });

      await app.close();

      const known = fakeDb({
        user: {
          findFirst: vi.fn(async () => ({
            id: 'user-1',
            email: 'agent@example.com',
            name: 'Agent One',
            accounts: [{ password: 'an-existing-bcrypt-hash' }],
          })),
        },
      });
      app = await createApiRouteApp(accessLinkRoutes, { db: known, mailer });

      const existing = await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: 'agent@example.com' },
      });

      await settled();

      expect(unknown.statusCode).toBe(200);
      expect(existing.statusCode).toBe(200);
      expect(existing.json()).toEqual(unknown.json());
      // The difference is only that one of them actually sent something.
      expect(mailer.sent).toHaveLength(1);
    });

    test('lowercases the address before looking it up', async () => {
      const findFirst = vi.fn(async () => null);
      app = await createApiRouteApp(accessLinkRoutes, {
        db: fakeDb({ user: { findFirst } }),
      });

      await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: 'Agent.One@Example.com' },
      });

      await settled();

      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'agent.one@example.com', deletedAt: null },
        }),
      );
    });

    test('answers without waiting for the mail server', async () => {
      // Never resolves: a mail server that hangs must not hold the answer,
      // which is also what keeps the timing the same for every address.
      const mailer = {
        send: vi.fn(() => new Promise<never>(() => {})),
      };
      app = await createApiRouteApp(accessLinkRoutes, {
        db: fakeDb({
          user: {
            findFirst: vi.fn(async () => ({
              id: 'user-1',
              email: 'agent@example.com',
              name: 'Agent One',
              accounts: [{ password: 'an-existing-bcrypt-hash' }],
            })),
          },
        }),
        mailer: mailer as never,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: 'agent@example.com' },
      });

      expect(response.statusCode).toBe(200);

      await settled();

      expect(mailer.send).toHaveBeenCalledTimes(1);
    });

    test('rejects a body that is not an address', async () => {
      app = await createApiRouteApp(accessLinkRoutes, { db: fakeDb() });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: 'not-an-address' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/auth/set-password/:token', () => {
    test('reports a live link and what it is for', async () => {
      const findUnique = vi.fn(async () => storedLink());
      app = await createApiRouteApp(accessLinkRoutes, {
        db: fakeDb({
          setPasswordToken: { findUnique, updateMany: vi.fn() },
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/auth/set-password/${TOKEN}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        valid: true,
        purpose: 'INVITE',
        message: null,
      });
      // Looked up by hash: the raw token is never stored.
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tokenHash: hashAccessToken(TOKEN) },
        }),
      );
    });

    test('reports a dead link without saying whose it was', async () => {
      app = await createApiRouteApp(accessLinkRoutes, {
        db: fakeDb({
          setPasswordToken: {
            findUnique: vi.fn(async () =>
              storedLink({ consumedAt: new Date('2026-09-18T00:00:00Z') }),
            ),
            updateMany: vi.fn(),
          },
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/auth/set-password/${TOKEN}`,
      });

      const body = response.json() as { valid: boolean; message: string };

      expect(response.statusCode).toBe(200);
      expect(body.valid).toBe(false);
      expect(body.message).not.toContain('new@example.com');
    });

    test('keeps the token out of the request log', async () => {
      const lines: string[] = [];
      app = await createApiRouteApp(accessLinkRoutes, {
        db: fakeDb(),
        logger: {
          level: 'info',
          stream: {
            write(line: string) {
              lines.push(line);
            },
          },
        },
      });

      await app.inject({
        method: 'GET',
        url: `/api/auth/set-password/${TOKEN}`,
      });
      await app.inject({
        method: 'POST',
        url: '/api/auth/forgot-password',
        payload: { email: 'agent@example.com' },
      });

      // Fastify logs every request URL at info, and here the URL is the secret.
      // The second request proves the logger was recording all along.
      const log = lines.join('\n');

      expect(log).toContain('forgot-password');
      expect(log).not.toContain(TOKEN);
    });
  });

  describe('POST /api/auth/set-password', () => {
    test('sets the password and answers with the session cookie', async () => {
      const signInEmail = signInStub(
        'iziphone.session_token=token; Path=/; HttpOnly',
      );
      const db = fakeDb({
        setPasswordToken: {
          findUnique: vi.fn(async () => storedLink()),
          updateMany: vi.fn(async () => ({ count: 1 })),
        },
      });
      app = await createApiRouteApp(accessLinkRoutes, {
        db,
        auth: authWith(signInEmail),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token: TOKEN, password: 'a-fictional-passphrase' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(response.headers['set-cookie']).toEqual([
        'iziphone.session_token=token; Path=/; HttpOnly',
      ]);
      expect(signInEmail).toHaveBeenCalledWith({
        body: { email: 'new@example.com', password: 'a-fictional-passphrase' },
        asResponse: true,
      });
    });

    test('refuses a dead link with its message and no cookie', async () => {
      app = await createApiRouteApp(accessLinkRoutes, {
        db: fakeDb({
          setPasswordToken: {
            findUnique: vi.fn(async () => null),
            updateMany: vi.fn(),
          },
        }),
        auth: authWith(signInStub('iziphone.session_token=token')),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token: TOKEN, password: 'a-fictional-passphrase' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((response.json() as { message: string }).message).toMatch(
        /not valid/,
      );
    });

    test('still reports success when the sign-in afterwards is refused', async () => {
      // The password is set and the old sessions are gone either way; the
      // browser just has to sign in by hand.
      const signInEmail = vi.fn(
        async () => new Response('{}', { status: 401 }),
      );
      app = await createApiRouteApp(accessLinkRoutes, {
        db: fakeDb({
          setPasswordToken: {
            findUnique: vi.fn(async () => storedLink()),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
        }),
        auth: authWith(signInEmail),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token: TOKEN, password: 'a-fictional-passphrase' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    test('rejects a password that is too short', async () => {
      app = await createApiRouteApp(accessLinkRoutes, { db: fakeDb() });

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/set-password',
        payload: { token: TOKEN, password: 'short' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('next to the Better Auth wildcard', () => {
    test('keeps its own routes off the `/api/auth/*` handler', async () => {
      // `authRoutes` forwards everything under /api/auth to Better Auth, which
      // knows nothing about these three paths.
      const handler = vi.fn(async () => new Response('{}', { status: 200 }));
      const both: FastifyPluginAsync = async (fastify) => {
        await fastify.register(accessLinkRoutes);
        await fastify.register(authRoutes);
      };

      app = await createApiRouteApp(both, {
        db: fakeDb({
          setPasswordToken: {
            findUnique: vi.fn(async () => storedLink()),
            updateMany: vi.fn(async () => ({ count: 1 })),
          },
        }),
        auth: { handler, ...authWith(signInStub(null)) },
      });

      const described = await app.inject({
        method: 'GET',
        url: `/api/auth/set-password/${TOKEN}`,
      });
      const forwarded = await app.inject({
        method: 'GET',
        url: '/api/auth/session',
      });

      expect(described.json()).toEqual({
        valid: true,
        purpose: 'INVITE',
        message: null,
      });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(forwarded.statusCode).toBe(200);
    });
  });
});
