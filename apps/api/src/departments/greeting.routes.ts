import type { FastifyPluginAsync } from 'fastify';
import { AuditLogService } from '../admin/index.js';
import { GREETING_MEDIA_PATH, RoutingCacheService } from '../routing/index.js';
import { DepartmentGreetingService } from './greeting.service.js';

/**
 * The public, unauthenticated link a department's voicemail greeting is
 * played from. Twilio fetches it with a plain GET while it builds the
 * voicemail, and the admin console plays it back. The id is a random UUID,
 * which is the only access control it has.
 */
export const departmentGreetingRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, db, log, mediaStore, redis } = fastify;
  const greetingService = new DepartmentGreetingService({
    db,
    mediaStore,
    publicUrl: config.publicUrl,
    auditLog: new AuditLogService(db),
    routingCache: new RoutingCacheService(
      redis,
      db,
      config.routingCacheTtlSeconds,
      config.publicUrl,
      log,
    ),
    log,
  });

  // Fastify only auto-generates a HEAD route for a GET when none is
  // registered yet, and registering one after the GET collides with that
  // auto-generated route. Declaring HEAD first makes this the one Fastify
  // keeps, so the call controller's readiness probe (2s timeout, expects an
  // audio content-type) never opens a GetObject stream just to discard it.
  fastify.head<{ Params: { greetingId: string } }>(
    `${GREETING_MEDIA_PATH}/:greetingId`,
    async (request, reply) => {
      const greeting = await greetingService.describe(
        request.params.greetingId,
      );

      if (!greeting) {
        return reply.status(404).send();
      }

      reply.header('content-type', greeting.contentType);
      reply.header('content-length', greeting.contentLength);
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send();
    },
  );

  fastify.get<{ Params: { greetingId: string } }>(
    `${GREETING_MEDIA_PATH}/:greetingId`,
    async (request, reply) => {
      const greeting = await greetingService.open(request.params.greetingId);

      if (!greeting) {
        return reply.status(404).send({ error: 'Not Found' });
      }

      reply.header('content-type', greeting.contentType);
      reply.header('content-length', greeting.contentLength);
      reply.header('x-content-type-options', 'nosniff');
      // Every upload gets a new id, so what this URL serves never changes.
      reply.header('cache-control', 'public, max-age=31536000, immutable');
      return reply.send(greeting.body);
    },
  );
};
