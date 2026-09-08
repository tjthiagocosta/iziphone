import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiRouteApp } from '../test/route-test-helpers.js';
import sessionRoutes from './sessions.js';

describe('sessionRoutes', () => {
  let app: FastifyInstance;

  const findMany = vi.fn(async () => []);
  const findFirst = vi.fn(async () => null);
  const deleteSession = vi.fn(async () => undefined);
  const deleteMany = vi.fn(async () => ({ count: 0 }));

  beforeEach(async () => {
    findMany.mockClear();
    findFirst.mockClear();
    deleteSession.mockClear();
    deleteMany.mockClear();

    app = await createApiRouteApp(sessionRoutes, {
      db: {
        session: {
          findMany,
          findFirst,
          delete: deleteSession,
          deleteMany,
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test('lists the sessions of the authenticated user and marks the current one', async () => {
    findMany.mockImplementation(async () => [
      {
        id: 'session-1',
        createdAt: new Date('2026-03-19T10:00:00.000Z'),
        expiresAt: new Date('2026-03-26T10:00:00.000Z'),
        ipAddress: '127.0.0.1',
        userAgent: 'Test Client',
      },
      {
        id: 'session-2',
        createdAt: new Date('2026-03-18T10:00:00.000Z'),
        expiresAt: new Date('2026-03-25T10:00:00.000Z'),
        ipAddress: '10.0.0.2',
        userAgent: 'Other Client',
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/sessions',
    });

    expect(response.statusCode).toBe(200);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        expiresAt: true,
        ipAddress: true,
        userAgent: true,
      },
    });
    expect(response.json()).toEqual({
      sessions: [
        {
          id: 'session-1',
          createdAt: '2026-03-19T10:00:00.000Z',
          expiresAt: '2026-03-26T10:00:00.000Z',
          ipAddress: '127.0.0.1',
          userAgent: 'Test Client',
          isCurrent: true,
        },
        {
          id: 'session-2',
          createdAt: '2026-03-18T10:00:00.000Z',
          expiresAt: '2026-03-25T10:00:00.000Z',
          ipAddress: '10.0.0.2',
          userAgent: 'Other Client',
          isCurrent: false,
        },
      ],
    });
  });

  test('should return 404 when revoking a session that does not belong to the user', async () => {
    findFirst.mockImplementation(async () => null);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/session-404',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Session not found',
    });
    expect(deleteSession).not.toHaveBeenCalled();
  });

  test('revokes a session that belongs to the user', async () => {
    findFirst.mockImplementation(async () => ({ id: 'session-2' }));

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/session-2',
    });

    expect(response.statusCode).toBe(200);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'session-2', userId: 'user-1' },
    });
    expect(deleteSession).toHaveBeenCalledWith({ where: { id: 'session-2' } });
    expect(response.json()).toEqual({ success: true });
  });

  test('should revoke all sessions and return the number of revoked records', async () => {
    deleteMany.mockImplementation(async () => ({ count: 3 }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/revoke-all',
    });

    expect(response.statusCode).toBe(200);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(response.json()).toEqual({
      success: true,
      revokedCount: 3,
    });
  });
});
