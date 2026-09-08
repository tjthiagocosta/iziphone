import type { Prisma, PrismaClient } from '@repo/db';
import type { MessageConversationService } from './message-conversation.service.js';
import type { MessagingLogger } from './messaging-logger.js';
import type { MessagingMediaService } from './messaging-media.service.js';
import type {
  MessagingTransport,
  MessagingTransportInboundEvent,
  MessagingTransportStatusEvent,
} from './providers/messaging-transport.js';

/*
 * Carrier-mandated opt-out and opt-in words. A message consisting of exactly
 * one of these changes the suppression state for the contact and sender pair.
 */
const STOP_KEYWORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
]);
const START_KEYWORDS = new Set(['START', 'YES', 'UNSTOP']);

export interface MessageWebhookServiceOptions {
  db: PrismaClient;
  transport: Pick<
    MessagingTransport,
    'normalizeInboundEvent' | 'normalizeStatusEvent'
  >;
  conversationService: Pick<MessageConversationService, 'findOrCreateFor'>;
  mediaService: Pick<MessagingMediaService, 'ingestInboundMedia'>;
  log: Pick<MessagingLogger, 'info' | 'warn'>;
}

export interface WebhookProcessResult {
  outcome: 'processed' | 'deduplicated' | 'quarantined' | 'orphaned';
}

type OptOutAction =
  | { action: 'suppress'; keyword: string }
  | { action: 'release'; keyword: string }
  | null;

export class MessageWebhookService {
  private readonly db: PrismaClient;
  private readonly transport: MessageWebhookServiceOptions['transport'];
  private readonly conversationService: MessageWebhookServiceOptions['conversationService'];
  private readonly mediaService: MessageWebhookServiceOptions['mediaService'];
  private readonly log: MessageWebhookServiceOptions['log'];

  constructor(options: MessageWebhookServiceOptions) {
    this.db = options.db;
    this.transport = options.transport;
    this.conversationService = options.conversationService;
    this.mediaService = options.mediaService;
    this.log = options.log;
  }

  async processInboundEvent(payload: unknown): Promise<WebhookProcessResult> {
    const event = this.transport.normalizeInboundEvent(payload);
    const dedupeKey = `inbound:${event.providerMessageId}`;

    try {
      const result = await this.db.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const providerEvent = await tx.messageProviderEvent.create({
            data: {
              provider: 'TWILIO',
              eventType: 'INBOUND',
              providerMessageId: event.providerMessageId,
              dedupeKey,
              payload: toInputJsonValue(event.rawPayload),
            },
          });

          const sourcePhoneNumber = await tx.phoneNumber.findFirst({
            where: {
              phoneNumber: event.to,
              deletedAt: null,
              status: 'ACTIVE',
              ...(event.channel === 'MMS'
                ? { mmsEnabled: true }
                : { smsEnabled: true }),
            },
            select: {
              id: true,
            },
          });

          if (!sourcePhoneNumber) {
            await tx.messageProviderEvent.update({
              where: { id: providerEvent.id },
              data: {
                processingState: 'QUARANTINED',
                processingError: 'Unknown or inactive destination number',
                processedAt: new Date(),
              },
            });

            this.log.warn(
              {
                providerMessageId: event.providerMessageId,
                toLastFour: event.to.slice(-4),
                channel: event.channel,
              },
              'Quarantined inbound message for unknown destination number',
            );

            return { outcome: 'quarantined' } as const;
          }

          const conversation = await this.conversationService.findOrCreateFor(
            event.from,
            sourcePhoneNumber.id,
            tx,
          );

          const message = await tx.message.create({
            data: {
              conversationId: conversation.id,
              direction: 'INBOUND',
              channel: event.channel,
              status: 'RECEIVED',
              body: event.body,
              from: event.from,
              to: event.to,
              providerMessageId: event.providerMessageId,
              providerTimestamp: new Date(event.providerTimestamp),
              providerPayload: toInputJsonValue({
                event: 'inbound',
                payload: event.rawPayload,
              }),
            },
          });

          await tx.messageConversation.update({
            where: { id: conversation.id },
            data: {
              unreadCount: {
                increment: 1,
              },
              lastMessageAt: message.createdAt,
            },
          });

          const optOut = resolveOptOut(event);
          const suppressionPair = {
            contactId: conversation.contactId,
            sourcePhoneNumberId: conversation.sourcePhoneNumberId,
          };

          if (optOut?.action === 'suppress') {
            await tx.messageSuppression.upsert({
              where: { contactId_sourcePhoneNumberId: suppressionPair },
              update: {
                keyword: optOut.keyword,
                reason: 'Inbound STOP keyword',
                suppressedAt: message.createdAt,
                releasedAt: null,
              },
              create: {
                ...suppressionPair,
                keyword: optOut.keyword,
                reason: 'Inbound STOP keyword',
                suppressedAt: message.createdAt,
              },
            });
          } else if (optOut?.action === 'release') {
            await tx.messageSuppression.updateMany({
              where: { ...suppressionPair, releasedAt: null },
              data: { releasedAt: message.createdAt },
            });
          }

          await tx.messageProviderEvent.update({
            where: { id: providerEvent.id },
            data: {
              messageId: message.id,
              conversationId: conversation.id,
              processingState: 'PROCESSED',
              processedAt: new Date(),
            },
          });

          this.log.info(
            {
              providerMessageId: event.providerMessageId,
              messageId: message.id,
              conversationId: conversation.id,
              channel: event.channel,
              optOut: optOut?.action ?? null,
            },
            'Processed inbound message webhook',
          );

          return { outcome: 'processed', messageId: message.id } as const;
        },
      );

      if (result.outcome === 'processed' && event.media.length > 0) {
        await this.ingestMedia(result.messageId, event);
      }

      return { outcome: result.outcome };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { outcome: 'deduplicated' };
      }

      throw error;
    }
  }

  async processStatusEvent(payload: unknown): Promise<WebhookProcessResult> {
    const event = this.transport.normalizeStatusEvent(payload);
    const dedupeKey = statusDedupeKey(event);

    try {
      return await this.db.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const providerEvent = await tx.messageProviderEvent.create({
            data: {
              provider: 'TWILIO',
              eventType: 'STATUS',
              providerMessageId: event.providerMessageId,
              dedupeKey,
              payload: toInputJsonValue(event.rawPayload),
            },
          });

          const message = await tx.message.findUnique({
            where: {
              providerMessageId: event.providerMessageId,
            },
            select: {
              id: true,
              conversationId: true,
              status: true,
            },
          });

          if (!message) {
            await tx.messageProviderEvent.update({
              where: { id: providerEvent.id },
              data: {
                processingState: 'ORPHANED',
                processingError: 'No message found for provider message id',
                processedAt: new Date(),
              },
            });

            this.log.warn(
              {
                providerMessageId: event.providerMessageId,
                providerStatus: event.providerStatus,
              },
              'Received orphaned message status webhook',
            );

            return { outcome: 'orphaned' } satisfies WebhookProcessResult;
          }

          const nextStatus = mapProviderStatusToMessageStatus(event);
          const applyTransition = shouldApplyStatusTransition(
            message.status,
            nextStatus,
          );

          if (applyTransition) {
            const isFailure =
              nextStatus === 'FAILED' || nextStatus === 'REJECTED';

            await tx.message.update({
              where: { id: message.id },
              data: {
                status: nextStatus,
                deliveredAt:
                  nextStatus === 'DELIVERED'
                    ? new Date(event.providerTimestamp)
                    : undefined,
                failedAt: isFailure
                  ? new Date(event.providerTimestamp)
                  : undefined,
                failureCode: isFailure ? event.errorCode : null,
                failureReason: isFailure ? event.errorText : null,
                statusPayload: toInputJsonValue({
                  providerStatus: event.providerStatus,
                  error: {
                    code: event.errorCode,
                    detail: event.errorText,
                    type: event.errorType,
                  },
                  payload: event.rawPayload,
                }),
              },
            });
          }

          await tx.messageProviderEvent.update({
            where: { id: providerEvent.id },
            data: {
              messageId: message.id,
              conversationId: message.conversationId,
              processingState: 'PROCESSED',
              processedAt: new Date(),
            },
          });

          this.log.info(
            {
              providerMessageId: event.providerMessageId,
              messageId: message.id,
              conversationId: message.conversationId,
              providerStatus: event.providerStatus,
              finalStatus: applyTransition ? nextStatus : message.status,
            },
            'Processed message status webhook',
          );

          return { outcome: 'processed' } satisfies WebhookProcessResult;
        },
      );
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return { outcome: 'deduplicated' };
      }

      throw error;
    }
  }

  /** The message is already stored; a media failure must not fail the webhook. */
  private async ingestMedia(
    messageId: string,
    event: MessagingTransportInboundEvent,
  ) {
    try {
      await this.mediaService.ingestInboundMedia(messageId, event.media);
    } catch (error) {
      this.log.warn(
        {
          providerMessageId: event.providerMessageId,
          messageId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Inbound MMS media ingestion failed after message persistence',
      );
    }
  }
}

/**
 * Twilio flags recognised keywords in OptOutType; without it, a body that is
 * exactly one keyword counts. Any other body leaves the suppression alone.
 */
function resolveOptOut(event: MessagingTransportInboundEvent): OptOutAction {
  const keyword = event.keyword ?? event.body?.trim().toUpperCase() ?? null;

  if (!keyword) {
    return null;
  }

  if (STOP_KEYWORDS.has(keyword)) {
    return { action: 'suppress', keyword };
  }

  if (START_KEYWORDS.has(keyword)) {
    return { action: 'release', keyword };
  }

  return null;
}

/**
 * Twilio retries a callback until it gets a 2xx, so the same status can
 * arrive more than once. The error code is part of the key because a failed
 * status can legitimately be reported with different codes.
 */
function statusDedupeKey(event: MessagingTransportStatusEvent): string {
  const base = `status:${event.providerMessageId}:${event.providerStatus}`;
  return event.errorCode ? `${base}:${event.errorCode}` : base;
}

function mapProviderStatusToMessageStatus(
  event: MessagingTransportStatusEvent,
) {
  switch (event.providerStatus) {
    case 'submitted':
      return 'ACCEPTED' as const;
    case 'delivered':
      return 'DELIVERED' as const;
    case 'rejected':
      return 'REJECTED' as const;
    case 'undeliverable':
      return 'FAILED' as const;
  }
}

/** Delivery is terminal; failures are terminal unless delivery arrives late. */
function shouldApplyStatusTransition(
  currentStatus: string,
  nextStatus: 'ACCEPTED' | 'DELIVERED' | 'FAILED' | 'REJECTED',
) {
  if (currentStatus === 'DELIVERED') {
    return false;
  }

  if (nextStatus === 'DELIVERED') {
    return true;
  }

  if (currentStatus === 'FAILED' || currentStatus === 'REJECTED') {
    return false;
  }

  return !(currentStatus === 'ACCEPTED' && nextStatus === 'ACCEPTED');
}

function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  );
}

function toInputJsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
