import type { Prisma, PrismaClient } from '@repo/db';
import type {
  MessageConversation,
  MessageConversationListQuery,
  MessageConversationListResponse,
  MessageListQuery,
  MessageListResponse,
  MessageOwner,
} from '@repo/dto';
import { MessagingContactService } from './contact.service.js';
import {
  buildConversationScope,
  canAccessConversation,
  loadDepartmentIds,
} from './conversation-scope.js';
import { messageRecordInclude, toMessageDto } from './message-record.js';

type MessageConversationDbClient = PrismaClient | Prisma.TransactionClient;

/** Longest preview shown in the conversation list. */
const PREVIEW_MAX_LENGTH = 80;

export interface MessageConversationSendRecord {
  id: string;
  contactId: string;
  sourcePhoneNumberId: string;
  userId: string | null;
  departmentId: string | null;
  contact: {
    id: string;
    name: string | null;
    phoneNumber: string;
  };
  sourcePhoneNumber: {
    id: string;
    phoneNumber: string;
    label: string | null;
  };
}

const conversationInclude = {
  contact: {
    select: {
      id: true,
      name: true,
      phoneNumber: true,
    },
  },
  sourcePhoneNumber: {
    select: {
      id: true,
      phoneNumber: true,
      label: true,
    },
  },
  user: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
  department: {
    select: {
      id: true,
      name: true,
    },
  },
  messages: {
    take: 1,
    orderBy: { createdAt: 'desc' },
    select: {
      body: true,
      direction: true,
      status: true,
      attachments: {
        select: {
          id: true,
        },
      },
    },
  },
} satisfies Prisma.MessageConversationInclude;

const sendRecordSelect = {
  id: true,
  contactId: true,
  sourcePhoneNumberId: true,
  userId: true,
  departmentId: true,
  contact: {
    select: {
      id: true,
      name: true,
      phoneNumber: true,
    },
  },
  sourcePhoneNumber: {
    select: {
      id: true,
      phoneNumber: true,
      label: true,
    },
  },
} satisfies Prisma.MessageConversationSelect;

type ConversationRecord = Prisma.MessageConversationGetPayload<{
  include: typeof conversationInclude;
}>;

interface ConversationScope {
  userId: string | null;
  departmentId: string | null;
}

export class MessageConversationService {
  constructor(
    private readonly db: PrismaClient,
    private readonly contactService = new MessagingContactService(db),
  ) {}

  async listForUser(
    userId: string,
    query: MessageConversationListQuery,
  ): Promise<MessageConversationListResponse> {
    const { page, limit, search, unreadOnly, sourcePhoneNumberId } = query;
    const departmentIds = await this.getDepartmentIds(userId);
    const where = buildAccessibleWhere(userId, departmentIds, {
      search,
      unreadOnly,
      sourcePhoneNumberId,
    });

    const [conversations, total] = await Promise.all([
      this.db.messageConversation.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
        include: conversationInclude,
      }),
      this.db.messageConversation.count({ where }),
    ]);

    const suppressionKeys = await this.getSuppressionKeys(conversations);

    return {
      conversations: conversations.map((conversation) =>
        mapConversation(conversation, suppressionKeys),
      ),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getForUser(
    userId: string,
    conversationId: string,
  ): Promise<MessageConversation | null> {
    const departmentIds = await this.getDepartmentIds(userId);
    const conversation = await this.db.messageConversation.findUnique({
      where: { id: conversationId },
      include: conversationInclude,
    });

    if (
      !conversation ||
      !canAccessConversation(conversation, userId, departmentIds)
    ) {
      return null;
    }

    const suppressionKeys = await this.getSuppressionKeys([conversation]);

    return mapConversation(conversation, suppressionKeys);
  }

  /** Newest first; `beforeMessageId` pages towards older messages. */
  async listMessages(
    userId: string,
    conversationId: string,
    query: MessageListQuery,
  ): Promise<MessageListResponse | null> {
    const scope = await this.getAccessibleScope(userId, conversationId);

    if (!scope) {
      return null;
    }

    const records = await this.db.message.findMany({
      where: { conversationId },
      ...(query.beforeMessageId
        ? { cursor: { id: query.beforeMessageId }, skip: 1 }
        : {}),
      take: query.limit + 1,
      orderBy: { createdAt: 'desc' },
      include: messageRecordInclude,
    });

    return {
      messages: records.slice(0, query.limit).map(toMessageDto),
      hasMore: records.length > query.limit,
    };
  }

  async markRead(userId: string, conversationId: string): Promise<boolean> {
    const scope = await this.getAccessibleScope(userId, conversationId);

    if (!scope) {
      return false;
    }

    await this.db.messageConversation.update({
      where: { id: conversationId },
      data: {
        unreadCount: 0,
        lastReadAt: new Date(),
      },
    });

    return true;
  }

  async getAccessibleRecordForUser(
    userId: string,
    conversationId: string,
    dbClient: MessageConversationDbClient = this.db,
  ): Promise<MessageConversationSendRecord | null> {
    const departmentIds = await this.getDepartmentIds(userId, dbClient);
    const conversation = await dbClient.messageConversation.findUnique({
      where: { id: conversationId },
      select: sendRecordSelect,
    });

    if (
      !conversation ||
      !canAccessConversation(conversation, userId, departmentIds)
    ) {
      return null;
    }

    return conversation;
  }

  /** `contactPhoneNumber` must already be E.164; callers normalise at their boundary. */
  async findOrCreateFor(
    contactPhoneNumber: string,
    sourcePhoneNumberId: string,
    dbClient: MessageConversationDbClient = this.db,
  ): Promise<MessageConversationSendRecord> {
    const [contact, sourcePhoneNumber] = await Promise.all([
      this.contactService.findOrCreateByPhoneNumber(
        contactPhoneNumber,
        undefined,
        dbClient,
      ),
      dbClient.phoneNumber.findUnique({
        where: { id: sourcePhoneNumberId },
        select: {
          id: true,
          deletedAt: true,
          status: true,
          userId: true,
          departmentId: true,
        },
      }),
    ]);

    if (
      !sourcePhoneNumber ||
      sourcePhoneNumber.deletedAt ||
      sourcePhoneNumber.status !== 'ACTIVE'
    ) {
      throw new Error('Source phone number not found');
    }

    return dbClient.messageConversation.upsert({
      where: {
        contactId_sourcePhoneNumberId: {
          contactId: contact.id,
          sourcePhoneNumberId,
        },
      },
      update: {},
      create: {
        contactId: contact.id,
        sourcePhoneNumberId,
        userId: sourcePhoneNumber.userId,
        departmentId: sourcePhoneNumber.departmentId,
      },
      select: sendRecordSelect,
    });
  }

  private async getAccessibleScope(
    userId: string,
    conversationId: string,
  ): Promise<ConversationScope | null> {
    const departmentIds = await this.getDepartmentIds(userId);
    const conversation = await this.db.messageConversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        userId: true,
        departmentId: true,
      },
    });

    if (
      !conversation ||
      !canAccessConversation(conversation, userId, departmentIds)
    ) {
      return null;
    }

    return conversation;
  }

  private getDepartmentIds(
    userId: string,
    dbClient: MessageConversationDbClient = this.db,
  ): Promise<string[]> {
    return loadDepartmentIds(dbClient, userId);
  }

  private async getSuppressionKeys(
    conversations: Array<{ contactId: string; sourcePhoneNumberId: string }>,
  ): Promise<Set<string>> {
    if (!conversations.length) {
      return new Set();
    }

    const suppressions = await this.db.messageSuppression.findMany({
      where: {
        releasedAt: null,
        OR: conversations.map((conversation) => ({
          contactId: conversation.contactId,
          sourcePhoneNumberId: conversation.sourcePhoneNumberId,
        })),
      },
      select: {
        contactId: true,
        sourcePhoneNumberId: true,
      },
    });

    return new Set(suppressions.map(suppressionKey));
  }
}

export function buildMessagePreview(
  body: string | null,
  attachmentCount: number,
): string | null {
  const trimmedBody = body?.trim();

  if (trimmedBody) {
    return trimmedBody.slice(0, PREVIEW_MAX_LENGTH);
  }

  if (attachmentCount === 1) {
    return 'Attachment';
  }

  if (attachmentCount > 1) {
    return `${attachmentCount} attachments`;
  }

  return null;
}

function buildAccessibleWhere(
  userId: string,
  departmentIds: string[],
  filters: {
    search?: string | undefined;
    unreadOnly?: boolean | undefined;
    sourcePhoneNumberId?: string | undefined;
  },
): Prisma.MessageConversationWhereInput {
  const where = buildConversationScope(userId, departmentIds);

  if (filters.unreadOnly) {
    where.unreadCount = { gt: 0 };
  }

  if (filters.sourcePhoneNumberId) {
    where.sourcePhoneNumberId = filters.sourcePhoneNumberId;
  }

  const search = filters.search?.trim();

  if (search) {
    const searchDigits = search.replace(/\D/g, '');
    const searchConditions: Prisma.MessageConversationWhereInput[] = [
      { contact: { name: { contains: search, mode: 'insensitive' } } },
    ];

    if (searchDigits) {
      searchConditions.push(
        { contact: { phoneNumber: { contains: searchDigits } } },
        { sourcePhoneNumber: { phoneNumber: { contains: searchDigits } } },
      );
    }

    where.AND = [{ OR: searchConditions }];
  }

  return where;
}

function suppressionKey(pair: {
  contactId: string;
  sourcePhoneNumberId: string;
}): string {
  return `${pair.contactId}:${pair.sourcePhoneNumberId}`;
}

function mapConversation(
  conversation: ConversationRecord,
  suppressionKeys: Set<string>,
): MessageConversation {
  const [latestMessage] = conversation.messages;

  return {
    id: conversation.id,
    contact: conversation.contact,
    sourcePhoneNumber: conversation.sourcePhoneNumber,
    owner: mapOwner(conversation),
    unreadCount: conversation.unreadCount,
    lastReadAt: conversation.lastReadAt?.toISOString() ?? null,
    lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: latestMessage
      ? buildMessagePreview(
          latestMessage.body,
          latestMessage.attachments.length,
        )
      : null,
    lastMessageDirection: latestMessage?.direction ?? null,
    lastMessageStatus: latestMessage?.status ?? null,
    isSuppressed: suppressionKeys.has(suppressionKey(conversation)),
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

function mapOwner(conversation: ConversationRecord): MessageOwner | null {
  if (conversation.user) {
    return {
      type: 'user',
      id: conversation.user.id,
      name: conversation.user.name || conversation.user.email,
    };
  }

  if (conversation.department) {
    return {
      type: 'department',
      id: conversation.department.id,
      name: conversation.department.name,
    };
  }

  return null;
}
