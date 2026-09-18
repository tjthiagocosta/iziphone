import { ROUTING_CACHE } from '@repo/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiRouteApp } from '../test/route-test-helpers.js';
import { internalRoutingRoutes } from './internal.routes.js';

const DEPARTMENT_LINE = '+15555550101';
const DIRECT_LINE = '+15555550102';

describe('internalRoutingRoutes', () => {
  let app: FastifyInstance;

  const phoneFindFirst = vi.fn(async () => null);
  const departmentFindMany = vi.fn(async () => []);
  const phoneFindMany = vi.fn(async () => []);
  const pipelineSet = vi.fn();
  const pipelineExec = vi.fn(async () => []);

  beforeEach(async () => {
    phoneFindFirst.mockClear();
    departmentFindMany.mockClear();
    phoneFindMany.mockClear();
    pipelineSet.mockClear();
    pipelineExec.mockClear();

    const pipeline = { set: pipelineSet, del: vi.fn(), exec: pipelineExec };
    pipelineSet.mockReturnValue(pipeline);

    app = await createApiRouteApp(internalRoutingRoutes, {
      db: {
        phoneNumber: { findFirst: phoneFindFirst, findMany: phoneFindMany },
        department: { findMany: departmentFindMany },
      },
      redis: { pipeline: () => pipeline },
      user: null,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test('should return and cache department routing by phone number', async () => {
    phoneFindFirst.mockImplementation(async () => ({
      department: {
        id: 'dept-1',
        name: 'Support',
        deletedAt: null,
        users: [
          { userId: 'user-1', order: 0 },
          { userId: 'user-2', order: 1 },
        ],
        settings: {
          timezone: 'America/Sao_Paulo',
          is24Hours: false,
          openHoursRoutingType: 'FIXED_ORDER',
          ringDuration: 20,
          closedHoursRoutingType: 'VOICEMAIL',
          closedHoursExternalNumber: null,
          voicemailGreetingId: null,
          voicemailGreetingKey: null,
        },
        businessHours: [
          { dayOfWeek: 1, isOpen: true, openTime: '09:00', closeTime: '18:00' },
        ],
        holidays: [],
      },
      user: null,
    }));

    const response = await app.inject({
      method: 'GET',
      url: `/internal/routing/by-phone/${encodeURIComponent(DEPARTMENT_LINE)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: 'DEPARTMENT',
      departmentId: 'dept-1',
      departmentName: 'Support',
      userIds: ['user-1', 'user-2'],
      orderedUsers: [
        { userId: 'user-1', order: 0 },
        { userId: 'user-2', order: 1 },
      ],
      cachedAt: expect.any(String),
    });
    expect(pipelineSet.mock.calls.map((args) => args[0])).toEqual([
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DEPARTMENT_LINE}`,
      `${ROUTING_CACHE.DEPARTMENT_ID_KEY_PREFIX}dept-1`,
    ]);
    expect(pipelineExec).toHaveBeenCalledTimes(1);
  });

  test('should return and cache direct-line routing for a user-assigned number', async () => {
    phoneFindFirst.mockImplementation(async () => ({
      department: null,
      user: { id: 'user-9', name: 'Agent Nine', deletedAt: null },
    }));

    const response = await app.inject({
      method: 'GET',
      url: `/internal/routing/by-phone/${encodeURIComponent(DIRECT_LINE)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      type: 'USER',
      userIds: ['user-9'],
      userId: 'user-9',
      userName: 'Agent Nine',
      cachedAt: expect.any(String),
    });
    expect(pipelineSet).toHaveBeenCalledTimes(1);
    expect(pipelineSet.mock.calls[0]?.[0]).toBe(
      `${ROUTING_CACHE.PHONE_KEY_PREFIX}${DIRECT_LINE}`,
    );
  });

  test('should return 404 when a phone number exists but is not assigned', async () => {
    phoneFindFirst.mockImplementation(async () => ({
      department: null,
      user: {
        id: 'user-11',
        name: 'Deleted User',
        deletedAt: new Date('2026-03-20T00:00:00.000Z'),
      },
    }));

    const response = await app.inject({
      method: 'GET',
      url: '/internal/routing/by-phone/%2B15555550103',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Phone number not assigned to any department or user',
    });
    expect(pipelineSet).not.toHaveBeenCalled();
  });

  test('should warm department and user routing caches through the refresh endpoint', async () => {
    departmentFindMany.mockImplementation(async () => [
      {
        id: 'dept-1',
        name: 'Support',
        deletedAt: null,
        users: [{ userId: 'user-1', order: 0 }],
        phoneNumbers: [
          { phoneNumber: DEPARTMENT_LINE },
          { phoneNumber: '+15555550104' },
        ],
        settings: null,
        businessHours: [],
        holidays: [],
      },
    ]);
    phoneFindMany.mockImplementation(async () => [
      { phoneNumber: DIRECT_LINE, user: { id: 'user-2', name: 'Agent Two' } },
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/internal/routing/refresh-cache',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      departments: 1,
      users: 1,
    });
    expect(pipelineSet).toHaveBeenCalledTimes(4);
  });

  test('should no longer serve the deprecated department routes', async () => {
    const byPhone = await app.inject({
      method: 'GET',
      url: '/internal/departments/by-phone/%2B15555550101',
    });
    const refresh = await app.inject({
      method: 'POST',
      url: '/internal/departments/refresh-cache',
    });

    expect(byPhone.statusCode).toBe(404);
    expect(refresh.statusCode).toBe(404);
  });
});
