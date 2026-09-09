import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { Redis } from 'ioredis';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

const register: FastifyPluginAsync = async (fastify) => {
  const redis = new Redis(fastify.config.redisUrl, {
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      return Math.min(times * 50, 2000);
    },
    reconnectOnError(error) {
      return ['READONLY', 'ECONNRESET', 'ETIMEDOUT'].some((code) =>
        error.message.includes(code),
      );
    },
  });

  redis.on('connect', () => {
    fastify.log.info('Redis connected');
  });

  redis.on('error', (error) => {
    fastify.log.error({ error }, 'Redis error');
  });

  fastify.decorate('redis', redis);

  fastify.addHook('onClose', async () => {
    await redis.quit();
  });
};

export const redisPlugin = fp(register, {
  name: 'redis',
});
