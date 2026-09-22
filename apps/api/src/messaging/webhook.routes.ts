import type { FastifyPluginAsync } from 'fastify';
import twilio from 'twilio';
import { MessageActivityNotifier } from './activity-notifier.js';
import { MessageConversationService } from './conversation.service.js';
import { MessagingMediaService } from './media.service.js';
import { TwilioMessagesService } from './twilio/messages.service.js';
import { createTwilioSignatureValidator } from './twilio/signature-validator.js';
import { MessageWebhookService } from './webhook.service.js';

export const twilioMessagesWebhookRoutes: FastifyPluginAsync = async (
  fastify,
) => {
  const { config, db, log, mediaStore, redis } = fastify;
  const validateTwilioSignature = createTwilioSignatureValidator({
    authToken: config.twilio?.authToken ?? null,
    publicUrl: config.publicUrl,
    skipValidation: config.nodeEnv === 'development',
  });
  const webhookService = new MessageWebhookService({
    db,
    transport: new TwilioMessagesService({
      credentials: config.twilio,
      publicUrl: config.publicUrl,
    }),
    conversationService: new MessageConversationService(db),
    mediaService: new MessagingMediaService({
      db,
      mediaStore,
      publicUrl: config.publicUrl,
      credentials: config.twilio,
      log,
    }),
    activity: new MessageActivityNotifier({ db, redis, log }),
    log,
  });

  fastify.post(
    '/inbound',
    { preHandler: validateTwilioSignature },
    async (request, reply) => {
      await webhookService.processInboundEvent(request.body);

      reply.type('text/xml');
      return reply.send(new twilio.twiml.MessagingResponse().toString());
    },
  );

  fastify.post(
    '/status',
    { preHandler: validateTwilioSignature },
    async (request, reply) => {
      await webhookService.processStatusEvent(request.body);
      return reply.status(204).send();
    },
  );
};
