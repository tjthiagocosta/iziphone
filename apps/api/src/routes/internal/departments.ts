import type { FastifyPluginAsync } from 'fastify';
import { RoutingCacheService } from '../../services/routing-cache.service.js';

/** Routing lookups the call controller makes when Redis has no entry. */
const internalDepartmentRoutes: FastifyPluginAsync = async (fastify) => {
  const routingCache = new RoutingCacheService(
    fastify.redis,
    fastify.db,
    fastify.config.routingCacheTtlSeconds,
    fastify.log,
  );

  fastify.get<{ Params: { phoneNumber: string } }>(
    '/internal/routing/by-phone/:phoneNumber',
    async (request, reply) => {
      const phoneNumber = decodeURIComponent(request.params.phoneNumber);
      const routing = await routingCache.lookupByPhone(phoneNumber);

      if (!routing) {
        fastify.log.info(
          { phoneNumberLast4: phoneNumber.slice(-4) },
          'Routing lookup: number does not route anywhere',
        );
        return reply.status(404).send({
          error: 'Phone number not assigned to any department or user',
        });
      }

      fastify.log.info(
        {
          type: routing.type,
          departmentId: routing.departmentId,
          userId: routing.userId,
        },
        'Routing lookup served from database',
      );

      return reply.send(routing);
    },
  );

  fastify.post('/internal/routing/refresh-cache', async (_request, reply) => {
    const warmed = await routingCache.warmAll();
    return reply.send({ success: true, ...warmed });
  });
};

export default internalDepartmentRoutes;
