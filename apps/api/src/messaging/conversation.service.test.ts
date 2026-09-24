import type { PrismaClient } from '@repo/db';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildMessagePreview,
  MessageConversationService,
} from './conversation.service.js';

describe('MessageConversationService', () => {
  const userDepartmentFindMany = vi.fn(async () => []);
  const messageConversationFindUnique = vi.fn(async () => null);
  const messageConversationUpdate = vi.fn(async () => ({}));
  const messageConversationUpsert = vi.fn(async () => ({}));
  const messageConversationCount = vi.fn(async () => 0);
  const messageFindMany = vi.fn(async () => []);
  const phoneNumberFindUnique = vi.fn(async () => null);
  const contactFindOrCreateByPhoneNumber = vi.fn(async () => ({
    id: 'contact-1',
    phoneNumber: '+15555550123',
    name: null,
  }));

  let service: MessageConversationService;

  beforeEach(() => {
    userDepartmentFindMany.mockImplementation(async () => []);
    messageConversationFindUnique.mockImplementation(async () => null);
    messageConversationUpdate.mockImplementation(async () => ({}));
    messageConversationUpsert.mockImplementation(async () => ({}));
    messageConversationCount.mockImplementation(async () => 0);
    messageFindMany.mockImplementation(async () => []);
    phoneNumberFindUnique.mockImplementation(async () => null);
    contactFindOrCreateByPhoneNumber.mockImplementation(async () => ({
      id: 'contact-1',
      phoneNumber: '+15555550123',
      name: null,
    }));

    service = new MessageConversationService(
      {
        userDepartment: {
          findMany: userDepartmentFindMany,
        },
        messageConversation: {
          findUnique: messageConversationFindUnique,
          update: messageConversationUpdate,
          upsert: messageConversationUpsert,
          count: messageConversationCount,
        },
        message: {
          findMany: messageFindMany,
        },
        phoneNumber: {
          findUnique: phoneNumberFindUnique,
        },
      } as unknown as PrismaClient,
      {
        findOrCreateByPhoneNumber: contactFindOrCreateByPhoneNumber,
      } as never,
    );
  });

  test('should count unread conversations across the reader whole scope', async () => {
    userDepartmentFindMany.mockResolvedValueOnce([
      { departmentId: 'dept-1' },
      { departmentId: 'dept-2' },
    ]);
    messageConversationCount.mockResolvedValueOnce(3);

    const summary = await service.countUnreadForUser('user-1');

    expect(summary).toEqual({ unreadConversations: 3 });
    expect(messageConversationCount).toHaveBeenCalledWith({
      where: {
        OR: [
          { userId: 'user-1' },
          { departmentId: { in: ['dept-1', 'dept-2'] } },
        ],
        unreadCount: { gt: 0 },
      },
    });
  });

  test('should count only the reader own lines when they are in no department', async () => {
    await service.countUnreadForUser('user-1');

    expect(messageConversationCount).toHaveBeenCalledWith({
      where: {
        OR: [{ userId: 'user-1' }],
        unreadCount: { gt: 0 },
      },
    });
  });

  test('should reset unread state when the user can access the conversation', async () => {
    userDepartmentFindMany.mockResolvedValueOnce([{ departmentId: 'dept-1' }]);
    messageConversationFindUnique.mockResolvedValueOnce({
      id: 'conversation-1',
      userId: null,
      departmentId: 'dept-1',
    });

    const result = await service.markRead('user-1', 'conversation-1');

    expect(result).toBe(true);
    expect(messageConversationUpdate).toHaveBeenCalledWith({
      where: { id: 'conversation-1' },
      data: {
        unreadCount: 0,
        lastReadAt: expect.any(Date),
      },
    });
  });

  test('should deny markRead when the conversation is outside the user scope', async () => {
    messageConversationFindUnique.mockResolvedValueOnce({
      id: 'conversation-1',
      userId: 'user-2',
      departmentId: null,
    });

    const result = await service.markRead('user-1', 'conversation-1');

    expect(result).toBe(false);
    expect(messageConversationUpdate).not.toHaveBeenCalled();
  });

  test('should list messages newest first with a cursor and a has-more flag', async () => {
    messageConversationFindUnique.mockResolvedValueOnce({
      id: 'conversation-1',
      userId: 'user-1',
      departmentId: null,
    });
    messageFindMany.mockResolvedValueOnce([
      buildMessage('message-3'),
      buildMessage('message-2'),
      buildMessage('message-1'),
    ]);

    const result = await service.listMessages('user-1', 'conversation-1', {
      beforeMessageId: 'message-4',
      limit: 2,
    });

    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: 'conversation-1' },
        cursor: { id: 'message-4' },
        skip: 1,
        take: 3,
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(result).toEqual({
      messages: [
        expect.objectContaining({
          id: 'message-3',
          createdAt: '2026-04-02T12:00:00.000Z',
          attachments: [],
        }),
        expect.objectContaining({ id: 'message-2' }),
      ],
      hasMore: true,
    });
  });

  test('should hide messages of conversations the user cannot access', async () => {
    messageConversationFindUnique.mockResolvedValueOnce({
      id: 'conversation-1',
      userId: 'user-2',
      departmentId: 'dept-9',
    });

    const result = await service.listMessages('user-1', 'conversation-1', {
      limit: 10,
    });

    expect(result).toBeNull();
    expect(messageFindMany).not.toHaveBeenCalled();
  });

  test('should find or create the thread of the user who holds the line', async () => {
    await service.findOrCreateFor('+15555550123', {
      id: 'phone-1',
      userId: 'user-1',
      departmentId: null,
    });

    expect(contactFindOrCreateByPhoneNumber).toHaveBeenCalledWith(
      '+15555550123',
      undefined,
      expect.any(Object),
    );
    // The owner is part of the key, so a thread started under a previous
    // owner of the line is never found here, and an existing one is never
    // handed over: `update` stays empty.
    expect(messageConversationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contactId_sourcePhoneNumberId_userId: {
            contactId: 'contact-1',
            sourcePhoneNumberId: 'phone-1',
            userId: 'user-1',
          },
        },
        update: {},
        create: {
          contactId: 'contact-1',
          sourcePhoneNumberId: 'phone-1',
          userId: 'user-1',
          departmentId: null,
        },
      }),
    );
  });

  test('should find or create the thread of the department that holds the line', async () => {
    await service.findOrCreateFor('+15555550123', {
      id: 'phone-1',
      userId: null,
      departmentId: 'dept-1',
    });

    expect(messageConversationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contactId_sourcePhoneNumberId_departmentId: {
            contactId: 'contact-1',
            sourcePhoneNumberId: 'phone-1',
            departmentId: 'dept-1',
          },
        },
        update: {},
        create: {
          contactId: 'contact-1',
          sourcePhoneNumberId: 'phone-1',
          userId: null,
          departmentId: 'dept-1',
        },
      }),
    );
  });

  test('should file under the owner of the line as the caller read it', async () => {
    // The line has moved to Support since the caller's read. The caller
    // decided on the line it read; a second look here would file somewhere
    // the caller never checked.
    phoneNumberFindUnique.mockResolvedValue({
      deletedAt: null,
      status: 'ACTIVE',
      userId: null,
      departmentId: 'dept-support',
    });

    await service.findOrCreateFor('+15555550123', {
      id: 'phone-1',
      userId: null,
      departmentId: 'dept-sales',
    });

    expect(messageConversationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ departmentId: 'dept-sales' }),
      }),
    );
  });

  test('should refuse a line nobody holds without creating anything', async () => {
    await expect(
      service.findOrCreateFor('+15555550123', {
        id: 'phone-1',
        userId: null,
        departmentId: null,
      }),
    ).rejects.toThrow('Line phone-1 has no owner');
    expect(messageConversationUpsert).not.toHaveBeenCalled();
    expect(contactFindOrCreateByPhoneNumber).not.toHaveBeenCalled();
  });
});

describe('buildMessagePreview', () => {
  test('should use the message body when present', () => {
    expect(buildMessagePreview('Hello world', 1)).toBe('Hello world');
  });

  test('should truncate long bodies', () => {
    expect(buildMessagePreview('a'.repeat(100), 0)).toHaveLength(80);
  });

  test('should describe attachments when the body is empty', () => {
    expect(buildMessagePreview(null, 1)).toBe('Attachment');
    expect(buildMessagePreview('  ', 2)).toBe('2 attachments');
    expect(buildMessagePreview(null, 0)).toBeNull();
  });
});

function buildMessage(id: string) {
  return {
    id,
    conversationId: 'conversation-1',
    direction: 'OUTBOUND' as const,
    channel: 'SMS' as const,
    status: 'DELIVERED' as const,
    body: 'Hello there',
    from: '+15555550100',
    to: '+15555550123',
    failureCode: null,
    failureReason: null,
    sentAt: new Date('2026-04-02T12:00:01.000Z'),
    deliveredAt: new Date('2026-04-02T12:00:02.000Z'),
    failedAt: null,
    createdAt: new Date('2026-04-02T12:00:00.000Z'),
    attachments: [],
  };
}
