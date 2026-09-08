import type { FastifyPluginAsync } from 'fastify';
import twilio from 'twilio';
import { createTwilioSignatureValidator } from '../../../middleware/twilio-validation.js';
import { MessageConversationService } from '../../../services/messaging/message-conversation.service.js';
import { MessageWebhookService } from '../../../services/messaging/message-webhook.service.js';
import { MessagingMediaService } from '../../../services/messaging/messaging-media.service.js';
import { TwilioMessagesService } from '../../../services/messaging/providers/twilio-messages.service.js';

const twilioMessagesWebhookRoutes: FastifyPluginAsync = async (fastify) => {
  const { config, db, log } = fastify;
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
      storageDir: config.messagingMediaStorageDir,
      publicUrl: config.publicUrl,
      credentials: config.twilio,
      log,
    }),
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

export default twilioMessagesWebhookRoutes;
