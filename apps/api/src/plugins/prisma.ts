import { createPrismaClient, type PrismaClient } from '@repo/db';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    db: PrismaClient;
  }
}

const prismaPlugin: FastifyPluginAsync = async (fastify) => {
  const db = createPrismaClient({
    connectionString: fastify.config.databaseUrl,
    log:
      fastify.config.nodeEnv === 'development'
        ? ['query', 'error', 'warn']
        : ['error'],
  });

  fastify.decorate('db', db);

  fastify.addHook('onClose', async () => {
    await db.$disconnect();
  });
};

export default fp(prismaPlugin, {
  name: 'prisma',
});
