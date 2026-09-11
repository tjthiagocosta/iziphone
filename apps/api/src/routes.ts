import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { adminStatsRoutes } from './admin/index.js';
import { authRoutes, sessionRoutes } from './auth/index.js';
import { callRoutes } from './calls/index.js';
import type { ApiConfig } from './config.js';
import {
  adminDepartmentRoutes,
  userDepartmentRoutes,
} from './departments/index.js';
import { healthRoutes } from './health/index.js';
import { internalAuthHook } from './infra/index.js';
import {
  contactRoutes,
  messageConversationRoutes,
  messageMediaRoutes,
  messageRoutes,
  messageSenderRoutes,
  twilioMessagesWebhookRoutes,
} from './messaging/index.js';
import { adminPhoneNumberRoutes } from './phone-numbers/index.js';
import { internalRoutingRoutes } from './routing/index.js';
import { adminUserRoutes, internalUserRoutes } from './users/index.js';

/** Routes every authenticated user (AGENT, SUPERVISOR, ADMIN) may call. */
export const userApiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.requireAuth);

  await fastify.register(userDepartmentRoutes, { prefix: '/departments' });
  await fastify.register(contactRoutes, { prefix: '/contacts' });
  await fastify.register(messageRoutes, { prefix: '/messages' });
  await fastify.register(messageSenderRoutes, { prefix: '/message-senders' });
  await fastify.register(messageConversationRoutes, {
    prefix: '/message-conversations',
  });
};

/** Every admin route requires the ADMIN role. */
export const adminApiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.requireRole(['ADMIN']));

  await fastify.register(adminStatsRoutes, { prefix: '/stats' });
  await fastify.register(adminUserRoutes, { prefix: '/users' });
  await fastify.register(adminDepartmentRoutes, { prefix: '/departments' });
  await fastify.register(adminPhoneNumberRoutes, { prefix: '/phone-numbers' });
};

/** Routes the call controller calls with the shared internal token. */
export const internalApiRoutes: FastifyPluginAsync<{ token: string }> = async (
  fastify,
  options,
) => {
  fastify.addHook('onRequest', internalAuthHook(options.token));

  await fastify.register(internalRoutingRoutes);
  await fastify.register(internalUserRoutes);
};

/** The whole HTTP surface of the API, grouped by who may call it. */
export async function registerRoutes(
  fastify: FastifyInstance,
  config: ApiConfig,
): Promise<void> {
  await fastify.register(healthRoutes);
  await fastify.register(messageMediaRoutes);
  await fastify.register(authRoutes);
  await fastify.register(sessionRoutes);
  await fastify.register(internalApiRoutes, { token: config.internalApiToken });
  await fastify.register(callRoutes);
  await fastify.register(twilioMessagesWebhookRoutes, {
    prefix: '/webhooks/twilio/messages',
  });
  await fastify.register(userApiRoutes, { prefix: '/api/user' });
  await fastify.register(adminApiRoutes, { prefix: '/api/admin' });
}
