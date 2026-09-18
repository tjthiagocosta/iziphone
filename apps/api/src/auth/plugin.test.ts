import type { PrismaClient } from '@repo/db';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { testApiConfig } from '../test/route-test-helpers.js';
import { authPlugin } from './plugin.js';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('./better-auth.js', () => ({
  createAuth: () => ({ api: { getSession } }),
}));

/** `authPlugin` declares a dependency on the Prisma plugin by name. */
const fakePrismaPlugin = fp(
  async (fastify: FastifyInstance) => {
    fastify.decorate('db', {} as PrismaClient);
  },
  { name: 'prisma' },
);

function sessionFor(role: 'AGENT' | 'SUPERVISOR' | 'ADMIN') {
  return {
    session: {
      id: 'session-1',
      userId: 'user-1',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      token: 'token-1',
    },
    user: {
      id: 'user-1',
      email: 'agent@example.com',
      name: 'Agent One',
      role,
      emailVerified: true,
    },
  };
}

interface GuardApp {
  app: FastifyInstance;
  /** Which route handlers actually ran. */
  handled: string[];
}

/**
 * The real plugin, with only Better Auth's session lookup faked.
 *
 * `deferResponses` adds an `onSend` hook that awaits something, as a
 * compression or response-logging hook does. That is what turns a guard which
 * answers without returning the reply into "the handler ran anyway": the
 * response is no longer written by the time the guard returns, so Fastify
 * carries on to the handler and the refused request is served after all.
 */
async function buildGuardApp(
  { deferResponses } = { deferResponses: false },
): Promise<GuardApp> {
  const app = Fastify({ logger: false });
  const handled: string[] = [];

  app.decorate('config', testApiConfig);

  await app.register(fakePrismaPlugin);
  await app.register(authPlugin);

  if (deferResponses) {
    app.addHook('onSend', async (_request, _reply, payload) => {
      await new Promise((resolve) => setImmediate(resolve));
      return payload;
    });
  }

  app.get('/private', { preHandler: [app.requireAuth] }, async () => {
    handled.push('private');
    return { ok: true };
  });

  app.post(
    '/admin',
    { preHandler: [app.requireRole(['ADMIN'])] },
    async (request) => {
      handled.push('admin');
      return { by: request.user?.id ?? null };
    },
  );

  await app.ready();

  return { app, handled };
}

describe('the auth guards', () => {
  let guard: GuardApp | undefined;

  afterEach(async () => {
    await guard?.app.close();
    guard = undefined;
  });

  describe('requireAuth', () => {
    test('answers 401 and stops the handler when there is no session', async () => {
      getSession.mockResolvedValue(null);
      guard = await buildGuardApp();

      const response = await guard.app.inject({
        method: 'GET',
        url: '/private',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      expect(guard.handled).toEqual([]);
    });

    test('still stops the handler when an async onSend hook defers the response', async () => {
      getSession.mockResolvedValue(null);
      guard = await buildGuardApp({ deferResponses: true });

      const response = await guard.app.inject({
        method: 'GET',
        url: '/private',
      });

      expect(response.statusCode).toBe(401);
      expect(guard.handled).toEqual([]);
    });

    test('refuses a session Better Auth returns in an unexpected shape', async () => {
      getSession.mockResolvedValue({
        session: { id: 'session-1' },
        user: { id: 'user-1', role: 'OWNER' },
      });
      guard = await buildGuardApp({ deferResponses: true });

      const response = await guard.app.inject({
        method: 'GET',
        url: '/private',
      });

      expect(response.statusCode).toBe(401);
      expect(guard.handled).toEqual([]);
    });

    test('lets a signed-in user through', async () => {
      getSession.mockResolvedValue(sessionFor('AGENT'));
      guard = await buildGuardApp({ deferResponses: true });

      const response = await guard.app.inject({
        method: 'GET',
        url: '/private',
      });

      expect(response.statusCode).toBe(200);
      expect(guard.handled).toEqual(['private']);
    });
  });

  describe('requireRole', () => {
    test('answers 403 and stops the handler for a role that is not allowed', async () => {
      getSession.mockResolvedValue(sessionFor('AGENT'));
      guard = await buildGuardApp();

      const response = await guard.app.inject({
        method: 'POST',
        url: '/admin',
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'Forbidden',
        message: 'Required role: ADMIN',
      });
      expect(guard.handled).toEqual([]);
    });

    test('still stops the handler when an async onSend hook defers the response', async () => {
      getSession.mockResolvedValue(sessionFor('AGENT'));
      guard = await buildGuardApp({ deferResponses: true });

      const response = await guard.app.inject({
        method: 'POST',
        url: '/admin',
      });

      expect(response.statusCode).toBe(403);
      expect(guard.handled).toEqual([]);
    });

    test('answers 401 and stops the handler when there is no session', async () => {
      getSession.mockResolvedValue(null);
      guard = await buildGuardApp({ deferResponses: true });

      const response = await guard.app.inject({
        method: 'POST',
        url: '/admin',
      });

      expect(response.statusCode).toBe(401);
      expect(guard.handled).toEqual([]);
    });

    test('lets an admin through', async () => {
      getSession.mockResolvedValue(sessionFor('ADMIN'));
      guard = await buildGuardApp({ deferResponses: true });

      const response = await guard.app.inject({
        method: 'POST',
        url: '/admin',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ by: 'user-1' });
      expect(guard.handled).toEqual(['admin']);
    });
  });
});
