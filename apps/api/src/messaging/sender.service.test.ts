import type { PrismaClient } from '@repo/db';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageSenderService } from './sender.service.js';

describe('MessageSenderService', () => {
  const findMany = vi.fn(async () => []);
  const findFirst = vi.fn(async () => null);
  let service: MessageSenderService;

  beforeEach(() => {
    findMany.mockClear();
    findFirst.mockClear();
    findMany.mockImplementation(async () => []);
    findFirst.mockImplementation(async () => null);

    service = new MessageSenderService({
      phoneNumber: {
        findMany,
        findFirst,
      },
    } as unknown as PrismaClient);
  });

  test('should query direct and department senders using messaging-capable filters', async () => {
    findMany
      .mockResolvedValueOnce([
        {
          id: 'phone-user-1',
          phoneNumber: '+15555550100',
          label: 'Personal',
          isPrimary: true,
          smsEnabled: true,
          mmsEnabled: false,
          userId: 'user-1',
          departmentId: null,
          user: {
            id: 'user-1',
            name: 'Agent One',
            email: 'agent@example.com',
          },
          department: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'phone-dept-1',
          phoneNumber: '+15555550111',
          label: 'Support Main',
          isPrimary: false,
          smsEnabled: true,
          mmsEnabled: true,
          userId: null,
          departmentId: 'dept-1',
          user: null,
          department: {
            id: 'dept-1',
            name: 'Support',
          },
        },
      ]);

    const result = await service.listAllowedSenders('user-1');

    expect(findMany).toHaveBeenNthCalledWith(1, {
      where: {
        userId: 'user-1',
        deletedAt: null,
        status: 'ACTIVE',
        OR: [{ smsEnabled: true }, { mmsEnabled: true }],
      },
      select: {
        id: true,
        phoneNumber: true,
        label: true,
        isPrimary: true,
        smsEnabled: true,
        mmsEnabled: true,
        userId: true,
        departmentId: true,
        user: { select: { id: true, name: true, email: true } },
        department: { select: { id: true, name: true } },
      },
    });
    expect(findMany).toHaveBeenNthCalledWith(2, {
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        OR: [{ smsEnabled: true }, { mmsEnabled: true }],
        department: {
          deletedAt: null,
          users: {
            some: {
              userId: 'user-1',
            },
          },
        },
      },
      select: {
        id: true,
        phoneNumber: true,
        label: true,
        isPrimary: true,
        smsEnabled: true,
        mmsEnabled: true,
        userId: true,
        departmentId: true,
        user: { select: { id: true, name: true, email: true } },
        department: { select: { id: true, name: true } },
      },
    });
    expect(result).toEqual([
      {
        id: 'phone-user-1',
        phoneNumber: '+15555550100',
        label: 'Personal',
        ownerType: 'user',
        ownerId: 'user-1',
        ownerName: 'Agent One',
        isPrimary: true,
        smsEnabled: true,
        mmsEnabled: false,
      },
      {
        id: 'phone-dept-1',
        phoneNumber: '+15555550111',
        label: 'Support Main',
        ownerType: 'department',
        ownerId: 'dept-1',
        ownerName: 'Support',
        isPrimary: false,
        smsEnabled: true,
        mmsEnabled: true,
      },
    ]);
  });

  test('should return an SMS-capable sender when the user is allowed to use it', async () => {
    findFirst.mockResolvedValueOnce({
      id: 'phone-1',
      phoneNumber: '+15555550100',
      label: 'Support',
      isPrimary: true,
      smsEnabled: true,
      mmsEnabled: false,
      userId: null,
      departmentId: 'dept-1',
    });

    const result = await service.getAllowedSmsSender('user-1', 'phone-1');

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'phone-1',
        deletedAt: null,
        status: 'ACTIVE',
        smsEnabled: true,
        OR: [
          { userId: 'user-1' },
          {
            department: {
              deletedAt: null,
              users: {
                some: {
                  userId: 'user-1',
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        phoneNumber: true,
        label: true,
        isPrimary: true,
        smsEnabled: true,
        mmsEnabled: true,
        userId: true,
        departmentId: true,
      },
    });
    expect(result).toEqual({
      id: 'phone-1',
      phoneNumber: '+15555550100',
      label: 'Support',
      isPrimary: true,
      smsEnabled: true,
      mmsEnabled: false,
      userId: null,
      departmentId: 'dept-1',
    });
  });
});
