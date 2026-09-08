import * as repoEvents from '@repo/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthUser } from '../plugins/auth.js';
import {
  createApiRouteApp,
  defaultAuthUser,
} from '../test/route-test-helpers.js';
import callRoutes from './calls.js';

const agent: AuthUser = {
  id: 'user-7',
  email: 'agent@example.com',
  name: 'Agent Seven',
  role: 'AGENT',
  emailVerified: true,
};

const supervisor: AuthUser = { ...agent, id: 'user-8', role: 'SUPERVISOR' };

const include = {
  user: { select: { id: true, email: true } },
  department: { select: { id: true, name: true } },
};

const agentScope = {
  OR: [{ userId: 'user-7' }, { departmentId: { in: ['dept-1'] } }],
};

const storedCall = {
  id: 'call-1',
  conversationUuid: 'conversation-1',
  createdAt: '2026-03-20T00:00:00.000Z',
  user: { id: 'user-7', email: 'agent@example.com' },
  department: { id: 'dept-1', name: 'Support' },
};

describe('callRoutes', () => {
  let app: FastifyInstance;

  const transfer = vi.fn(async () => 1);
  const hold = vi.fn(async () => 1);
  const hangup = vi.fn(async () => 1);
  const findMany = vi.fn(async (): Promise<unknown[]> => []);
  const count = vi.fn(async () => 0);
  const findFirst = vi.fn(async (): Promise<unknown> => null);
  const findMemberships = vi.fn(async () => [{ departmentId: 'dept-1' }]);

  async function buildApp(user: AuthUser = defaultAuthUser) {
    vi.spyOn(repoEvents, 'createCommandPublisher').mockReturnValue({
      transfer,
      hold,
      hangup,
    });

    return createApiRouteApp(callRoutes, {
      user,
      db: {
        call: { findMany, count, findFirst },
        userDepartment: { findMany: findMemberships },
      },
      redis: {},
    });
  }

  beforeEach(async () => {
    findMany.mockResolvedValue([]);
    count.mockResolvedValue(0);
    findFirst.mockResolvedValue(storedCall);
    findMemberships.mockResolvedValue([{ departmentId: 'dept-1' }]);
    app = await buildApp(agent);
  });

  afterEach(async () => {
    await app.close();
  });

  test.each([
    {
      name: 'publishes a transfer command for a call the agent can see',
      url: '/api/calls/conversation-1/transfer',
      payload: { targetUserId: 'user-2' },
      expectedCall: () =>
        expect(transfer).toHaveBeenCalledWith({
          conversationUuid: 'conversation-1',
          targetUserId: 'user-2',
          initiatedBy: 'user-7',
        }),
      expectedBody: { success: true, message: 'Transfer command sent' },
    },
    {
      name: 'publishes a hold command for a call the agent can see',
      url: '/api/calls/conversation-1/hold',
      payload: { hold: true },
      expectedCall: () =>
        expect(hold).toHaveBeenCalledWith({
          conversationUuid: 'conversation-1',
          hold: true,
          initiatedBy: 'user-7',
        }),
      expectedBody: { success: true, message: 'Hold command sent' },
    },
    {
      name: 'publishes a hangup command for a call the agent can see',
      url: '/api/calls/conversation-1/hangup',
      payload: undefined,
      expectedCall: () =>
        expect(hangup).toHaveBeenCalledWith({
          conversationUuid: 'conversation-1',
          initiatedBy: 'user-7',
        }),
      expectedBody: { success: true, message: 'Hangup command sent' },
    },
  ])('$name', async ({ url, payload, expectedCall, expectedBody }) => {
    const response = await app.inject({ method: 'POST', url, payload });

    expect(response.statusCode).toBe(200);
    expect(findFirst).toHaveBeenCalledWith({
      where: { conversationUuid: 'conversation-1', ...agentScope },
      include,
    });
    expectedCall();
    expect(response.json()).toEqual(expectedBody);
  });

  test('answers 404 to a command on a call outside the agent scope', async () => {
    findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/calls/conversation-9/hangup',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Call not found' });
    expect(hangup).not.toHaveBeenCalled();
  });

  test('rejects a transfer without a target user before touching the database', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/calls/conversation-1/transfer',
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(findFirst).not.toHaveBeenCalled();
    expect(transfer).not.toHaveBeenCalled();
  });

  test('lists only the calls in the agent scope with default pagination', async () => {
    findMany.mockResolvedValue([storedCall]);
    count.mockResolvedValue(1);

    const response = await app.inject({ method: 'GET', url: '/api/calls' });

    expect(response.statusCode).toBe(200);
    expect(findMemberships).toHaveBeenCalledWith({
      where: { userId: 'user-7' },
      select: { departmentId: true },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: agentScope,
      take: 50,
      skip: 0,
      orderBy: { createdAt: 'desc' },
      include,
    });
    expect(count).toHaveBeenCalledWith({ where: agentScope });
    expect(response.json()).toEqual({
      calls: [storedCall],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  test('rejects a page size above the maximum', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/calls?limit=500',
    });

    expect(response.statusCode).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  test('lets a supervisor list and read every call', async () => {
    await app.close();
    app = await buildApp(supervisor);
    findMany.mockResolvedValue([storedCall]);
    count.mockResolvedValue(1);

    const list = await app.inject({
      method: 'GET',
      url: '/api/calls?limit=10&offset=20',
    });

    expect(list.statusCode).toBe(200);
    expect(findMemberships).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith({
      where: {},
      take: 10,
      skip: 20,
      orderBy: { createdAt: 'desc' },
      include,
    });

    const single = await app.inject({
      method: 'GET',
      url: '/api/calls/conversation-1',
    });

    expect(single.statusCode).toBe(200);
    expect(findFirst).toHaveBeenCalledWith({
      where: { conversationUuid: 'conversation-1' },
      include,
    });
    expect(single.json()).toEqual(storedCall);
  });

  test('answers 404 when a call record is outside the agent scope', async () => {
    findFirst.mockResolvedValue(null);

    const response = await app.inject({
      method: 'GET',
      url: '/api/calls/missing-conversation',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Call not found' });
  });
});
