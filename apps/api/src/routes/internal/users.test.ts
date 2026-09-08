import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiRouteApp } from '../../test/route-test-helpers.js';
import internalUserRoutes from './users.js';

describe('internalUserRoutes', () => {
  let app: FastifyInstance;

  const findFirst = vi.fn(async () => null);
  const update = vi.fn(async () => undefined);

  beforeEach(async () => {
    findFirst.mockClear();
    update.mockClear();

    app = await createApiRouteApp(internalUserRoutes, {
      db: {
        user: {
          findFirst,
          update,
        },
      },
      user: null,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test('should sync the telephony user id for an existing user', async () => {
    findFirst.mockImplementation(async () => ({
      id: 'user-1',
      deletedAt: null,
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/internal/users/user-1/telephony',
      payload: {
        telephonyUserId: 'twilio-user-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        telephonyUserId: 'twilio-user-1',
      },
    });
    expect(response.json()).toEqual({
      userId: 'user-1',
      telephonyUserId: 'twilio-user-1',
    });
  });

  test('should return 404 when the target user does not exist', async () => {
    findFirst.mockImplementation(async () => null);

    const response = await app.inject({
      method: 'POST',
      url: '/internal/users/missing-user/telephony',
      payload: {
        telephonyUserId: 'twilio-user-404',
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'User not found',
    });
    expect(update).not.toHaveBeenCalled();
  });

  test('should reject a body without a telephony user id', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/users/user-1/telephony',
      payload: { telephonyUserId: '   ' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Bad Request' });
    expect(findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
