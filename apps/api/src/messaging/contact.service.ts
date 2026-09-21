import type { Contact as ContactRecord, Prisma, PrismaClient } from '@repo/db';
import type { Contact, ContactListQuery, ContactListResponse } from '@repo/dto';
import {
  buildConversationScope,
  loadDepartmentIds,
} from './conversation-scope.js';

type ContactDbClient = PrismaClient | Prisma.TransactionClient;

/**
 * The threads listed under a contact. The scope goes on the relation as well
 * as on the contact: without it, a contact reachable through one department
 * would list the conversation another department has with them too.
 */
function conversationsInScope(scope: Prisma.MessageConversationWhereInput) {
  return {
    where: scope,
    orderBy: { lastMessageAt: 'desc' },
    select: {
      id: true,
      lastMessageAt: true,
      unreadCount: true,
      sourcePhoneNumber: {
        select: { id: true, phoneNumber: true, label: true },
      },
    },
  } satisfies Prisma.Contact$messageConversationsArgs;
}

export class MessagingContactService {
  constructor(private readonly db: PrismaClient) {}

  /**
   * The people this user has a conversation with, alphabetically.
   *
   * Derived from conversations rather than listed as its own directory: a
   * `Contact` row is global, and only the ones the caller shares a line with
   * are theirs to see. Each contact is returned once however many lines they
   * were reached on, with those lines listed.
   */
  async listForUser(
    userId: string,
    query: ContactListQuery,
  ): Promise<ContactListResponse> {
    const { page, limit, search } = query;
    const departmentIds = await loadDepartmentIds(this.db, userId);
    const scope = buildConversationScope(userId, departmentIds);
    const where = buildContactWhere(scope, search);

    const [contacts, total] = await Promise.all([
      this.db.contact.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        // Postgres sorts ascending nulls last, so unnamed contacts follow the
        // named ones rather than opening the list.
        orderBy: [{ name: 'asc' }, { phoneNumber: 'asc' }],
        include: { messageConversations: conversationsInScope(scope) },
      }),
      this.db.contact.count({ where }),
    ]);

    return {
      contacts: contacts.map(toContactDto),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * `phoneNumber` must already be canonical: E.164 for a number, and the short
   * code or sender id exactly as the provider sent it for the senders that are
   * not numbers. Callers normalise at their boundary.
   */
  async findOrCreateByPhoneNumber(
    phoneNumber: string,
    name?: string | null,
    dbClient: ContactDbClient = this.db,
  ): Promise<ContactRecord> {
    const normalizedName = name?.trim() || null;

    const existing = await dbClient.contact.findUnique({
      where: { phoneNumber },
    });

    if (!existing) {
      return dbClient.contact.create({
        data: {
          phoneNumber,
          name: normalizedName,
        },
      });
    }

    if (!existing.name && normalizedName) {
      return dbClient.contact.update({
        where: { id: existing.id },
        data: { name: normalizedName },
      });
    }

    return existing;
  }
}

type ContactWithConversations = {
  id: string;
  name: string | null;
  phoneNumber: string;
  messageConversations: Array<{
    id: string;
    lastMessageAt: Date | null;
    unreadCount: number;
    sourcePhoneNumber: {
      id: string;
      phoneNumber: string;
      label: string | null;
    };
  }>;
};

function toContactDto(contact: ContactWithConversations): Contact {
  return {
    id: contact.id,
    name: contact.name,
    phoneNumber: contact.phoneNumber,
    conversations: contact.messageConversations.map((conversation) => ({
      id: conversation.id,
      sourcePhoneNumber: conversation.sourcePhoneNumber,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      unreadCount: conversation.unreadCount,
    })),
  };
}

function buildContactWhere(
  scope: Prisma.MessageConversationWhereInput,
  search: string | undefined,
): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = {
    messageConversations: { some: scope },
  };

  const term = search?.trim();

  if (!term) {
    return where;
  }

  // A number is searched on its digits, so a punctuated one still matches the
  // E.164 form the column holds.
  const digits = term.replace(/\D/g, '');

  where.OR = [
    { name: { contains: term, mode: 'insensitive' } },
    ...(digits ? [{ phoneNumber: { contains: digits } }] : []),
  ];

  return where;
}
