import type { Prisma, PrismaClient } from '@repo/db';
import type {
  MessageConversation,
  MessageConversationListQuery,
  MessageConversationListResponse,
  MessageListQuery,
  MessageListResponse,
  MessageUnreadSummary,
} from '@repo/dto';
import { MessagingContactService } from './contact.service.js';
import {
  buildConversationScope,
  canAccessConversation,
  lineOwnerOf,
  loadDepartmentIds,
  toMessageOwner,
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
  /** The line with its owner as it stands now, read with the thread. */
  sourcePhoneNumber: {
    id: string;
    phoneNumber: string;
    label: string | null;
    userId: string | null;
    departmentId: string | null;
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
      userId: true,
      departmentId: true,
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

  /** One count over everything the reader can see; see the dto schema. */
  async countUnreadForUser(userId: string): Promise<MessageUnreadSummary> {
    const departmentIds = await this.getDepartmentIds(userId);
    const unreadConversations = await this.db.messageConversation.count({
      where: {
        ...buildConversationScope(userId, departmentIds),
        unreadCount: { gt: 0 },
      },
    });

    return { unreadConversations };
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

  /**
   * The thread a new message between this contact and this line belongs to:
   * the one the line's owner has with the contact, created if they have none.
   * A thread under a previous owner of the line is never returned; it stays
   * with that owner, and the line starts clean for the new one.
   *
   * `line` is the active line as the caller's transaction read it, and its
   * owner is taken from that reading, not from a new one: an inbound message
   * is filed with whoever held the line when it was looked up, and a send has
   * already compared that owner with the one its sender may write as. A line
   * nobody holds has no thread to file under, and is refused as a mistake.
   *
   * `contactPhoneNumber` must already be canonical: E.164 for a number, and a
   * short code or sender id as the provider sent it. Callers normalise at their
   * boundary.
   */
  async findOrCreateFor(
    contactPhoneNumber: string,
    line: { id: string; userId: string | null; departmentId: string | null },
    dbClient: MessageConversationDbClient = this.db,
  ): Promise<MessageConversationSendRecord> {
    const owner = lineOwnerOf(line);

    if (!owner) {
      throw new Error(`Line ${line.id} has no owner to file a thread under`);
    }

    const contact = await this.contactService.findOrCreateByPhoneNumber(
      contactPhoneNumber,
      undefined,
      dbClient,
    );
    const pair = { contactId: contact.id, sourcePhoneNumberId: line.id };

    /*
     * Upserted on the owner's own unique key, and the key is what keeps a
     * contact to one thread per owner: two transactions creating the same
     * thread at once can both miss it, and the second insert then fails with a
     * unique-key error instead of making a second thread. The inbound webhook
     * runs its transaction again when that happens; a send does not, and
     * fails. The existing row is left as it is: its owner is part of the key
     * that found it.
     */
    return dbClient.messageConversation.upsert({
      where:
        owner.kind === 'user'
          ? {
              contactId_sourcePhoneNumberId_userId: {
                ...pair,
                userId: owner.userId,
              },
            }
          : {
              contactId_sourcePhoneNumberId_departmentId: {
                ...pair,
                departmentId: owner.departmentId,
              },
            },
      update: {},
      create: {
        ...pair,
        userId: owner.kind === 'user' ? owner.userId : null,
        departmentId: owner.kind === 'department' ? owner.departmentId : null,
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
    owner: toMessageOwner(conversation),
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
