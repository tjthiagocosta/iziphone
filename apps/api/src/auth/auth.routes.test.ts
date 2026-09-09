import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createApiRouteApp,
  testApiConfig,
} from '../test/route-test-helpers.js';
import { authRoutes } from './auth.routes.js';

describe('authRoutes', () => {
  let app: FastifyInstance;
  const handler = vi.fn<(request: Request) => Promise<Response>>();

  beforeEach(async () => {
    app = await createApiRouteApp(authRoutes, { auth: { handler } });
  });

  afterEach(async () => {
    await app.close();
  });

  test('rebuilds the sign-in request on the public url with sanitized headers and a JSON body', async () => {
    handler.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: {
        'x-forwarded-proto': 'https',
        connection: 'keep-alive',
      },
      payload: {
        email: 'agent@example.com',
        password: 'password123',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ ok: true });

    const fetchRequest = handler.mock.calls[0]?.[0];

    expect(fetchRequest).toBeInstanceOf(Request);
    expect(fetchRequest?.url).toBe(
      `${testApiConfig.publicUrl}/api/auth/sign-in/email`,
    );
    expect(fetchRequest?.headers.get('connection')).toBeNull();
    expect(fetchRequest?.headers.get('host')).toBeNull();
    expect(fetchRequest?.headers.get('content-type')).toBe('application/json');
    expect(fetchRequest?.headers.get('x-forwarded-proto')).toBe('https');
    expect(await fetchRequest?.text()).toBe(
      JSON.stringify({
        email: 'agent@example.com',
        password: 'password123',
      }),
    );
  });

  test('forwards multiple Better Auth cookies individually', async () => {
    const headers = new Headers({ 'content-type': 'application/json' });
    headers.append(
      'set-cookie',
      'iziphone.session_token=token; Path=/; HttpOnly',
    );
    headers.append(
      'set-cookie',
      'iziphone.session_data=data; Path=/; HttpOnly',
    );

    handler.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: {
        email: 'agent@example.com',
        password: 'password123',
      },
    });

    const setCookieHeader = response.headers['set-cookie'];
    const setCookieValues = Array.isArray(setCookieHeader)
      ? setCookieHeader
      : [setCookieHeader];

    expect(setCookieValues).toEqual(
      expect.arrayContaining([
        'iziphone.session_token=token; Path=/; HttpOnly',
        'iziphone.session_data=data; Path=/; HttpOnly',
      ]),
    );
  });

  test.each([
    ['GET', '/api/auth/session', undefined],
    [
      'POST',
      '/api/auth/sign-in/email',
      { email: 'agent@example.com', password: 'password123' },
    ],
  ] as const)(
    'answers with an authentication failure when Better Auth throws on %s',
    async (method, url, payload) => {
      handler.mockRejectedValue(new Error('unexpected auth error'));

      const response = await app.inject({ method, url, payload });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: 'Internal authentication error',
        code: 'AUTH_FAILURE',
      });
    },
  );

  test('issues a socket token signed with the auth secret', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/jwt-token',
    });

    expect(response.statusCode).toBe(200);

    const body = response.json() as { token: string };
    const verified = await jose.jwtVerify(
      body.token,
      new TextEncoder().encode(testApiConfig.authSecret),
    );

    expect(verified.payload.sub).toBe('user-1');
    expect(verified.payload.email).toBe('agent@example.com');
    expect(verified.payload.role).toBe('ADMIN');
  });

  test('returns the authenticated user', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        id: 'user-1',
        email: 'agent@example.com',
        name: 'Agent One',
        role: 'ADMIN',
        emailVerified: true,
      },
    });
  });

  test('rejects unauthenticated access to the token and user endpoints', async () => {
    const anonymous = await createApiRouteApp(authRoutes, {
      auth: { handler },
      user: null,
    });

    for (const url of ['/api/auth/jwt-token', '/api/auth/me']) {
      const response = await anonymous.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
    }

    await anonymous.close();
  });
});
