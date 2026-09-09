import type { PrismaClient } from '@repo/db';
import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
} from 'fastify';
import type { Redis } from 'ioredis';
import type { Auth, AuthUser, Role } from '../auth/index.js';
import { type ApiConfig, loadApiConfig } from '../config.js';
import { apiErrorHandler } from '../infra/index.js';

export const defaultAuthUser: AuthUser = {
  id: 'user-1',
  email: 'agent@example.com',
  name: 'Agent One',
  role: 'ADMIN',
  emailVerified: true,
};

/** A complete, fictional configuration for route tests. */
export const testApiConfig: ApiConfig = loadApiConfig({
  NODE_ENV: 'test',
  DATABASE_URL:
    'postgresql://iziphone:not-a-real-password@db.example.com:5432/iziphone',
  BETTER_AUTH_SECRET: 'a-fictional-secret-that-is-long-enough',
  BETTER_AUTH_URL: 'https://api.example.com',
  INTERNAL_API_TOKEN: 'a-fictional-internal-token-value',
  WEBHOOK_BASE_URL: 'https://calls.example.com',
  TWILIO_ACCOUNT_SID: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  TWILIO_AUTH_TOKEN: 'not-a-real-twilio-token',
});

interface CreateApiRouteAppOptions {
  config?: Partial<ApiConfig>;
  db?: Partial<PrismaClient>;
  redis?: Partial<Redis>;
  auth?: Partial<Auth>;
  registerOptions?: Record<string, unknown>;
  user?: AuthUser | null;
}

export async function createApiRouteApp(
  plugin: FastifyPluginAsync,
  options: CreateApiRouteAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const user = options.user === undefined ? defaultAuthUser : options.user;

  app.setErrorHandler(apiErrorHandler);
  app.decorate('config', { ...testApiConfig, ...options.config });
  app.decorate('db', (options.db ?? {}) as PrismaClient);
  app.decorate('redis', (options.redis ?? {}) as Redis);
  app.decorate('auth', (options.auth ?? {}) as Auth);
  app.decorate('requireAuth', async (request, reply) => {
    if (!user) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    request.user = user;
    request.session = {
      session: {
        id: 'session-1',
        userId: user.id,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
        token: 'token-1',
      },
      user,
    };
  });
  app.decorate('requireRole', (roles: readonly Role[]) => {
    return async (request, reply) => {
      if (!user) {
        reply.status(401).send({
          error: 'Unauthorized',
          message: 'Authentication required',
        });
        return;
      }

      request.user = user;

      if (!roles.includes(user.role)) {
        reply.status(403).send({
          error: 'Forbidden',
          message: `Required role: ${roles.join(' or ')}`,
        });
      }
    };
  });

  await app.register(plugin, options.registerOptions);
  await app.ready();

  return app;
}

export function withAuthenticatedUser(
  plugin: FastifyPluginAsync,
  user: AuthUser = defaultAuthUser,
): FastifyPluginAsync {
  return async (fastify) => {
    fastify.addHook('preHandler', async (request) => {
      request.user = user;
    });

    await fastify.register(plugin);
  };
}
