import type { FastifyPluginAsync } from 'fastify';
import departmentRoutes from './departments.js';
import messageConversationRoutes from './message-conversations.js';
import messageSenderRoutes from './message-senders.js';
import messageRoutes from './messages.js';

/** Routes every authenticated user (AGENT, SUPERVISOR, ADMIN) may call. */
const userRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.requireAuth);

  await fastify.register(departmentRoutes, { prefix: '/departments' });
  await fastify.register(messageRoutes, { prefix: '/messages' });
  await fastify.register(messageSenderRoutes, { prefix: '/message-senders' });
  await fastify.register(messageConversationRoutes, {
    prefix: '/message-conversations',
  });
};

export default userRoutes;
