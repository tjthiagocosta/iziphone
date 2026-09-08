import {
  CallConversationParamsSchema,
  CallListQuerySchema,
  HoldCallSchema,
  TransferCallSchema,
} from '@repo/dto';
import { createCommandPublisher } from '@repo/events';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { authenticatedUser } from '../plugins/auth.js';
import { loadCallScope } from '../services/call-scope.js';

const CALL_INCLUDE = {
  user: { select: { id: true, email: true } },
  department: { select: { id: true, name: true } },
} as const;

/**
 * Call history reads from the database; call commands are published to
 * Redis for the call controller to execute. Both are limited to the calls
 * the user may see (see call-scope).
 */
const callRoutes: FastifyPluginAsync = async (fastify) => {
  const commands = createCommandPublisher(fastify.redis);

  /** Resolves the conversation to a call the user may act on, or answers 404. */
  async function visibleCall(request: FastifyRequest, reply: FastifyReply) {
    const user = authenticatedUser(request);
    const { conversationUuid } = CallConversationParamsSchema.parse(
      request.params,
    );
    const call = await fastify.db.call.findFirst({
      where: { conversationUuid, ...(await loadCallScope(fastify.db, user)) },
      include: CALL_INCLUDE,
    });

    if (!call) {
      reply.status(404).send({ error: 'Call not found' });
      return null;
    }

    return { user, call };
  }

  fastify.post(
    '/api/calls/:conversationUuid/transfer',
    { preHandler: [fastify.requireAuth] },
    async (request, reply) => {
      const { targetUserId } = TransferCallSchema.parse(request.body);
      const visible = await visibleCall(request, reply);
      if (!visible) return;

      fastify.log.info(
        {
          conversationUuid: visible.call.conversationUuid,
          targetUserId,
          initiatedBy: visible.user.id,
        },
        'Publishing transfer command',
      );

      await commands.transfer({
        conversationUuid: visible.call.conversationUuid,
        targetUserId,
        initiatedBy: visible.user.id,
      });

      return { success: true, message: 'Transfer command sent' };
    },
  );

  fastify.post(
    '/api/calls/:conversationUuid/hold',
    { preHandler: [fastify.requireAuth] },
    async (request, reply) => {
      const { hold } = HoldCallSchema.parse(request.body);
      const visible = await visibleCall(request, reply);
      if (!visible) return;

      fastify.log.info(
        {
          conversationUuid: visible.call.conversationUuid,
          hold,
          initiatedBy: visible.user.id,
        },
        'Publishing hold command',
      );

      await commands.hold({
        conversationUuid: visible.call.conversationUuid,
        hold,
        initiatedBy: visible.user.id,
      });

      return {
        success: true,
        message: hold ? 'Hold command sent' : 'Resume command sent',
      };
    },
  );

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
      const { limit, offset } = CallListQuerySchema.parse(request.query);
      const scope = await loadCallScope(fastify.db, user);

      const [calls, total] = await Promise.all([
        fastify.db.call.findMany({
          where: scope,
          take: limit,
          skip: offset,
          orderBy: { createdAt: 'desc' },
          include: CALL_INCLUDE,
        }),
        fastify.db.call.count({ where: scope }),
      ]);

      return { calls, total, limit, offset };
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

export default callRoutes;
