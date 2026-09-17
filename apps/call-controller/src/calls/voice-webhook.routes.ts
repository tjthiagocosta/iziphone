import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createTwilioSignatureValidator } from '../infra/index.js';
import type { CallFlow } from './call-flow.js';
import { parseConversationName } from './call-state.js';
import type { TelephonyService } from './telephony.service.js';

/*
 * Twilio's webhooks. Bodies are form-encoded; a repeated field arrives as an
 * array, so every field is read through `field`. Responses are TwiML for the
 * calls Twilio is asking about, and 204 for status notifications.
 */

const field = z.preprocess(
  (value) => (Array.isArray(value) ? value[0] : value),
  z.string().min(1).optional(),
);

const seconds = z.preprocess(
  (value) => (Array.isArray(value) ? value[0] : value),
  z.coerce.number().int().nonnegative().optional().catch(undefined),
);

const InboundBodySchema = z.object({
  CallSid: field,
  From: field,
  To: field,
  /*
   * What the softphone passed to `Device.connect` for an outbound call: that
   * it is one, and the grant it was issued for it. Twilio lets those
   * parameters override `From` and `To` as well, so nothing in this body says
   * who is calling; the grant does.
   */
  type: field,
  grant: field,
});

const StatusBodySchema = z.object({
  CallSid: field,
  ConferenceSid: field,
  FriendlyName: field,
  ParticipantLabel: field,
  StatusCallbackEvent: field,
  CallStatus: field,
  CallDuration: seconds,
  RecordingStatus: field,
  RecordingUrl: field,
  RecordingDuration: seconds,
  TranscriptionStatus: field,
  TranscriptionText: field,
});

const StatusQuerySchema = z.object({
  conversationUuid: field,
  context: field,
});

export type VoiceWebhookFlow = Pick<
  CallFlow,
  | 'startOutboundCall'
  | 'acceptInboundCall'
  | 'handleRecordingReady'
  | 'handleTranscriptionReady'
  | 'handleConferenceEvent'
  | 'handleCallStatus'
>;

export interface VoiceWebhookOptions {
  flow: VoiceWebhookFlow;
  telephony: Pick<
    TelephonyService,
    'buildVoicemailCompletionTwiml' | 'buildFallbackTwiml'
  >;
}

export const voiceWebhookRoutes: FastifyPluginAsync<
  VoiceWebhookOptions
> = async (fastify, { flow, telephony }) => {
  const { config } = fastify;

  fastify.addHook(
    'preHandler',
    createTwilioSignatureValidator({
      signer: config.twilio
        ? {
            authToken: config.twilio.authToken,
            publicUrl: config.twilio.webhookBaseUrl,
          }
        : null,
      skipValidation: config.nodeEnv === 'development',
    }),
  );

  fastify.post('/webhooks/twilio/voice/inbound', async (request, reply) => {
    const body = InboundBodySchema.safeParse(request.body);
    if (!body.success || !body.data.CallSid) {
      return reply.status(400).send({ error: 'Invalid webhook payload' });
    }

    const { CallSid: callSid, From: from, To: to } = body.data;

    if (body.data.type === 'outbound-pstn') {
      // A missing grant is for the flow to refuse out loud: the agent is on
      // the line and should hear why.
      return sendTwiml(
        reply,
        await flow.startOutboundCall({ callSid, from, grant: body.data.grant }),
      );
    }

    if (!from || !to) {
      return reply
        .status(400)
        .send({ error: 'Inbound call payload is incomplete' });
    }

    return sendTwiml(
      reply,
      await flow.acceptInboundCall({ callSid, from, to }),
    );
  });

  fastify.post('/webhooks/twilio/voice/status', async (request, reply) => {
    const body = StatusBodySchema.safeParse(request.body);
    const query = StatusQuerySchema.safeParse(request.query);
    if (!body.success || !query.success) {
      return reply.status(400).send({ error: 'Invalid webhook payload' });
    }

    const payload = body.data;
    // Twilio's number-level status callback carries no conversation id. It
    // reports the leg that started the call, whose sid names the conversation.
    const conversationUuid =
      query.data.conversationUuid ??
      (payload.FriendlyName
        ? parseConversationName(payload.FriendlyName)
        : undefined) ??
      (payload.CallStatus ? payload.CallSid : undefined);

    if (!conversationUuid) {
      return reply.status(204).send();
    }

    if (payload.RecordingStatus === 'completed' && payload.RecordingUrl) {
      await flow.handleRecordingReady({
        conversationUuid,
        recordingUrl: payload.RecordingUrl,
        duration: payload.RecordingDuration,
        context: query.data.context,
      });
      return reply.status(204).send();
    }

    if (
      payload.TranscriptionStatus === 'completed' &&
      payload.TranscriptionText
    ) {
      await flow.handleTranscriptionReady({
        conversationUuid,
        transcript: payload.TranscriptionText,
        recordingUrl: payload.RecordingUrl,
        context: query.data.context,
      });
      return reply.status(204).send();
    }

    if (payload.StatusCallbackEvent) {
      await flow.handleConferenceEvent({
        conversationUuid,
        conferenceSid: payload.ConferenceSid,
        event: payload.StatusCallbackEvent,
        legUuid: payload.CallSid,
        participantLabel: payload.ParticipantLabel,
        duration: payload.CallDuration,
      });
      return reply.status(204).send();
    }

    if (payload.CallSid && payload.CallStatus) {
      await flow.handleCallStatus({
        conversationUuid,
        legUuid: payload.CallSid,
        participantLabel: payload.ParticipantLabel,
        status: payload.CallStatus,
        duration: payload.CallDuration,
      });
    }

    return reply.status(204).send();
  });

  fastify.post(
    '/webhooks/twilio/voice/voicemail/completed',
    async (_request, reply) =>
      sendTwiml(reply, telephony.buildVoicemailCompletionTwiml()),
  );

  fastify.post('/webhooks/twilio/voice/fallback', async (_request, reply) =>
    sendTwiml(reply, telephony.buildFallbackTwiml()),
  );
};

function sendTwiml(reply: FastifyReply, twiml: string) {
  return reply.type('text/xml').send(twiml);
}
