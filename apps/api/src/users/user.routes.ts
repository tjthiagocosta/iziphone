import type { TeammatesResponse } from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { authenticatedUser } from '../auth/index.js';
import { listTeammates } from './teammates.js';

/** What any signed-in user may read about the people they work with. */
export const userTeammateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async (request) => {
    const teammates = await listTeammates(
      fastify.db,
      authenticatedUser(request).id,
    );

    return { teammates } satisfies TeammatesResponse;
  });
};
