import {
  type CallControlRefusal,
  HoldCallSchema,
  type OutboundGrantRefusal,
  OutboundGrantRequestSchema,
  type OutboundGrantResponse,
  type Role,
  TransferCallSchema,
  toE164PhoneNumber,
  type VoiceHangupResponse,
  type VoiceHoldResponse,
  type VoiceTokenResponse,
  type VoiceTransferCancelResponse,
  type VoiceTransferResponse,
} from '@repo/dto';
import { verifyJWT } from '@repo/events';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { planHangup, REFUSAL_MESSAGES } from './call-control.js';
import type { CallFlow } from './call-flow.js';
import { OUTBOUND_GRANT_REFUSAL_MESSAGES } from './outbound-grant.js';
import type { TelephonyService } from './telephony.service.js';

/*
 * What the softphone calls directly: a Twilio access token to register the
 * browser, the grant to place an outbound call on, and the controls an agent
 * has over a call they are on: hang up, hold and transfer. Requests carry the
 * realtime JWT the API issued; the controls also name the agent's own leg, so
 * each one is checked against the live call and answered with what actually
 * happened to it.
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
  flow: Pick<
    CallFlow,
    | 'grantOutboundCall'
    | 'holdCall'
    | 'transferCall'
    | 'cancelTransfer'
    | 'declineOfferedCall'
  >;
}

const GRANT_REFUSAL_STATUS: Record<OutboundGrantRefusal, number> = {
  'line-unavailable': 409,
  'line-without-voice': 409,
  'line-not-allowed': 403,
};

const REFUSAL_STATUS: Record<CallControlRefusal, number> = {
  'leg-not-found': 404,
  'not-on-call': 403,
  'not-connected': 409,
  'transfer-pending': 409,
  'no-transfer-pending': 409,
  'transfer-to-self': 409,
  'target-on-call': 409,
  'target-offline': 409,
  'call-gone': 409,
  'provider-error': 502,
};

export const voiceRoutes: FastifyPluginAsync<VoiceRouteOptions> = async (
  fastify,
  { telephony, flow },
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

  fastify.post(
    '/api/voice/outbound-grants',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = requireUser(request);

      const body = OutboundGrantRequestSchema.safeParse(request.body);
      const to = body.success ? toE164PhoneNumber(body.data.to) : null;
      const fromNumber = body.success
        ? toE164PhoneNumber(body.data.fromNumber)
        : null;
      if (!to || !fromNumber) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'to and fromNumber must be phone numbers',
        });
      }

      const result = await flow.grantOutboundCall({
        userId: user.id,
        to,
        fromNumber,
      });
      if (!result.ok) {
        return reply.status(GRANT_REFUSAL_STATUS[result.refusal]).send({
          error: 'Refused',
          message: OUTBOUND_GRANT_REFUSAL_MESSAGES[result.refusal],
          code: result.refusal,
        });
      }

      return {
        grant: result.grant,
        expiresInSeconds: result.expiresInSeconds,
      } satisfies OutboundGrantResponse;
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

      // Not every hangup ends the call: while a transfer rings, the other
      // party stays on the line whoever of the two agents leaves.
      const plan = planHangup(state, { userId: user.id, legUuid });
      if (plan !== 'end-call') {
        // The active agent may name a leg that is not theirs; what they
        // release is still their own.
        const ownLegUuid = ownsLeg ? legUuid : state.agentLegUuid;
        if (plan === 'decline-transfer') {
          await flow.declineOfferedCall(state.conversationUuid, user.id);
        } else if (ownLegUuid) {
          await telephony.safeHangup(ownLegUuid);
        }

        request.log.info(
          { userId: user.id, legUuid, plan },
          'Released a leg without ending the call',
        );

        return {
          success: true,
          legUuid,
          conversationUuid: state.conversationUuid,
        } satisfies VoiceHangupResponse;
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

  fastify.post<{ Params: { legUuid: string } }>(
    '/api/voice/calls/:legUuid/hold',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = requireUser(request);
      const { legUuid } = request.params;

      const body = HoldCallSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: 'Bad Request', message: 'hold must be a boolean' });
      }

      const result = await flow.holdCall(
        { userId: user.id, legUuid },
        body.data.hold,
      );
      if (!result.ok) {
        return refuse(reply, result.refusal);
      }

      request.log.info(
        {
          userId: user.id,
          conversationUuid: result.conversationUuid,
          held: result.held,
        },
        'Changed the hold on a call',
      );

      return {
        success: true,
        conversationUuid: result.conversationUuid,
        held: result.held,
      } satisfies VoiceHoldResponse;
    },
  );

  fastify.post<{ Params: { legUuid: string } }>(
    '/api/voice/calls/:legUuid/transfer',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = requireUser(request);
      const { legUuid } = request.params;

      const body = TransferCallSchema.safeParse(request.body);
      if (!body.success) {
        return reply
          .status(400)
          .send({ error: 'Bad Request', message: 'targetUserId is required' });
      }

      const result = await flow.transferCall(
        { userId: user.id, legUuid },
        body.data.targetUserId,
      );
      if (!result.ok) {
        return refuse(reply, result.refusal);
      }

      return {
        success: true,
        conversationUuid: result.conversationUuid,
        targetUserId: result.targetUserId,
      } satisfies VoiceTransferResponse;
    },
  );

  fastify.post<{ Params: { legUuid: string } }>(
    '/api/voice/calls/:legUuid/transfer/cancel',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = requireUser(request);
      const { legUuid } = request.params;

      const result = await flow.cancelTransfer({ userId: user.id, legUuid });
      if (!result.ok) {
        return refuse(reply, result.refusal);
      }

      return {
        success: true,
        conversationUuid: result.conversationUuid,
      } satisfies VoiceTransferCancelResponse;
    },
  );
};

/** Every refusal has the same shape: a status, a sentence and its code. */
function refuse(reply: FastifyReply, refusal: CallControlRefusal) {
  return reply.status(REFUSAL_STATUS[refusal]).send({
    error: 'Refused',
    message: REFUSAL_MESSAGES[refusal],
    code: refusal,
  });
}

/** Only reachable behind `requireAuth`, which always sets the user. */
function requireUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) {
    throw new Error('Route is missing the requireAuth preHandler');
  }
  return request.user;
}
