import type { PrismaClient } from '@repo/db';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MessagingContactService } from './contact.service.js';

const scopeForMember = {
  OR: [{ userId: 'user-1' }, { departmentId: { in: ['dept-1'] } }],
};

describe('MessagingContactService.listForUser', () => {
  const userDepartmentFindMany = vi.fn(async () => [
    { departmentId: 'dept-1' },
  ]);
  const contactFindMany = vi.fn(async () => [] as unknown[]);
  const contactCount = vi.fn(async () => 0);

  let service: MessagingContactService;

  beforeEach(() => {
    userDepartmentFindMany.mockImplementation(async () => [
      { departmentId: 'dept-1' },
    ]);
    contactFindMany.mockImplementation(async () => []);
    contactCount.mockImplementation(async () => 0);

    service = new MessagingContactService({
      userDepartment: { findMany: userDepartmentFindMany },
      contact: { findMany: contactFindMany, count: contactCount },
    } as unknown as PrismaClient);
  });

  const query = { page: 1, limit: 50, search: undefined };

  test('should only list contacts reachable on the caller lines', async () => {
    await service.listForUser('user-1', query);

    const args = contactFindMany.mock.calls[0]?.[0] as {
      where: unknown;
      include: { messageConversations: { where: unknown } };
      orderBy: unknown;
    };

    expect(args.where).toEqual({
      messageConversations: { some: scopeForMember },
    });
    expect(args.orderBy).toEqual([{ name: 'asc' }, { phoneNumber: 'asc' }]);
    expect(contactCount).toHaveBeenCalledWith({ where: args.where });
  });

  test('should list only the conversations the caller can open', async () => {
    // Without the filter on the relation, a contact reached through one
    // department would also list another department's thread with them.
    await service.listForUser('user-1', query);

    const args = contactFindMany.mock.calls[0]?.[0] as {
      include: { messageConversations: { where: unknown } };
    };

    expect(args.include.messageConversations.where).toEqual(scopeForMember);
  });

  test('should leave department threads out for a non-member', async () => {
    userDepartmentFindMany.mockResolvedValueOnce([]);

    await service.listForUser('user-2', query);

    const args = contactFindMany.mock.calls[0]?.[0] as { where: unknown };

    expect(args.where).toEqual({
      messageConversations: { some: { OR: [{ userId: 'user-2' }] } },
    });
  });

  test('should return a contact once with one entry per line', async () => {
    contactFindMany.mockResolvedValueOnce([
      {
        id: 'contact-1',
        name: 'Dana Whitfield',
        phoneNumber: '+15555550123',
        messageConversations: [
          {
            id: 'conversation-1',
            lastMessageAt: new Date('2026-09-08T12:00:00.000Z'),
            unreadCount: 2,
            sourcePhoneNumber: {
              id: 'line-1',
              phoneNumber: '+15555550188',
              label: 'Support',
            },
            userId: null,
            departmentId: 'dept-1',
            user: null,
            department: { name: 'Support' },
          },
          {
            id: 'conversation-2',
            lastMessageAt: null,
            unreadCount: 0,
            sourcePhoneNumber: {
              id: 'line-2',
              phoneNumber: '+15555550199',
              label: null,
            },
            userId: 'user-1',
            departmentId: null,
            user: { name: null, email: 'agent@example.com' },
            department: null,
          },
        ],
      },
    ]);
    contactCount.mockResolvedValueOnce(1);

    const result = await service.listForUser('user-1', query);

    expect(result).toEqual({
      contacts: [
        {
          id: 'contact-1',
          name: 'Dana Whitfield',
          phoneNumber: '+15555550123',
          conversations: [
            {
              id: 'conversation-1',
              sourcePhoneNumber: {
                id: 'line-1',
                phoneNumber: '+15555550188',
                label: 'Support',
              },
              owner: { type: 'department', id: 'dept-1', name: 'Support' },
              lastMessageAt: '2026-09-08T12:00:00.000Z',
              unreadCount: 2,
            },
            {
              id: 'conversation-2',
              sourcePhoneNumber: {
                id: 'line-2',
                phoneNumber: '+15555550199',
                label: null,
              },
              owner: {
                type: 'user',
                id: 'user-1',
                name: 'agent@example.com',
              },
              lastMessageAt: null,
              unreadCount: 0,
            },
          ],
        },
      ],
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
    });
  });

  test('should say whose each thread is, so two owners on one line can be told apart', async () => {
    // The line moved from Sales to Support and the reader is in both: the
    // contact has a thread with each department on the same line.
    const line = { id: 'line-1', phoneNumber: '+15555550142', label: 'Main' };
    contactFindMany.mockResolvedValueOnce([
      {
        id: 'contact-1',
        name: null,
        phoneNumber: '+15555550187',
        messageConversations: [
          {
            id: 'conversation-support',
            lastMessageAt: null,
            unreadCount: 0,
            sourcePhoneNumber: line,
            userId: null,
            departmentId: 'dept-support',
            user: null,
            department: { name: 'Support' },
          },
          {
            id: 'conversation-sales',
            lastMessageAt: null,
            unreadCount: 1,
            sourcePhoneNumber: line,
            userId: null,
            departmentId: 'dept-sales',
            user: null,
            department: { name: 'Sales' },
          },
        ],
      },
    ]);

    const result = await service.listForUser('user-1', query);
    const args = contactFindMany.mock.calls[0]?.[0] as {
      include: { messageConversations: { select: Record<string, unknown> } };
    };

    expect(args.include.messageConversations.select).toMatchObject({
      userId: true,
      departmentId: true,
      user: { select: { name: true, email: true } },
      department: { select: { name: true } },
    });
    expect(
      result.contacts[0]?.conversations.map((thread) => thread.owner),
    ).toEqual([
      { type: 'department', id: 'dept-support', name: 'Support' },
      { type: 'department', id: 'dept-sales', name: 'Sales' },
    ]);
  });

  test('should match a punctuated number against the stored digits', async () => {
    await service.listForUser('user-1', { ...query, search: '(555) 015-0123' });

    const args = contactFindMany.mock.calls[0]?.[0] as {
      where: { OR: unknown };
    };

    expect(args.where.OR).toEqual([
      { name: { contains: '(555) 015-0123', mode: 'insensitive' } },
      { phoneNumber: { contains: '5550150123' } },
    ]);
  });

  test('should search a name that carries no digits', async () => {
    await service.listForUser('user-1', { ...query, search: 'Dana' });

    const args = contactFindMany.mock.calls[0]?.[0] as {
      where: { OR: unknown };
    };

    expect(args.where.OR).toEqual([
      { name: { contains: 'Dana', mode: 'insensitive' } },
    ]);
  });

  test('should page from the requested page', async () => {
    await service.listForUser('user-1', {
      page: 3,
      limit: 20,
      search: undefined,
    });

    expect(contactFindMany.mock.calls[0]?.[0]).toMatchObject({
      skip: 40,
      take: 20,
    });
  });
});
