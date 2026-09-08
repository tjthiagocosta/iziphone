import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthUser } from '../../plugins/auth.js';
import { createApiRouteApp } from '../../test/route-test-helpers.js';
import departmentRoutes from './departments.js';

describe('departmentRoutes', () => {
  let app: FastifyInstance;

  const findMany = vi.fn(async () => []);
  const authenticatedUser: AuthUser = {
    id: 'user-7',
    email: 'agent@example.com',
    name: 'Agent Seven',
    role: 'AGENT',
    emailVerified: true,
  };

  beforeEach(async () => {
    findMany.mockClear();

    const authenticatedRoute: FastifyPluginAsync = async (fastify) => {
      fastify.addHook('preHandler', async (request) => {
        request.user = authenticatedUser;
      });

      await fastify.register(departmentRoutes);
    };

    app = await createApiRouteApp(authenticatedRoute, {
      user: authenticatedUser,
      db: {
        userDepartment: {
          findMany,
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test('should return the authenticated user departments mapped for the client', async () => {
    findMany.mockImplementation(async () => [
      {
        department: {
          id: 'dept-1',
          name: 'Support',
          phoneNumbers: [
            { phoneNumber: '+15555550101', isPrimary: true },
            { phoneNumber: '+15555550102', isPrimary: false },
          ],
        },
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-7',
        department: { deletedAt: null },
      },
      orderBy: { order: 'asc' },
      include: {
        department: {
          include: {
            phoneNumbers: {
              where: { status: 'ACTIVE', deletedAt: null },
              select: {
                phoneNumber: true,
                isPrimary: true,
              },
              orderBy: { isPrimary: 'desc' },
            },
          },
        },
      },
    });

    const body = response.json();

    expect(body.departments).toHaveLength(1);
    expect(body.departments[0]).toEqual({
      id: 'dept-1',
      name: 'Support',
      color: expect.any(String),
      phoneNumbers: [
        { number: '+15555550101', isDefault: true },
        { number: '+15555550102', isDefault: false },
      ],
    });
  });

  test('fails loudly when mounted without the authentication hook', async () => {
    await app.close();
    app = await createApiRouteApp(departmentRoutes, {
      user: null,
      db: {
        userDepartment: {
          findMany,
        },
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(500);
    expect(findMany).not.toHaveBeenCalled();
  });
});
