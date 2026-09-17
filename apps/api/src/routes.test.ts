import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import { adminApiRoutes, userApiRoutes } from './routes.js';
import {
  createApiRouteApp,
  defaultAuthUser,
} from './test/route-test-helpers.js';

const emptyDb = { phoneNumber: {}, user: {}, department: {} };

describe('route groups', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  test.each(['/message-senders', '/call-lines'])(
    'user routes reject requests without an authenticated user (%s)',
    async (url) => {
      app = await createApiRouteApp(userApiRoutes, { user: null, db: emptyDb });

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    },
  );

  test('the teammate list is for signed-in users only', async () => {
    app = await createApiRouteApp(userApiRoutes, { user: null, db: emptyDb });

    const response = await app.inject({ method: 'GET', url: '/teammates' });

    expect(response.statusCode).toBe(401);
  });

  test('admin routes reject users without the ADMIN role', async () => {
    app = await createApiRouteApp(adminApiRoutes, {
      user: { ...defaultAuthUser, role: 'AGENT' },
      db: emptyDb,
    });

    const response = await app.inject({ method: 'GET', url: '/stats' });

    expect(response.statusCode).toBe(403);
  });
});
