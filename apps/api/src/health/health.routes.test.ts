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
  account: {
    sid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    configured: true,
    reachable: true,
  },
  webhooks: {
    messagesInbound: 'https://api.example.com/webhooks/twilio/messages/inbound',
    messagesStatus: 'https://api.example.com/webhooks/twilio/messages/status',
    voice: 'https://calls.example.com/webhooks/twilio/voice',
    voiceFallback: 'https://calls.example.com/webhooks/twilio/voice/fallback',
  },
  numbers: { checked: 1, misconfigured: [] },
};

const brokenReport: TwilioReadinessReport = {
  ...readyReport,
  status: 'error',
  issues: ['Twilio credentials are not configured'],
  account: { sid: null, configured: false, reachable: null },
  webhooks: null,
  numbers: { checked: 0, misconfigured: [] },
};

describe('healthRoutes', () => {
  let app: FastifyInstance;

  const queryRaw = vi.fn(async () => 1);
  const ping = vi.fn(async () => 'PONG');
  const assertReady = vi.fn(async () => undefined);

  beforeEach(async () => {
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
      db: { $queryRaw: queryRaw },
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
      issues: ['1 owned number does not point at this deployment'],
      numbers: { checked: 1, misconfigured: ['+15555550101'] },
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
      db: { $queryRaw: queryRaw },
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
