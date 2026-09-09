import type { FastifyPluginAsync } from 'fastify';
import { authenticatedUser } from './plugin.js';

/** Lets a user see and revoke their own sessions. */
export const sessionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/api/sessions',
    { preHandler: [fastify.requireAuth] },
    async (request) => {
      const user = authenticatedUser(request);
      const currentSessionId = request.session?.session.id;

      const sessions = await fastify.db.session.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          expiresAt: true,
          ipAddress: true,
          userAgent: true,
        },
      });

      return {
        sessions: sessions.map((session) => ({
          ...session,
          isCurrent: session.id === currentSessionId,
        })),
      };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    '/api/sessions/:id',
    { preHandler: [fastify.requireAuth] },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const { id } = request.params;

      const session = await fastify.db.session.findFirst({
        where: { id, userId: user.id },
      });

      if (!session) {
        return reply.status(404).send({ error: 'Session not found' });
      }

      await fastify.db.session.delete({ where: { id } });

      fastify.log.info({ userId: user.id, sessionId: id }, 'Session revoked');

      return { success: true };
    },
  );

  fastify.post(
    '/api/sessions/revoke-all',
    { preHandler: [fastify.requireAuth] },
    async (request) => {
      const user = authenticatedUser(request);
      const currentSessionId = request.session?.session.id;

      // The caller stays signed in; only the other devices are signed out.
      const result = await fastify.db.session.deleteMany({
        where: currentSessionId
          ? { userId: user.id, id: { not: currentSessionId } }
          : { userId: user.id },
      });

      fastify.log.info(
        { userId: user.id, count: result.count },
        'Other sessions revoked',
      );

      return { success: true, revokedCount: result.count };
    },
  );
};
