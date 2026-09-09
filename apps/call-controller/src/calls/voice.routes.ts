import type { Role, VoiceHangupResponse, VoiceTokenResponse } from '@repo/dto';
import { verifyJWT } from '@repo/events';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { TelephonyService } from './telephony.service.js';

/*
 * What the softphone calls directly: a Twilio access token to register the
 * browser as a client, and an authoritative hangup for a leg it is on.
 * Requests carry the realtime JWT the API issued.
 */

interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

export interface VoiceRouteOptions {
  telephony: Pick<
    TelephonyService,
    | 'isConfigured'
    | 'ensureUser'
    | 'generateClientJwt'
    | 'getLegMetadata'
    | 'getCallState'
    | 'safeHangup'
    | 'requestConversationHangup'
  >;
}

export const voiceRoutes: FastifyPluginAsync<VoiceRouteOptions> = async (
  fastify,
  { telephony },
) => {
  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply
        .status(401)
        .send({ error: 'Unauthorized', message: 'Bearer token required' });
    }

    try {
      const claims = await verifyJWT(
        header.slice('Bearer '.length),
        fastify.config.authSecret,
      );
      request.user = { id: claims.sub, email: claims.email, role: claims.role };
    } catch {
      return reply
        .status(401)
        .send({ error: 'Unauthorized', message: 'Invalid token' });
    }
  };

  fastify.get(
    '/api/voice/jwt',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = requireUser(request);

      if (!telephony.isConfigured()) {
        return reply.status(503).send({ error: 'Voice is not configured' });
      }

      await telephony.ensureUser(user.id);
      const jwt = telephony.generateClientJwt(user.id);

      request.log.info({ userId: user.id }, 'Issued a Twilio client token');

      return {
        jwt,
        identity: user.id,
        provider: 'twilio',
      } satisfies VoiceTokenResponse;
    },
  );

  fastify.post<{ Params: { legUuid: string } }>(
    '/api/voice/calls/:legUuid/hangup',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = requireUser(request);
      const { legUuid } = request.params;

      const metadata = await telephony.getLegMetadata(legUuid);
      if (!metadata) {
        return reply.status(404).send({ error: 'Call leg not found' });
      }

      const state = await telephony.getCallState(metadata.conversationUuid);
      const ownsLeg =
        metadata.participantType === 'agent' &&
        metadata.participantId === user.id;
      const isActiveAgent = state?.activeAgentUserId === user.id;

      if (!ownsLeg && !isActiveAgent) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      if (!state) {
        await telephony.safeHangup(legUuid);
        return { success: true, legUuid } satisfies VoiceHangupResponse;
      }

      const ending = await telephony.requestConversationHangup(
        state.conversationUuid,
        user.id,
      );

      request.log.info(
        {
          userId: user.id,
          legUuid,
          conversationUuid: ending?.conversationUuid,
        },
        'Accepted hangup request',
      );

      return {
        success: true,
        legUuid,
        conversationUuid: ending?.conversationUuid,
      } satisfies VoiceHangupResponse;
    },
  );
};

/** Only reachable behind `requireAuth`, which always sets the user. */
function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) {
    throw new Error('Route is missing the requireAuth preHandler');
  }
  return request.user;
}
