import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  TwilioNumberManagementService,
  type TwilioReadinessReport,
} from '../phone-numbers/index.js';
import { createApiRouteApp } from '../test/route-test-helpers.js';
import { healthRoutes } from './health.routes.js';

const readyReport: TwilioReadinessReport = {
  status: 'ok',
  timestamp: '2026-03-23T00:00:00.000Z',
  messagingTransport: 'messages-api',
  issues: [],
  warnings: [],
  account: {
    sid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    configured: true,
    reachable: true,
  },
  webhooks: {
    messagesInbound: 'https://api.example.com/webhooks/twilio/messages/inbound',
    voice: 'https://calls.example.com/webhooks/twilio/voice',
    voiceFallback: 'https://calls.example.com/webhooks/twilio/voice/fallback',
    voiceStatus: 'https://calls.example.com/webhooks/twilio/voice/status',
  },
  numbers: {
    checked: 1,
    misconfigured: [],
    reasons: {},
    notInAccount: [],
    untracked: 0,
    texting: {},
  },
};

const brokenReport: TwilioReadinessReport = {
  ...readyReport,
  status: 'error',
  issues: ['Twilio credentials are not configured'],
  account: { sid: null, configured: false, reachable: null },
  webhooks: null,
  numbers: { ...readyReport.numbers, checked: 0 },
};

describe('healthRoutes', () => {
  let app: FastifyInstance;

  const queryRaw = vi.fn(async () => 1);
  const ping = vi.fn(async () => 'PONG');
  const assertReady = vi.fn(async () => undefined);
  const listedNumbers = [{ phoneNumber: '+15555550101', type: 'LOCAL' }];
  const findMany = vi.fn(async () => listedNumbers);

  beforeEach(async () => {
    findMany.mockImplementation(async () => listedNumbers);
    queryRaw.mockImplementation(async () => 1);
    ping.mockImplementation(async () => 'PONG');
    assertReady.mockImplementation(async () => undefined);
    vi.spyOn(
      TwilioNumberManagementService.prototype,
      'hasAnyConfiguration',
    ).mockReturnValue(false);
    vi.spyOn(
      TwilioNumberManagementService.prototype,
      'getReadinessReport',
    ).mockResolvedValue(readyReport);

    app = await createApiRouteApp(healthRoutes, {
      db: { $queryRaw: queryRaw, phoneNumber: { findMany } },
      redis: { ping },
      mediaStore: { assertReady },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test('reports liveness publicly', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    const body = response.json();

    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.uptime).toBe('number');
  });

  test('reports a disconnected database without leaking the error', async () => {
    queryRaw.mockImplementation(async () => {
      throw new Error('connection to db.example.com refused');
    });

    const response = await app.inject({ method: 'GET', url: '/health/db' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'error',
      database: 'disconnected',
      timestamp: expect.any(String),
    });
    expect(response.body).not.toContain('db.example.com');
  });

  test('reports storage readiness without leaking the endpoint or credentials', async () => {
    const ready = await app.inject({ method: 'GET', url: '/health/storage' });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ok',
      storage: 'connected',
      timestamp: expect.any(String),
    });

    assertReady.mockImplementation(async () => {
      throw new Error(
        'AccessDenied at https://storage.example.com with key not-a-real-access-key',
      );
    });

    const unreachable = await app.inject({
      method: 'GET',
      url: '/health/storage',
    });

    expect(unreachable.statusCode).toBe(503);
    expect(unreachable.json()).toEqual({
      status: 'error',
      storage: 'disconnected',
      timestamp: expect.any(String),
    });
    expect(unreachable.body).not.toContain('storage.example.com');
    expect(unreachable.body).not.toContain('not-a-real');
  });

  test('keeps storage out of the public liveness check', async () => {
    assertReady.mockImplementation(async () => {
      throw new Error('bucket unreachable');
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(assertReady).not.toHaveBeenCalled();
  });

  test('reports degraded when storage is unavailable on the aggregated check', async () => {
    assertReady.mockImplementation(async () => {
      throw new Error('bucket unreachable');
    });

    const response = await app.inject({ method: 'GET', url: '/health/all' });

    expect(response.statusCode).toBe(503);
    expect(response.json().services).toEqual({
      database: 'connected',
      redis: 'connected',
      storage: 'disconnected',
      twilio: 'unknown',
    });
  });

  test('reports degraded when redis is unavailable on the aggregated check', async () => {
    ping.mockImplementation(async () => {
      throw new Error('redis unavailable');
    });

    const response = await app.inject({ method: 'GET', url: '/health/all' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'degraded',
      timestamp: expect.any(String),
      uptime: expect.any(Number),
      services: {
        database: 'connected',
        redis: 'disconnected',
        storage: 'connected',
        twilio: 'unknown',
      },
    });
  });

  test('returns the Twilio readiness report with 503 when it is not ok', async () => {
    vi.spyOn(
      TwilioNumberManagementService.prototype,
      'getReadinessReport',
    ).mockResolvedValue(brokenReport);

    const response = await app.inject({
      method: 'GET',
      url: '/health/twilio',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(brokenReport);
  });

  test('checks the numbers in the list, not every number on the account', async () => {
    const readiness = vi
      .spyOn(TwilioNumberManagementService.prototype, 'getReadinessReport')
      .mockResolvedValue(readyReport);

    const response = await app.inject({
      method: 'GET',
      url: '/health/twilio',
    });

    expect(response.statusCode).toBe(200);
    expect(readiness).toHaveBeenCalledWith(listedNumbers);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: null, status: { not: 'RELEASED' } },
      }),
    );
  });

  test('reports a list it could not read as an issue, and still checks the account', async () => {
    findMany.mockRejectedValue(new Error('connection refused'));
    const readiness = vi
      .spyOn(TwilioNumberManagementService.prototype, 'getReadinessReport')
      .mockResolvedValue(readyReport);

    const response = await app.inject({
      method: 'GET',
      url: '/health/twilio',
    });

    expect(response.statusCode).toBe(503);
    expect(readiness).toHaveBeenCalledWith([]);
    expect(response.json()).toMatchObject({
      status: 'error',
      issues: [
        'The list of numbers could not be read, so no number was checked.',
      ],
    });
  });

  test('includes Twilio readiness in the aggregated check when configured', async () => {
    vi.spyOn(
      TwilioNumberManagementService.prototype,
      'hasAnyConfiguration',
    ).mockReturnValue(true);
    vi.spyOn(
      TwilioNumberManagementService.prototype,
      'getReadinessReport',
    ).mockResolvedValue({
      ...readyReport,
      status: 'error',
      issues: ['+15555550101 needs Reconnect: a TwiML App takes its calls'],
      numbers: {
        ...readyReport.numbers,
        misconfigured: ['+15555550101'],
        reasons: { '+15555550101': ['voice-application'] },
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health/all' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'degraded',
      timestamp: expect.any(String),
      uptime: expect.any(Number),
      services: {
        database: 'connected',
        redis: 'connected',
        storage: 'connected',
        twilio: 'disconnected',
      },
    });
  });

  test('keeps the detailed checks behind an admin session', async () => {
    const anonymous = await createApiRouteApp(healthRoutes, {
      db: { $queryRaw: queryRaw, phoneNumber: { findMany } },
      redis: { ping },
      mediaStore: { assertReady },
      user: null,
    });

    expect((await anonymous.inject({ url: '/health' })).statusCode).toBe(200);

    for (const url of [
      '/health/db',
      '/health/redis',
      '/health/storage',
      '/health/twilio',
      '/health/all',
    ]) {
      expect((await anonymous.inject({ url })).statusCode).toBe(401);
    }

    await anonymous.close();
  });
});
