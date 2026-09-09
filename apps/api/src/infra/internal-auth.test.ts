import Fastify from 'fastify';
import { describe, expect, test } from 'vitest';
import { internalAuthHook } from './internal-auth.js';

const token = 'a-fictional-internal-token-value';

async function buildApp() {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', internalAuthHook(token));
  app.get('/internal/ping', async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe('internalAuthHook', () => {
  test('lets a request with the shared token through', async () => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  test.each([
    ['no header', undefined],
    ['a wrong token', 'Bearer not-the-token-at-all-really'],
    ['a token of the same length', `Bearer ${'x'.repeat(token.length)}`],
    ['a non-bearer scheme', `Basic ${token}`],
  ])('rejects %s', async (_label, authorization) => {
    const app = await buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/internal/ping',
      headers: authorization ? { authorization } : {},
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
    await app.close();
  });
});
