import { ROUTING_CACHE } from '@repo/events';
import type { FastifyPluginAsync } from 'fastify';
import type { TelephonyService } from '../calls/index.js';

type ServiceState = 'connected' | 'disconnected' | 'unconfigured';

export interface HealthRouteOptions {
  telephony: Pick<TelephonyService, 'isConfigured' | 'testConnection'>;
}

/**
 * `/health` says the process is up. The others say whether Redis and Twilio
 * answer and how many numbers the routing cache knows; none of them name
 * hosts or account identifiers.
 */
export const healthRoutes: FastifyPluginAsync<HealthRouteOptions> = async (
  fastify,
  { telephony },
) => {
  const checkRedis = async (): Promise<ServiceState> => {
    try {
      return (await fastify.redis.ping()) === 'PONG'
        ? 'connected'
        : 'disconnected';
    } catch (error) {
      fastify.log.warn({ err: error }, 'Redis health check failed');
      return 'disconnected';
    }
  };

  const checkTwilio = async (): Promise<ServiceState> => {
    if (!telephony.isConfigured()) {
      return 'unconfigured';
    }

    try {
      await telephony.testConnection();
      return 'connected';
    } catch (error) {
      fastify.log.warn({ err: error }, 'Twilio health check failed');
      return 'disconnected';
    }
  };

  const countRoutedNumbers = async (): Promise<number> => {
    let cursor = '0';
    let count = 0;

    do {
      const [next, keys] = await fastify.redis.scan(
        cursor,
        'MATCH',
        `${ROUTING_CACHE.PHONE_KEY_PREFIX}*`,
        'COUNT',
        1000,
      );
      cursor = next;
      count += keys.length;
    } while (cursor !== '0');

    return count;
  };

  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  fastify.get('/health/redis', async (_request, reply) => {
    const redis = await checkRedis();
    if (redis !== 'connected') reply.code(503);
    return {
      status: redis === 'connected' ? 'ok' : 'error',
      redis,
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get('/health/twilio', async (_request, reply) => {
    const twilio = await checkTwilio();
    if (twilio === 'disconnected') reply.code(503);
    return {
      status: twilio === 'disconnected' ? 'error' : 'ok',
      twilio,
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get('/health/cache', async (_request, reply) => {
    try {
      const routedNumbers = await countRoutedNumbers();
      return {
        status: 'ok',
        cache: { routedNumbers },
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      fastify.log.warn({ err: error }, 'Routing cache health check failed');
      reply.code(503);
      return {
        status: 'error',
        cache: { routedNumbers: 0 },
        timestamp: new Date().toISOString(),
      };
    }
  });

  fastify.get('/health/all', async (_request, reply) => {
    const [redis, twilio] = await Promise.all([checkRedis(), checkTwilio()]);
    const services = { redis, twilio };
    const degraded = Object.values(services).includes('disconnected');

    if (degraded) reply.code(503);

    return {
      status: degraded ? 'degraded' : 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      services,
    };
  });
};
