import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { authPlugin } from './auth/index.js';
import { CallEventSubscriberService } from './calls/index.js';
import type { ApiConfig } from './config.js';
import {
  apiErrorHandler,
  prismaPlugin,
  rateLimitPlugin,
  redisPlugin,
} from './infra/index.js';
import { registerRoutes } from './routes.js';
import { RoutingCacheService } from './routing/index.js';

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

  await registerRoutes(fastify, config);

  return fastify;
}
