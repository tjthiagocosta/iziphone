import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createControllerRouteApp } from '../test/route-test-helpers.js';
import { healthRoutes } from './health.routes.js';

describe('healthRoutes', () => {
  let app: FastifyInstance;
  const ping = vi.fn(async () => 'PONG');
  const scan = vi.fn(async (cursor: string) =>
    cursor === '0'
      ? ['7', ['routing:phone:+15555550102', 'routing:phone:+15555550103']]
      : ['0', ['routing:phone:+15555550104']],
  );
  const telephony = {
    isConfigured: vi.fn(() => true),
    testConnection: vi.fn(async () => undefined),
  };

  beforeEach(async () => {
    ping.mockResolvedValue('PONG');
    telephony.isConfigured.mockReturnValue(true);
    telephony.testConnection.mockResolvedValue(undefined);
    app = await createControllerRouteApp(healthRoutes, {
      redis: { ping, scan } as never,
      registerOptions: { telephony },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test('says the process is up', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      timestamp: expect.any(String),
      uptime: expect.any(Number),
    });
  });

  test('reports Redis as disconnected with a 503', async () => {
    ping.mockRejectedValue(new Error('redis unavailable'));

    const response = await app.inject({ method: 'GET', url: '/health/redis' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'error',
      redis: 'disconnected',
    });
  });

  test('reports Twilio as unconfigured without failing', async () => {
    telephony.isConfigured.mockReturnValue(false);

    const response = await app.inject({ method: 'GET', url: '/health/twilio' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      twilio: 'unconfigured',
    });
    expect(telephony.testConnection).not.toHaveBeenCalled();
  });

  test('counts the numbers in the routing cache', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/cache' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      cache: { routedNumbers: 3 },
    });
    expect(scan).toHaveBeenCalledWith(
      '0',
      'MATCH',
      'routing:phone:*',
      'COUNT',
      1000,
    );
  });

  test('degrades the overall status when Twilio does not answer', async () => {
    telephony.testConnection.mockRejectedValue(new Error('twilio unavailable'));

    const response = await app.inject({ method: 'GET', url: '/health/all' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'degraded',
      timestamp: expect.any(String),
      uptime: expect.any(Number),
      services: { redis: 'connected', twilio: 'disconnected' },
    });
  });
});
