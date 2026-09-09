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

  test('user routes reject requests without an authenticated user', async () => {
    app = await createApiRouteApp(userApiRoutes, { user: null, db: emptyDb });

    const response = await app.inject({
      method: 'GET',
      url: '/message-senders',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
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
