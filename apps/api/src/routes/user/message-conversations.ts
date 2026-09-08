import {
  MarkMessageConversationReadSchema,
  MessageConversationListQuerySchema,
  MessageListQuerySchema,
} from '@repo/dto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { authenticatedUser } from '../../plugins/auth.js';
import { MessageConversationService } from '../../services/messaging/message-conversation.service.js';

const messageConversationRoutes: FastifyPluginAsync = async (fastify) => {
  const conversationService = new MessageConversationService(fastify.db);

  fastify.get('/', async (request, reply) => {
    const query = MessageConversationListQuerySchema.parse(request.query);
    const result = await conversationService.listForUser(
      authenticatedUser(request).id,
      query,
    );

    return reply.send(result);
  });

  fastify.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const conversation = await conversationService.getForUser(
      authenticatedUser(request).id,
      request.params.id,
    );

    if (!conversation) {
      return replyNotFound(reply);
    }

    return reply.send(conversation);
  });

  fastify.get<{ Params: { id: string } }>(
    '/:id/messages',
    async (request, reply) => {
      const query = MessageListQuerySchema.parse(request.query);
      const result = await conversationService.listMessages(
        authenticatedUser(request).id,
        request.params.id,
        query,
      );

      if (!result) {
        return replyNotFound(reply);
      }

      return reply.send(result);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/read',
    async (request, reply) => {
      MarkMessageConversationReadSchema.parse(request.body ?? {});

      const updated = await conversationService.markRead(
        authenticatedUser(request).id,
        request.params.id,
      );

      if (!updated) {
        return replyNotFound(reply);
      }

      return reply.status(204).send();
    },
  );
};

function replyNotFound(reply: FastifyReply) {
  return reply.status(404).send({
    error: 'Not Found',
    message: 'Message conversation not found',
  });
}

export default messageConversationRoutes;
