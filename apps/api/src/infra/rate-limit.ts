import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

/** Per-client-IP limit for the whole API. */
export async function rateLimitPlugin(fastify: FastifyInstance) {
  await fastify.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${Math.round(context.ttl / 1000)} seconds.`,
    }),
    skipOnError: false,
  });
}

/** Route config for credential endpoints, to slow down password guessing. */
export const authRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: '1 minute',
  },
};
