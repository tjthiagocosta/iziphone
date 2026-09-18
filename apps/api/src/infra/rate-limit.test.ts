import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';
import {
  authRateLimit,
  isRateLimitExempt,
  rateLimitPlugin,
} from './rate-limit.js';

/**
 * Registered the way `app.ts` does it: the plugin on the root instance, every
 * route on the root instance afterwards. The plugin installs itself through an
 * encapsulated `onRoute` hook, so this order is the whole point of the test.
 */
async function buildLimitedApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(rateLimitPlugin);

  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/api/auth/*', { config: authRateLimit }, async () => ({
    ok: true,
  }));
  app.post('/webhooks/twilio/messages/inbound', async () => ({ ok: true }));
  app.get('/media/greetings/:greetingId', async () => ({ ok: true }));
  app.get('/internal/routing/by-phone/:phoneNumber', async () => ({
    ok: true,
  }));

  await app.ready();

  return app;
}

async function replayStatuses(
  app: FastifyInstance,
  times: number,
  request: { method: 'GET' | 'POST'; url: string },
): Promise<number[]> {
  const statuses: number[] = [];

  for (let attempt = 0; attempt < times; attempt += 1) {
    const response = await app.inject(request);
    statuses.push(response.statusCode);
  }

  return statuses;
}

describe('rateLimitPlugin', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  test('refuses the 101st request to a route in the same window', async () => {
    app = await buildLimitedApp();

    const statuses = await replayStatuses(app, 100, {
      method: 'GET',
      url: '/health',
    });
    const refused = await app.inject({ method: 'GET', url: '/health' });

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: expect.stringContaining('Rate limit exceeded'),
    });
  });

  test('refuses the 11th request to a route carrying authRateLimit', async () => {
    app = await buildLimitedApp();

    const statuses = await replayStatuses(app, 10, {
      method: 'POST',
      url: '/api/auth/sign-in/email',
    });
    const refused = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
    });

    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(refused.statusCode).toBe(429);
  });

  test.each([
    { method: 'POST' as const, url: '/webhooks/twilio/messages/inbound' },
    { method: 'GET' as const, url: '/media/greetings/greeting-1' },
    { method: 'GET' as const, url: '/internal/routing/by-phone/+15550100' },
  ])('never refuses $url', async (request) => {
    app = await buildLimitedApp();

    const statuses = await replayStatuses(app, 120, request);

    expect(statuses.every((status) => status === 200)).toBe(true);
  });
});

describe('isRateLimitExempt', () => {
  test.each([
    '/webhooks/twilio/messages/inbound',
    '/webhooks/twilio/messages/status',
    '/media/messaging/messages/media-1',
    '/media/greetings/greeting-1',
    '/internal/routing/refresh-cache',
  ])('exempts %s', (path) => {
    expect(isRateLimitExempt(path)).toBe(true);
  });

  test.each([
    '/health',
    '/health/all',
    '/api/auth/sign-in/email',
    '/api/user/messages',
    '/api/admin/users',
    '/api/calls',
    // Only a whole path segment counts, so a route that merely starts with
    // the same letters is still limited.
    '/mediafoo',
    '/internalish/routing',
  ])('limits %s', (path) => {
    expect(isRateLimitExempt(path)).toBe(false);
  });
});
