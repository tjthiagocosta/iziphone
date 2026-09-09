import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiRouteApp } from '../test/route-test-helpers.js';
import { adminStatsRoutes } from './stats.routes.js';

describe('adminStatsRoutes', () => {
  let app: FastifyInstance;

  const userCount = vi.fn(async () => 0);
  const departmentCount = vi.fn(async () => 0);
  const phoneNumberCount = vi.fn(async () => 0);

  beforeEach(async () => {
    userCount.mockClear();
    departmentCount.mockClear();
    phoneNumberCount.mockClear();

    userCount
      .mockImplementationOnce(async () => 10)
      .mockImplementationOnce(async () => 2)
      .mockImplementationOnce(async () => 1)
      .mockImplementationOnce(async () => 3)
      .mockImplementationOnce(async () => 6);
    departmentCount
      .mockImplementationOnce(async () => 4)
      .mockImplementationOnce(async () => 1);
    phoneNumberCount
      .mockImplementationOnce(async () => 7)
      .mockImplementationOnce(async () => 5)
      .mockImplementationOnce(async () => 1)
      .mockImplementationOnce(async () => 1)
      .mockImplementationOnce(async () => 6)
      .mockImplementationOnce(async () => 1);

    app = await createApiRouteApp(adminStatsRoutes, {
      db: {
        user: { count: userCount },
        department: { count: departmentCount },
        phoneNumber: { count: phoneNumberCount },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test('should aggregate dashboard counts into the admin stats response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      users: {
        total: 10,
        active: 10,
        deleted: 2,
        byRole: {
          admin: 1,
          supervisor: 3,
          agent: 6,
        },
      },
      departments: {
        total: 4,
        active: 4,
        deleted: 1,
      },
      phoneNumbers: {
        total: 7,
        active: 5,
        reserved: 1,
        released: 1,
        byType: {
          local: 6,
          tollFree: 1,
        },
      },
    });
  });
});
