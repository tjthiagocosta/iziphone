import { signJWT } from '@repo/events';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { authRateLimit } from '../infra/index.js';
import { authenticatedUser } from './plugin.js';

const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'transfer-encoding',
]);

/**
 * Better Auth speaks the Fetch API. Its Node handler does not cooperate with
 * Fastify's body parsing, so the request is rebuilt by hand.
 */
function toFetchRequest(request: FastifyRequest, publicUrl: string): Request {
  const url = new URL(request.raw.url ?? request.url, `${publicUrl}/`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (!value || HOP_BY_HOP_HEADERS.has(key)) {
      continue;
    }

    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  const method = request.method.toUpperCase();

  if (method === 'GET' || method === 'HEAD') {
    return new Request(url, { method, headers });
  }

  let body: RequestInit['body'];

  if (typeof request.body === 'string') {
    body = request.body;
  } else if (request.body instanceof Uint8Array) {
    body = request.body;
  } else if (request.body !== undefined && request.body !== null) {
    body = JSON.stringify(request.body);
    headers.set('content-type', 'application/json');
  }

  return new Request(url, { method, headers, body });
}

async function forwardResponse(response: Response, reply: FastifyReply) {
  reply.status(response.status);

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') {
      reply.header(key, value);
    }
  });

  const setCookies = response.headers.getSetCookie();

  if (setCookies.length > 0) {
    reply.header('set-cookie', setCookies);
  }

  const responseBody = await response.arrayBuffer();

  if (responseBody.byteLength > 0) {
    return reply.send(Buffer.from(responseBody));
  }

  return reply.send();
}

/**
 * Mounts Better Auth at /api/auth/* (sign-up, sign-in, sign-out, session)
 * and adds the socket token endpoint the call controller verifies.
 */
export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const { config } = fastify;

  const proxyToBetterAuth = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    try {
      const response = await fastify.auth.handler(
        toFetchRequest(request, config.publicUrl),
      );
      return await forwardResponse(response, reply);
    } catch (error) {
      fastify.log.error({ error }, 'Auth handler error');
      return reply.status(500).send({
        error: 'Internal authentication error',
        code: 'AUTH_FAILURE',
      });
    }
  };

  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/api/auth/*',
    handler: proxyToBetterAuth,
  });

  fastify.route({
    method: 'POST',
    url: '/api/auth/*',
    config: authRateLimit,
    handler: proxyToBetterAuth,
  });

  fastify.get(
    '/api/auth/jwt-token',
    { preHandler: [fastify.requireAuth] },
    async (request) => {
      const user = authenticatedUser(request);

      // Short-lived on purpose: it only authenticates the realtime socket.
      const token = await signJWT(
        { sub: user.id, email: user.email, role: user.role },
        config.authSecret,
      );

      return { token };
    },
  );

  fastify.get(
    '/api/auth/me',
    { preHandler: [fastify.requireAuth] },
    async (request) => {
      return { user: authenticatedUser(request) };
    },
  );
};
