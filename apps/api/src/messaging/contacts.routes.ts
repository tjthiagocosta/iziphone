import { ContactListQuerySchema } from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { authenticatedUser } from '../auth/index.js';
import { MessagingContactService } from './contact.service.js';

/** Read-only: a contact is created by messaging or calling one. */
export const contactRoutes: FastifyPluginAsync = async (fastify) => {
  const contacts = new MessagingContactService(fastify.db);

  fastify.get('/', async (request, reply) => {
    const query = ContactListQuerySchema.parse(request.query);

    return reply.send(
      await contacts.listForUser(authenticatedUser(request).id, query),
    );
  });
};
