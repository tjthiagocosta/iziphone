import { CallConversationParamsSchema, CallListQuerySchema } from '@repo/dto';
import { createCommandPublisher } from '@repo/events';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { authenticatedUser } from '../auth/index.js';
import { CallHistoryService } from './call-history.service.js';
import { loadCallScope } from './call-scope.js';

/**
 * Call history reads from the database; a hangup is published to Redis for
 * the call controller to execute. Both are limited to the calls the user may
 * see (see call-scope). Hold and transfer are not here: only the controller
 * knows who is on a live call, so the softphone asks it directly.
 */
export const callRoutes: FastifyPluginAsync = async (fastify) => {
  const commands = createCommandPublisher(fastify.redis);
  const history = new CallHistoryService(fastify.db);

  /** Resolves the conversation to a call the user may act on, or answers 404. */
  async function visibleCall(request: FastifyRequest, reply: FastifyReply) {
    const user = authenticatedUser(request);
    const { conversationUuid } = CallConversationParamsSchema.parse(
      request.params,
    );
    const call = await history.findInScope(
      await loadCallScope(fastify.db, user),
      conversationUuid,
    );

    if (!call) {
      reply.status(404).send({ error: 'Call not found' });
      return null;
    }

    return { user, call };
  }

  fastify.post(
    '/api/calls/:conversationUuid/hangup',
    { preHandler: [fastify.requireAuth] },
    async (request, reply) => {
      const visible = await visibleCall(request, reply);
      if (!visible) return;

      fastify.log.info(
        {
          conversationUuid: visible.call.conversationUuid,
          initiatedBy: visible.user.id,
        },
        'Publishing hangup command',
      );

      await commands.hangup({
        conversationUuid: visible.call.conversationUuid,
        initiatedBy: visible.user.id,
      });

      return { success: true, message: 'Hangup command sent' };
    },
  );

  fastify.get(
    '/api/calls',
    { preHandler: [fastify.requireAuth] },
    async (request) => {
      const user = authenticatedUser(request);
      const query = CallListQuerySchema.parse(request.query);
      const scope = await loadCallScope(fastify.db, user);

      return history.listForUser(scope, query);
    },
  );

  fastify.get(
    '/api/calls/:conversationUuid',
    { preHandler: [fastify.requireAuth] },
    async (request, reply) => {
      const visible = await visibleCall(request, reply);
      if (!visible) return;

      return visible.call;
    },
  );
};
