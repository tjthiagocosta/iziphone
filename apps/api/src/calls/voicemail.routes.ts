import { CallConversationParamsSchema } from '@repo/dto';
import type { FastifyPluginAsync } from 'fastify';
import { authenticatedUser } from '../auth/index.js';
import { loadCallScope } from './call-scope.js';
import { VoicemailService } from './voicemail.service.js';

/**
 * The audio of a call's voicemail, for anyone who may see the call (see
 * call-scope). Listening to a voicemail is part of working a line, so it
 * follows the call's visibility rather than `recordings:listen`, which is
 * about recordings of the conversations themselves.
 */
export const voicemailRoutes: FastifyPluginAsync = async (fastify) => {
  const voicemail = new VoicemailService(
    fastify.db,
    fastify.config.twilio,
    fastify.log,
  );

  fastify.get(
    '/api/calls/:conversationUuid/voicemail',
    {
      preHandler: [fastify.requireAuth],
      // A HEAD would fetch and drain the whole recording to answer nothing.
      exposeHeadRoute: false,
    },
    async (request, reply) => {
      const user = authenticatedUser(request);
      const { conversationUuid } = CallConversationParamsSchema.parse(
        request.params,
      );

      const media = await voicemail.open(
        await loadCallScope(fastify.db, user),
        conversationUuid,
      );

      reply
        .header('content-type', media.contentType)
        // Who may hear it can change, so every play is authorized afresh.
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff');

      if (media.contentLength !== null) {
        reply.header('content-length', media.contentLength);
      }

      return reply.send(media.stream);
    },
  );
};
