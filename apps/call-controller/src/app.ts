import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import Fastify from 'fastify';
import {
  type CallCommandSubscriber,
  CallFlow,
  createCallEventPublisher,
  createTelephonyService,
  startCallCommandSubscriber,
  voiceRoutes,
  voiceWebhookRoutes,
} from './calls/index.js';
import type { ControllerConfig } from './config.js';
import { healthRoutes } from './health/index.js';
import { redisPlugin } from './infra/index.js';
import { createRealtime } from './realtime/index.js';
import { RoutingLookupService } from './routing/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    config: ControllerConfig;
  }
}

export async function buildApp(config: ControllerConfig) {
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

  await fastify.register(cors, {
    origin: config.corsOrigins,
    // @fastify/cors v11 defaults to CORS-safelisted methods only; keep the v10 set.
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  });
  await fastify.register(formbody);
  await fastify.register(redisPlugin);

  const telephony = createTelephonyService({
    redis: fastify.redis,
    twilio: config.twilio,
    internalApi: config.internalApi,
    log: fastify.log,
  });
  const routing = new RoutingLookupService({
    redis: fastify.redis,
    internalApi: config.internalApi,
    log: fastify.log,
  });
  const events = createCallEventPublisher(fastify.redis);
  const realtime = createRealtime({
    httpServer: fastify.server,
    redis: fastify.redis,
    log: fastify.log,
    authSecret: config.authSecret,
    corsOrigins: config.corsOrigins,
    // The flow is built from this realtime layer, so it is only named here;
    // no softphone can reject a call before both exist.
    onCallRejected: (conversationUuid, userId) =>
      flow.declineOfferedCall(conversationUuid, userId),
  });
  const flow = new CallFlow({
    telephony,
    routing,
    events,
    realtime,
    log: fastify.log,
  });
  let commands: CallCommandSubscriber | null = null;

  fastify.addHook('onReady', async () => {
    await realtime.start();
    commands = await startCallCommandSubscriber({
      redis: fastify.redis,
      telephony,
      log: fastify.log,
    });
  });

  fastify.addHook('onClose', async () => {
    await commands?.close();
    await realtime.close();
  });

  await fastify.register(healthRoutes, { telephony });
  await fastify.register(voiceRoutes, { telephony, flow });
  await fastify.register(voiceWebhookRoutes, { flow, telephony });

  return fastify;
}
