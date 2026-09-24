import {
  CompleteMessageMediaUploadSchema,
  MESSAGE_UPLOAD_ALLOWED_MIME_TYPES,
  MessageMediaUploadSlotResponseSchema,
  MessagePreparedMediaSchema,
  RequestMessageMediaUploadSchema,
  SendMmsResponseSchema,
  SendMmsSchema,
  SendSmsResponseSchema,
  SendSmsSchema,
} from '@repo/dto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { authenticatedUser } from '../auth/index.js';
import { MessageConversationService } from './conversation.service.js';
import {
  MessagingMediaError,
  type MessagingMediaErrorCode,
  MessagingMediaService,
} from './media.service.js';
import {
  type MessageSendResult,
  MessageSendService,
  type SendRefusalReason,
} from './send.service.js';
import { MessageSenderService } from './sender.service.js';
import { TwilioMessagesService } from './twilio/messages.service.js';

const REFUSAL_STATUS: Record<SendRefusalReason, number> = {
  sender_not_found: 404,
  conversation_not_found: 404,
  sender_mismatch: 400,
  line_reassigned: 400,
  // Not 409: the composers read 409 as a stored failure and start a new key,
  // and the next press would then send the draft a second time.
  draft_already_sent: 400,
  invalid_destination: 400,
  undeliverable_destination: 400,
  attachment_unavailable: 400,
};

const MEDIA_ERROR_STATUS: Record<MessagingMediaErrorCode, number> = {
  not_found: 404,
  expired: 410,
  consumed: 409,
  not_uploaded: 409,
  empty: 400,
  content_type_mismatch: 415,
  too_large: 413,
};

export const messageRoutes: FastifyPluginAsync = async (fastify) => {
  /* Media uploads arrive as raw bytes; Fastify only parses JSON by default. */
  for (const mimeType of [
    ...MESSAGE_UPLOAD_ALLOWED_MIME_TYPES,
    'application/octet-stream',
  ]) {
    if (!fastify.hasContentTypeParser(mimeType)) {
      fastify.addContentTypeParser(
        mimeType,
        { parseAs: 'buffer' },
        (_request, body, done) => done(null, body),
      );
    }
  }

  const { config, db, log, mediaStore } = fastify;
  const mediaService = new MessagingMediaService({
    db,
    mediaStore,
    publicUrl: config.publicUrl,
    credentials: config.twilio,
    log,
  });
  const sendService = new MessageSendService({
    db,
    transport: new TwilioMessagesService({
      credentials: config.twilio,
      publicUrl: config.publicUrl,
    }),
    senderService: new MessageSenderService(db),
    conversationService: new MessageConversationService(db),
    mediaService,
    log,
  });

  fastify.post('/', async (request, reply) => {
    const input = SendSmsSchema.parse(request.body ?? {});
    const result = await sendService.sendSms(
      authenticatedUser(request).id,
      input,
    );

    return replyWithSendResult(reply, result, SendSmsResponseSchema);
  });

  fastify.post('/mms', async (request, reply) => {
    const input = SendMmsSchema.parse(request.body ?? {});
    const result = await sendService.sendMms(
      authenticatedUser(request).id,
      input,
    );

    return replyWithSendResult(reply, result, SendMmsResponseSchema);
  });

  fastify.post('/media/uploads', async (request, reply) => {
    const input = RequestMessageMediaUploadSchema.parse(request.body ?? {});
    const result = await mediaService.requestUploadSlot(
      authenticatedUser(request).id,
      input,
    );

    return reply
      .status(201)
      .send(MessageMediaUploadSlotResponseSchema.parse(result));
  });

  fastify.put<{
    Params: { preparedMediaId: string };
    Querystring: { token?: string };
  }>('/media/uploads/:preparedMediaId', async (request, reply) => {
    const contentType = request.headers['content-type']?.split(';')[0];
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from((request.body as string | undefined) ?? '');

    try {
      await mediaService.uploadPreparedMedia({
        preparedMediaId: request.params.preparedMediaId,
        token: request.query.token ?? '',
        body,
        contentType,
      });
    } catch (error) {
      if (error instanceof MessagingMediaError) {
        return replyWithMediaError(reply, error);
      }

      throw error;
    }

    return reply.status(204).send();
  });

  fastify.post<{
    Params: { preparedMediaId: string };
  }>('/media/uploads/:preparedMediaId/complete', async (request, reply) => {
    CompleteMessageMediaUploadSchema.parse(request.body ?? {});

    try {
      const result = await mediaService.completeUpload(
        authenticatedUser(request).id,
        request.params.preparedMediaId,
      );

      return reply.status(200).send(MessagePreparedMediaSchema.parse(result));
    } catch (error) {
      if (error instanceof MessagingMediaError) {
        return replyWithMediaError(reply, error);
      }

      throw error;
    }
  });
};

function replyWithSendResult(
  reply: FastifyReply,
  result: MessageSendResult,
  responseSchema: typeof SendSmsResponseSchema,
) {
  switch (result.outcome) {
    case 'sent':
    case 'deduplicated':
      return reply.status(result.outcome === 'sent' ? 201 : 200).send(
        responseSchema.parse({
          conversationId: result.conversationId,
          message: result.message,
          deduplicated: result.outcome === 'deduplicated',
        }),
      );
    case 'suppressed':
      return reply.status(409).send({
        error: 'Conflict',
        message: 'Recipient is suppressed for this sender',
        conversationId: result.conversationId,
        messageRecord: result.message,
      });
    case 'provider_rejected':
      return reply.status(422).send({
        error: 'Unprocessable Entity',
        message: result.reason,
        conversationId: result.conversationId,
        messageRecord: result.message,
      });
    case 'provider_failed':
      return reply.status(502).send({
        error: 'Bad Gateway',
        message: result.reason,
        conversationId: result.conversationId,
        messageRecord: result.message,
      });
    case 'refused': {
      const statusCode = REFUSAL_STATUS[result.reason];
      return reply.status(statusCode).send({
        error: statusCode === 404 ? 'Not Found' : 'Bad Request',
        message: result.detail,
      });
    }
  }
}

function replyWithMediaError(reply: FastifyReply, error: MessagingMediaError) {
  const statusCode = MEDIA_ERROR_STATUS[error.code];
  return reply.status(statusCode).send({
    error: errorLabel(statusCode),
    message: error.message,
  });
}

function errorLabel(statusCode: number) {
  switch (statusCode) {
    case 404:
      return 'Not Found';
    case 409:
      return 'Conflict';
    case 410:
      return 'Gone';
    case 413:
      return 'Payload Too Large';
    case 415:
      return 'Unsupported Media Type';
    default:
      return 'Bad Request';
  }
}
