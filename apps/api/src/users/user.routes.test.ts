import { TeammatesResponseSchema } from '@repo/dto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthUser } from '../auth/index.js';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../test/route-test-helpers.js';
import { userTeammateRoutes } from './user.routes.js';

const agent: AuthUser = {
  id: 'user-7',
  email: 'agent@example.com',
  name: 'Agent Seven',
  role: 'AGENT',
  emailVerified: true,
};

describe('userTeammateRoutes', () => {
  let app: FastifyInstance;
  const findMany = vi.fn(async (): Promise<unknown[]> => []);

  beforeEach(async () => {
    app = await createApiRouteApp(
      withAuthenticatedUser(userTeammateRoutes, agent),
      { user: agent, db: { user: { findMany } } },
    );
  });

  afterEach(async () => {
    await app.close();
  });

  test('asks for every user who is not deleted, except the one asking', async () => {
    await app.inject({ method: 'GET', url: '/' });

    expect(findMany).toHaveBeenCalledWith({
      where: { id: { not: 'user-7' }, deletedAt: null },
      select: {
        id: true,
        name: true,
        email: true,
        departments: {
          where: { department: { deletedAt: null } },
          orderBy: { order: 'asc' },
          select: { department: { select: { name: true } } },
        },
      },
    });
  });

  test('lists teammates by name with the departments they belong to', async () => {
    findMany.mockResolvedValue([
      {
        id: 'user-9',
        name: 'Morgan Reyes',
        email: 'morgan@example.com',
        departments: [
          { department: { name: 'Support' } },
          { department: { name: 'Billing' } },
        ],
      },
      {
        id: 'user-8',
        name: 'Avery Stone',
        email: 'avery@example.com',
        departments: [],
      },
    ]);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      teammates: [
        { id: 'user-8', name: 'Avery Stone', departments: [] },
        {
          id: 'user-9',
          name: 'Morgan Reyes',
          departments: ['Support', 'Billing'],
        },
      ],
    });
    expect(() => TeammatesResponseSchema.parse(response.json())).not.toThrow();
  });

  test('calls a teammate without a name by their email, and tells nothing else about them', async () => {
    findMany.mockResolvedValue([
      {
        id: 'user-8',
        name: '  ',
        email: 'avery@example.com',
        departments: [],
      },
      {
        id: 'user-9',
        name: null,
        email: 'morgan@example.com',
        departments: [],
      },
    ]);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.json()).toEqual({
      teammates: [
        { id: 'user-8', name: 'avery@example.com', departments: [] },
        { id: 'user-9', name: 'morgan@example.com', departments: [] },
      ],
    });
  });
});
