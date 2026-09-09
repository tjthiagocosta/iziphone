import type { Prisma } from '@repo/db';
import type { Message } from '@repo/dto';

/** Relations every message read needs so it can be mapped to the API shape. */
export const messageRecordInclude = {
  attachments: {
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.MessageInclude;

export interface MessageRecord {
  id: string;
  conversationId: string;
  direction: Message['direction'];
  channel: Message['channel'];
  status: Message['status'];
  body: string | null;
  from: string;
  to: string;
  providerMessageId?: string | null;
  failureCode: string | null;
  failureReason: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
  attachments: Array<{
    id: string;
    storageUrl: string;
    originalUrl: string | null;
    mimeType: string;
    fileName: string | null;
    sizeBytes: number | null;
    createdAt: Date;
  }>;
}

export function toMessageDto(message: MessageRecord): Message {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    channel: message.channel,
    status: message.status,
    body: message.body,
    from: message.from,
    to: message.to,
    failureCode: message.failureCode,
    failureReason: message.failureReason,
    sentAt: message.sentAt?.toISOString() ?? null,
    deliveredAt: message.deliveredAt?.toISOString() ?? null,
    failedAt: message.failedAt?.toISOString() ?? null,
    createdAt: message.createdAt.toISOString(),
    attachments: message.attachments.map((attachment) => ({
      id: attachment.id,
      storageUrl: attachment.storageUrl,
      originalUrl: attachment.originalUrl,
      mimeType: attachment.mimeType,
      fileName: attachment.fileName,
      sizeBytes: attachment.sizeBytes,
      createdAt: attachment.createdAt.toISOString(),
    })),
  };
}
