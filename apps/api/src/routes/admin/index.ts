import type { FastifyPluginAsync } from 'fastify';
import departmentRoutes from './departments.js';
import phoneNumberRoutes from './phone-numbers.js';
import statsRoutes from './stats.js';
import userRoutes from './users.js';

/** Every admin route requires the ADMIN role. */
const adminRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', fastify.requireRole(['ADMIN']));

  await fastify.register(statsRoutes, { prefix: '/stats' });
  await fastify.register(userRoutes, { prefix: '/users' });
  await fastify.register(departmentRoutes, { prefix: '/departments' });
  await fastify.register(phoneNumberRoutes, { prefix: '/phone-numbers' });
};

export default adminRoutes;
