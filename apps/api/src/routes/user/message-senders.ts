import { MessageSendersResponseSchema } from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { authenticatedUser } from '../../plugins/auth.js';
import { MessageSenderService } from '../../services/messaging/message-sender.service.js';

const messageSenderRoutes: FastifyPluginAsync = async (fastify) => {
  const senderService = new MessageSenderService(fastify.db);

  fastify.get('/', async (request, reply) => {
    const senders = await senderService.listAllowedSenders(
      authenticatedUser(request).id,
    );
    return reply.send(MessageSendersResponseSchema.parse({ senders }));
  });
};

export default messageSenderRoutes;
