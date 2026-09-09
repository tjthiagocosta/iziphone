import type { FastifyPluginAsync } from 'fastify';
import { TwilioNumberManagementService } from '../phone-numbers/index.js';

type ServiceState = 'connected' | 'disconnected' | 'unknown';

/**
 * `/health` is public and says only that the process is up. The detailed
 * checks name hosts and account identifiers, so they require an admin.
 */
export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  const twilio = new TwilioNumberManagementService({
    credentials: fastify.config.twilio,
    publicUrl: fastify.config.publicUrl,
    callControllerPublicUrl: fastify.config.callControllerPublicUrl,
    log: fastify.log,
  });
  const adminOnly = { preHandler: [fastify.requireRole(['ADMIN'])] };

  const checkDatabase = async (): Promise<ServiceState> => {
    try {
      await fastify.db.$queryRaw`SELECT 1`;
      return 'connected';
    } catch (error) {
      fastify.log.warn({ error }, 'Database health check failed');
      return 'disconnected';
    }
  };

  const checkRedis = async (): Promise<ServiceState> => {
    try {
      return (await fastify.redis.ping()) === 'PONG'
        ? 'connected'
        : 'disconnected';
    } catch (error) {
      fastify.log.warn({ error }, 'Redis health check failed');
      return 'disconnected';
    }
  };

  fastify.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  fastify.get('/health/db', adminOnly, async (_request, reply) => {
    const database = await checkDatabase();
    if (database !== 'connected') reply.code(503);
    return {
      status: database === 'connected' ? 'ok' : 'error',
      database,
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get('/health/redis', adminOnly, async (_request, reply) => {
    const redis = await checkRedis();
    if (redis !== 'connected') reply.code(503);
    return {
      status: redis === 'connected' ? 'ok' : 'error',
      redis,
      timestamp: new Date().toISOString(),
    };
  });

  fastify.get('/health/twilio', adminOnly, async (_request, reply) => {
    const readiness = await twilio.getReadinessReport();
    if (readiness.status !== 'ok') reply.code(503);
    return readiness;
  });

  fastify.get('/health/all', adminOnly, async (_request, reply) => {
    const [database, redis] = await Promise.all([
      checkDatabase(),
      checkRedis(),
    ]);
    let twilioState: ServiceState = 'unknown';

    if (twilio.hasAnyConfiguration()) {
      const readiness = await twilio.getReadinessReport();
      twilioState = readiness.status === 'ok' ? 'connected' : 'disconnected';
    }

    const services = { database, redis, twilio: twilioState };
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
