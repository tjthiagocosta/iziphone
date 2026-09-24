import type { Prisma, PrismaClient } from '@repo/db';
import {
  canReceiveMessages,
  type Message,
  normalizePhoneNumber,
  type SendMms,
  type SendSms,
} from '@repo/dto';
import type { MessageConversationService } from './conversation.service.js';
import {
  isLineOwnersThread,
  isSameOwner,
  lineOwnerOf,
} from './conversation-scope.js';
import type { MessagingLogger } from './logger.js';
import {
  MessagingMediaError,
  type MessagingMediaService,
} from './media.service.js';
import {
  type MessageRecord,
  messageRecordInclude,
  toMessageDto,
} from './message-record.js';
import type { AllowedSender, MessageSenderService } from './sender.service.js';
import type {
  MessagingTransport,
  MessagingTransportSendSuccess,
} from './transport.js';
import {
  TwilioMessagesApiError,
  TwilioMessagesTransportError,
} from './twilio/messages.service.js';

/*
 * A replayed idempotency key may race an in-flight send whose message is
 * still PENDING. Polling briefly lets the first attempt settle so the replay
 * returns its final status instead of a transient one.
 */
const IDEMPOTENCY_SETTLE_ATTEMPTS = 5;
const IDEMPOTENCY_SETTLE_DELAY_MS = 25;

export interface MessageSendServiceOptions {
  db: PrismaClient;
  transport: Pick<MessagingTransport, 'sendSms' | 'sendMms'>;
  senderService: Pick<
    MessageSenderService,
    'getAllowedSmsSender' | 'getAllowedMmsSender'
  >;
  conversationService: Pick<
    MessageConversationService,
    'getAccessibleRecordForUser' | 'findOrCreateFor'
  >;
  mediaService: Pick<
    MessagingMediaService,
    'getPreparedMediaForSend' | 'promotePreparedMediaToMessage'
  >;
  log: MessagingLogger;
}

/** Why a send never produced a message. */
export type SendRefusalReason =
  | 'sender_not_found'
  | 'conversation_not_found'
  | 'sender_mismatch'
  | 'line_reassigned'
  | 'invalid_destination'
  | 'undeliverable_destination'
  | 'attachment_unavailable';

export type MessageSendResult =
  | { outcome: 'sent'; conversationId: string; message: Message }
  | { outcome: 'deduplicated'; conversationId: string; message: Message }
  | { outcome: 'suppressed'; conversationId: string; message: Message }
  | {
      outcome: 'provider_rejected';
      conversationId: string;
      message: Message;
      reason: string;
    }
  | {
      outcome: 'provider_failed';
      conversationId: string;
      message: Message;
      reason: string;
    }
  | { outcome: 'refused'; reason: SendRefusalReason; detail: string };

interface SendTarget {
  conversationId?: string | undefined;
  to?: string | undefined;
  idempotencyKey: string;
}

interface PendingOutbound {
  from: string;
  to: string;
  body: string | null;
  clientReference: string;
}

/** The parts of a send that differ between SMS and MMS. */
interface OutboundChannel {
  channel: 'SMS' | 'MMS';
  sender: AllowedSender;
  body: string | null;
  dispatch(message: PendingOutbound): Promise<MessagingTransportSendSuccess>;
  /** Runs after the provider accepted the message; owns its own writes. */
  attach?(messageId: string): Promise<void>;
}

type Preparation =
  | { kind: 'refused'; reason: SendRefusalReason; detail: string }
  | {
      kind: 'deduplicated' | 'suppressed' | 'pending';
      conversationId: string;
      message: MessageRecord;
    };

export class MessageSendService {
  private readonly db: PrismaClient;
  private readonly transport: MessageSendServiceOptions['transport'];
  private readonly senderService: MessageSendServiceOptions['senderService'];
  private readonly conversationService: MessageSendServiceOptions['conversationService'];
  private readonly mediaService: MessageSendServiceOptions['mediaService'];
  private readonly log: MessagingLogger;

  constructor(options: MessageSendServiceOptions) {
    this.db = options.db;
    this.transport = options.transport;
    this.senderService = options.senderService;
    this.conversationService = options.conversationService;
    this.mediaService = options.mediaService;
    this.log = options.log;
  }

  async sendSms(userId: string, input: SendSms): Promise<MessageSendResult> {
    const sender = await this.senderService.getAllowedSmsSender(
      userId,
      input.fromPhoneNumberId,
    );

    if (!sender) {
      return refused('sender_not_found', 'Sender number not found');
    }

    return this.send(userId, input, {
      channel: 'SMS',
      sender,
      body: input.body,
      dispatch: (message) =>
        this.transport.sendSms({
          from: message.from,
          to: message.to,
          text: message.body ?? '',
          clientReference: message.clientReference,
        }),
    });
  }

  async sendMms(userId: string, input: SendMms): Promise<MessageSendResult> {
    const sender = await this.senderService.getAllowedMmsSender(
      userId,
      input.fromPhoneNumberId,
    );

    if (!sender) {
      return refused('sender_not_found', 'Sender number not found');
    }

    const [attachmentId] = input.attachmentIds;
    if (!attachmentId) {
      return refused('attachment_unavailable', 'Prepared media not found');
    }

    let preparedMedia: Awaited<
      ReturnType<MessagingMediaService['getPreparedMediaForSend']>
    >;

    try {
      preparedMedia = await this.mediaService.getPreparedMediaForSend(
        userId,
        attachmentId,
      );
    } catch (error) {
      if (error instanceof MessagingMediaError) {
        return refused('attachment_unavailable', error.message);
      }

      throw error;
    }

    return this.send(userId, input, {
      channel: 'MMS',
      sender,
      body: input.body ?? null,
      dispatch: (message) =>
        this.transport.sendMms({
          from: message.from,
          to: message.to,
          text: message.body,
          clientReference: message.clientReference,
          mediaUrl: preparedMedia.publicUrl,
          mediaType: preparedMedia.mimeType,
        }),
      attach: async (messageId) => {
        await this.mediaService.promotePreparedMediaToMessage({
          messageId,
          preparedMediaId: preparedMedia.id,
        });
      },
    });
  }

  private async send(
    userId: string,
    target: SendTarget,
    outbound: OutboundChannel,
  ): Promise<MessageSendResult> {
    const preparation = await this.prepare(userId, target, outbound);

    if (preparation.kind === 'refused') {
      return refused(preparation.reason, preparation.detail);
    }

    const { conversationId, message } = preparation;
    const logContext = {
      messageId: message.id,
      conversationId,
      senderId: outbound.sender.id,
      channel: outbound.channel,
    };

    if (preparation.kind === 'deduplicated') {
      this.log.info(
        { ...logContext, finalStatus: message.status },
        'Message send deduplicated',
      );
      return {
        outcome: 'deduplicated',
        conversationId,
        message: toMessageDto(message),
      };
    }

    if (preparation.kind === 'suppressed') {
      this.log.warn(
        { ...logContext, failureCode: message.failureCode },
        'Message send blocked by suppression',
      );
      return {
        outcome: 'suppressed',
        conversationId,
        message: toMessageDto(message),
      };
    }

    const attemptedAt = new Date().toISOString();
    this.log.info(logContext, 'Sending outbound message');

    let accepted: MessagingTransportSendSuccess;

    try {
      accepted = await outbound.dispatch({
        from: message.from,
        to: message.to,
        body: message.body,
        clientReference: target.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof TwilioMessagesApiError) {
        const failed = await this.recordProviderFailure(message.id, {
          status: error.retriable ? 'FAILED' : 'REJECTED',
          failureCode: error.errorCode,
          failureReason: error.errorDetail,
          attemptedAt,
          error,
        });
        this.log.warn(
          {
            ...logContext,
            finalStatus: failed.status,
            failureCode: failed.failureCode,
            requestId: error.requestId,
          },
          'Message rejected or failed by provider response',
        );
        return {
          outcome: error.retriable ? 'provider_failed' : 'provider_rejected',
          conversationId,
          message: toMessageDto(failed),
          reason: error.errorDetail,
        };
      }

      if (error instanceof TwilioMessagesTransportError) {
        const failed = await this.recordProviderFailure(message.id, {
          status: 'FAILED',
          failureCode: 'provider_transport_error',
          failureReason: error.message,
          attemptedAt,
          error,
        });
        this.log.error(
          {
            ...logContext,
            finalStatus: failed.status,
            failureCode: failed.failureCode,
            requestId: error.requestId,
          },
          'Message send failed before provider acceptance',
        );
        return {
          outcome: 'provider_failed',
          conversationId,
          message: toMessageDto(failed),
          reason: error.message,
        };
      }

      throw error;
    }

    /*
     * From here on the provider owns the message. Anything that fails below
     * is a local problem and must not be recorded as a delivery failure.
     */
    let acceptedMessage = await this.db.message.update({
      where: { id: message.id },
      data: {
        status: 'ACCEPTED',
        providerMessageId: accepted.providerMessageId,
        providerPayload: toInputJsonObject({
          attemptedAt,
          request: accepted.request,
          response: accepted.response,
          responseHeaders: accepted.responseHeaders,
          requestId: accepted.requestId,
          provider: accepted.provider,
          clientReference: accepted.clientReference,
        }),
        sentAt: new Date(),
        failedAt: null,
        failureCode: null,
        failureReason: null,
      },
      include: messageRecordInclude,
    });

    if (outbound.attach) {
      await outbound.attach(acceptedMessage.id);
      acceptedMessage = await this.db.message.findUniqueOrThrow({
        where: { id: acceptedMessage.id },
        include: messageRecordInclude,
      });
    }

    this.log.info(
      {
        ...logContext,
        finalStatus: acceptedMessage.status,
        providerMessageId: accepted.providerMessageId,
        requestId: accepted.requestId,
      },
      'Message accepted by provider',
    );

    return {
      outcome: 'sent',
      conversationId,
      message: toMessageDto(acceptedMessage),
    };
  }

  /**
   * Resolves the conversation, applies idempotency and suppression, and
   * creates the PENDING message, all in one transaction. A unique-key race on
   * the idempotency key resolves to the winning attempt's message.
   */
  private async prepare(
    userId: string,
    target: SendTarget,
    outbound: OutboundChannel,
  ): Promise<Preparation> {
    let resolvedConversationId: string | null = null;

    try {
      return await this.db.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const conversation = await this.resolveConversation(
            tx,
            userId,
            target,
            outbound.sender,
          );

          if ('reason' in conversation) {
            return {
              kind: 'refused',
              reason: conversation.reason,
              detail: conversation.detail,
            } satisfies Preparation;
          }

          resolvedConversationId = conversation.id;

          const existingMessage = await this.waitForSettledIdempotentMessage(
            tx,
            conversation.id,
            target.idempotencyKey,
          );

          if (existingMessage) {
            return {
              kind: 'deduplicated',
              conversationId: conversation.id,
              message: existingMessage,
            } satisfies Preparation;
          }

          const suppression = await tx.messageSuppression.findFirst({
            where: {
              contactId: conversation.contactId,
              sourcePhoneNumberId: conversation.sourcePhoneNumberId,
              releasedAt: null,
            },
            select: {
              keyword: true,
              reason: true,
            },
          });

          const outboundBase = {
            conversationId: conversation.id,
            clientReference: target.idempotencyKey,
            body: outbound.body,
            from: outbound.sender.phoneNumber,
            to: conversation.contact.phoneNumber,
            channel: outbound.channel,
          };

          if (suppression) {
            const message = await this.createOutboundMessage(tx, {
              ...outboundBase,
              status: 'FAILED',
              failureCode: 'recipient_suppressed',
              failureReason: suppression.reason,
              providerPayload: {
                attemptedAt: new Date().toISOString(),
                error: {
                  code: 'recipient_suppressed',
                  message: suppression.reason,
                  keyword: suppression.keyword,
                },
              },
            });

            return {
              kind: 'suppressed',
              conversationId: conversation.id,
              message,
            } satisfies Preparation;
          }

          const message = await this.createOutboundMessage(tx, {
            ...outboundBase,
            status: 'PENDING',
          });

          return {
            kind: 'pending',
            conversationId: conversation.id,
            message,
          } satisfies Preparation;
        },
      );
    } catch (error) {
      if (isUniqueConstraintError(error) && resolvedConversationId) {
        const existingMessage = await this.waitForSettledIdempotentMessage(
          this.db,
          resolvedConversationId,
          target.idempotencyKey,
        );

        if (existingMessage) {
          return {
            kind: 'deduplicated',
            conversationId: resolvedConversationId,
            message: existingMessage,
          };
        }
      }

      throw error;
    }
  }

  private async resolveConversation(
    tx: Prisma.TransactionClient,
    userId: string,
    target: SendTarget,
    sender: AllowedSender,
  ) {
    if (target.conversationId) {
      const conversation =
        await this.conversationService.getAccessibleRecordForUser(
          userId,
          target.conversationId,
          tx,
        );

      if (!conversation) {
        return refusal(
          'conversation_not_found',
          'Message conversation not found',
        );
      }

      if (conversation.sourcePhoneNumberId !== sender.id) {
        return refusal(
          'sender_mismatch',
          'Conversation sender does not match fromPhoneNumberId',
        );
      }

      /*
       * The line has changed hands since this thread began. Its history stays
       * with the owner it was started under, and a message sent now belongs
       * to the new owner's thread, which a new conversation reaches. Somebody
       * who can read both, a member of the old and the new department, would
       * otherwise write into a thread its new owner cannot see.
       *
       * The owner is the one read with the thread, inside this transaction,
       * rather than taken from `sender`, which was loaded before it and before
       * any media lookup: a reassignment in between would otherwise be missed.
       */
      if (!isLineOwnersThread(conversation, conversation.sourcePhoneNumber)) {
        return refusal(
          'line_reassigned',
          'This number has changed hands since this conversation; start a new conversation to message this contact from it',
        );
      }

      /*
       * A thread can exist with somebody who cannot be written to: a brand
       * texting from a name has no address a reply could be routed to. Refuse
       * it here instead of paying the provider to reject it.
       */
      if (!canReceiveMessages(conversation.contact.phoneNumber)) {
        return refusal(
          'undeliverable_destination',
          'This sender cannot receive replies',
        );
      }

      return conversation;
    }

    const destination = normalizePhoneNumber(target.to ?? '');

    if (!destination) {
      return refusal(
        'invalid_destination',
        'Phone number must be a valid E.164 or 10-digit North American number',
      );
    }

    /*
     * Filed under the owner the sender was allowed to write as, and only if
     * the line is still an active line of theirs as this transaction reads it;
     * `sender` was loaded before it. Otherwise the message would land in the
     * thread of whoever took the line over, sent from a line its writer no
     * longer holds.
     */
    const line = await tx.phoneNumber.findFirst({
      where: { id: sender.id, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, userId: true, departmentId: true },
    });
    const holder = line && lineOwnerOf(line);
    const writer = lineOwnerOf(sender);

    if (!line || !holder || !writer || !isSameOwner(holder, writer)) {
      return refusal(
        'line_reassigned',
        'This number changed hands while the message was being sent; nothing was sent',
      );
    }

    return this.conversationService.findOrCreateFor(destination, line, tx);
  }

  private async createOutboundMessage(
    tx: Prisma.TransactionClient,
    input: {
      conversationId: string;
      clientReference: string;
      body: string | null;
      from: string;
      to: string;
      channel: 'SMS' | 'MMS';
      status: 'PENDING' | 'FAILED';
      failureCode?: string;
      failureReason?: string;
      providerPayload?: Prisma.InputJsonValue;
    },
  ): Promise<MessageRecord> {
    const message = await tx.message.create({
      data: {
        conversationId: input.conversationId,
        direction: 'OUTBOUND',
        channel: input.channel,
        status: input.status,
        body: input.body,
        from: input.from,
        to: input.to,
        clientReference: input.clientReference,
        failedAt: input.status === 'FAILED' ? new Date() : null,
        failureCode: input.failureCode ?? null,
        failureReason: input.failureReason ?? null,
        providerPayload: input.providerPayload,
      },
      include: messageRecordInclude,
    });

    await tx.messageConversation.update({
      where: { id: input.conversationId },
      data: {
        lastMessageAt: message.createdAt,
      },
    });

    return message;
  }

  private async recordProviderFailure(
    messageId: string,
    failure: {
      status: 'FAILED' | 'REJECTED';
      failureCode: string | null;
      failureReason: string;
      attemptedAt: string;
      error: TwilioMessagesApiError | TwilioMessagesTransportError;
    },
  ): Promise<MessageRecord> {
    return this.db.message.update({
      where: { id: messageId },
      data: {
        status: failure.status,
        providerPayload: toInputJsonObject({
          attemptedAt: failure.attemptedAt,
          request: failure.error.request,
          error: {
            name: failure.error.name,
            message: failure.error.message,
            responseBody: failure.error.responseBody,
          },
          responseStatus: failure.error.responseStatus,
          responseHeaders: failure.error.responseHeaders,
          requestId: failure.error.requestId,
        }),
        failedAt: new Date(),
        failureCode: failure.failureCode,
        failureReason: failure.failureReason,
        sentAt: null,
      },
      include: messageRecordInclude,
    });
  }

  private async waitForSettledIdempotentMessage(
    dbClient: Pick<PrismaClient, 'message'> | Prisma.TransactionClient,
    conversationId: string,
    clientReference: string,
  ): Promise<MessageRecord | null> {
    for (let attempt = 0; attempt < IDEMPOTENCY_SETTLE_ATTEMPTS; attempt += 1) {
      const message = await dbClient.message.findUnique({
        where: {
          conversationId_clientReference: {
            conversationId,
            clientReference,
          },
        },
        include: messageRecordInclude,
      });

      if (!message) {
        return null;
      }

      if (
        message.status !== 'PENDING' ||
        attempt === IDEMPOTENCY_SETTLE_ATTEMPTS - 1
      ) {
        return message;
      }

      await delay(IDEMPOTENCY_SETTLE_DELAY_MS);
    }

    return null;
  }
}

function refused(reason: SendRefusalReason, detail: string): MessageSendResult {
  return { outcome: 'refused', reason, detail };
}

function refusal(reason: SendRefusalReason, detail: string) {
  return { reason, detail };
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toInputJsonObject(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}
