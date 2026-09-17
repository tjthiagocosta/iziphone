import { OutboundCallLinesResponseSchema } from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { authenticatedUser } from '../auth/index.js';
import { CallLineService } from './call-line.service.js';

/** The lines the softphone offers to call from. */
export const callLineRoutes: FastifyPluginAsync = async (fastify) => {
  const callLines = new CallLineService(fastify.db);

  fastify.get('/', async (request, reply) => {
    const lines = await callLines.listOutboundLines(
      authenticatedUser(request).id,
    );
    return reply.send(OutboundCallLinesResponseSchema.parse({ lines }));
  });
};
