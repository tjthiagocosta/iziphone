import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import { AuditLogService, SystemSettingsService } from './admin/index.js';
import { authPlugin } from './auth/index.js';
import {
  CallEventSubscriberService,
  CallRecordingService,
  RecordingRetentionSweep,
  startRetentionSweep,
} from './calls/index.js';
import type { ApiConfig } from './config.js';
import {
  apiErrorHandler,
  prismaPlugin,
  rateLimitPlugin,
  redisPlugin,
} from './infra/index.js';
import { mediaStorePlugin } from './media-store/index.js';
import { registerRoutes } from './routes.js';
import { RoutingCacheService } from './routing/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: ApiConfig;
  }
}

export async function buildApp(config: ApiConfig) {
  const fastify = Fastify({
    // Decides what request.ip is, which is what the rate limiter buckets by
    // and what the audit log records.
    trustProxy: config.trustProxy,
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
  await fastify.register(mediaStorePlugin);
  await fastify.register(authPlugin);
  await fastify.register(rateLimitPlugin);

  const routingCache = new RoutingCacheService(
    fastify.redis,
    fastify.db,
    fastify.config.routingCacheTtlSeconds,
    fastify.config.publicUrl,
    fastify.log,
  );
  const recordings = new CallRecordingService(
    fastify.db,
    fastify.mediaStore,
    fastify.config.twilio,
    fastify.log,
  );
  const callEventSubscriber = new CallEventSubscriberService(
    fastify.redis,
    fastify.db,
    fastify.log,
    recordings,
  );
  const retentionSweep = new RecordingRetentionSweep({
    db: fastify.db,
    redis: fastify.redis,
    settings: new SystemSettingsService(
      fastify.db,
      new AuditLogService(fastify.db),
    ),
    recordings,
    auditLog: new AuditLogService(fastify.db),
    log: fastify.log,
  });
  let sweepSchedule: { stop(): void } | null = null;

  fastify.addHook('onReady', async () => {
    try {
      const result = await routingCache.warmAll();
      fastify.log.info(result, 'Routing cache warmed on startup');
    } catch (error) {
      // The cache fills on the first routing miss, so a cold start still serves.
      fastify.log.error({ error }, 'Failed to warm routing cache');
    }

    await callEventSubscriber.start();
    sweepSchedule = startRetentionSweep(retentionSweep, fastify.log);
  });

  fastify.addHook('onClose', async () => {
    sweepSchedule?.stop();
    await callEventSubscriber.close();
  });

  await registerRoutes(fastify, config);

  return fastify;
}
