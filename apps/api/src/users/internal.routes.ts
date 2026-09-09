import { SyncTelephonyUserSchema } from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';

/** Called by the call controller once it knows a user's provider identity. */
export const internalUserRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { userId: string } }>(
    '/internal/users/:userId/telephony',
    async (request, reply) => {
      const body = SyncTelephonyUserSchema.parse(request.body);
      const { userId } = request.params;
      const user = await fastify.db.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { id: true },
      });

      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      await fastify.db.user.update({
        where: { id: userId },
        data: { telephonyUserId: body.telephonyUserId },
      });

      return reply.send({ userId, telephonyUserId: body.telephonyUserId });
    },
  );
};
