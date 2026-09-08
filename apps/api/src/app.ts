import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import type { ApiConfig } from './config.js';
import authPlugin from './plugins/auth.js';
import { apiErrorHandler } from './plugins/error-handler.js';
import { internalAuthHook } from './plugins/internal-auth.js';
import prismaPlugin from './plugins/prisma.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import redisPlugin from './plugins/redis.js';
import adminRoutes from './routes/admin/index.js';
import authRoutes from './routes/auth.js';
import callRoutes from './routes/calls.js';
import healthRoutes from './routes/health.js';
import internalDepartmentRoutes from './routes/internal/departments.js';
import internalUserRoutes from './routes/internal/users.js';
import messageMediaRoutes from './routes/message-media.js';
import sessionRoutes from './routes/sessions.js';
import userRoutes from './routes/user/index.js';
import twilioMessagesWebhookRoutes from './routes/webhooks/twilio/messages.js';
import { CallEventSubscriberService } from './services/call-event-subscriber.service.js';
import { RoutingCacheService } from './services/routing-cache.service.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiConfig;
  }
}

export async function buildApp(config: ApiConfig) {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      transport:
        config.nodeEnv === 'development'
          ? {
              target: 'pino-pretty',
              options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname',
              },
            }
          : undefined,
    },
  });

  fastify.decorate('config', config);
  fastify.setErrorHandler(apiErrorHandler);

  await fastify.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    // @fastify/cors v11 defaults to CORS-safelisted methods only; keep the v10 set.
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  });
  await fastify.register(formbody);

  await fastify.register(prismaPlugin);
  await fastify.register(redisPlugin);
  await fastify.register(authPlugin);
  await fastify.register(rateLimitPlugin);

  const routingCache = new RoutingCacheService(
    fastify.redis,
    fastify.db,
    fastify.config.routingCacheTtlSeconds,
    fastify.log,
  );
  const callEventSubscriber = new CallEventSubscriberService(
    fastify.redis,
    fastify.db,
    fastify.log,
  );

  fastify.addHook('onReady', async () => {
    try {
      const result = await routingCache.warmAll();
      fastify.log.info(result, 'Routing cache warmed on startup');
    } catch (error) {
      // The cache fills on the first routing miss, so a cold start still serves.
      fastify.log.error({ error }, 'Failed to warm routing cache');
    }

    await callEventSubscriber.start();
  });

  fastify.addHook('onClose', async () => {
    await callEventSubscriber.close();
  });

  await fastify.register(healthRoutes);
  await fastify.register(messageMediaRoutes);
  await fastify.register(authRoutes);
  await fastify.register(sessionRoutes);
  await fastify.register(async (internal) => {
    internal.addHook('onRequest', internalAuthHook(config.internalApiToken));
    await internal.register(internalDepartmentRoutes);
    await internal.register(internalUserRoutes);
  });
  await fastify.register(callRoutes);
  await fastify.register(twilioMessagesWebhookRoutes, {
    prefix: '/webhooks/twilio/messages',
  });
  await fastify.register(userRoutes, { prefix: '/api/user' });
  await fastify.register(adminRoutes, { prefix: '/api/admin' });

  return fastify;
}
