import { MessageSendersResponseSchema } from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { authenticatedUser } from '../auth/index.js';
import { MessageSenderService } from './sender.service.js';

export const messageSenderRoutes: FastifyPluginAsync = async (fastify) => {
  const senderService = new MessageSenderService(fastify.db);

  fastify.get('/', async (request, reply) => {
    const senders = await senderService.listAllowedSenders(
      authenticatedUser(request).id,
    );
    return reply.send(MessageSendersResponseSchema.parse({ senders }));
  });
};
