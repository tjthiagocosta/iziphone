import type { PrismaClient } from '@repo/db';
import { describe, expect, test, vi } from 'vitest';
import { CallLineService } from './call-line.service.js';

function row(overrides: Record<string, unknown>) {
  return {
    id: 'phone-1',
    phoneNumber: '+15555550100',
    label: null,
    isPrimary: false,
    user: null,
    department: null,
    ...overrides,
  };
}

function serviceOver(rows: unknown[]) {
  const findMany = vi.fn(async () => rows);
  const db = { phoneNumber: { findMany } } as unknown as PrismaClient;
  return { service: new CallLineService(db), findMany };
}

describe('CallLineService', () => {
  test('should ask for the voice numbers in service that belong to the user or to a department of theirs', async () => {
    const { service, findMany } = serviceOver([]);

    await expect(service.listOutboundLines('user-1')).resolves.toEqual([]);

    // The membership rule is the one the routing cache applies to a number,
    // which is what the call controller checks before it dials.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          voiceEnabled: true,
          OR: [
            { userId: 'user-1' },
            {
              department: {
                deletedAt: null,
                users: { some: { userId: 'user-1' } },
              },
            },
          ],
        },
      }),
    );
  });

  test('should name each line by its owner, with own lines first and primary department lines next', async () => {
    const { service } = serviceOver([
      row({
        id: 'phone-3',
        phoneNumber: '+15555550103',
        department: { id: 'dept-2', name: 'Sales', deletedAt: null },
      }),
      row({
        id: 'phone-2',
        phoneNumber: '+15555550102',
        label: 'Support main',
        isPrimary: true,
        department: { id: 'dept-1', name: 'Support', deletedAt: null },
      }),
      row({
        id: 'phone-1',
        phoneNumber: '+15555550101',
        user: { id: 'user-1', name: 'Alex Example', email: 'alex@example.com' },
      }),
    ]);

    await expect(service.listOutboundLines('user-1')).resolves.toEqual([
      {
        id: 'phone-1',
        phoneNumber: '+15555550101',
        label: null,
        ownerType: 'user',
        ownerId: 'user-1',
        ownerName: 'Alex Example',
        isPrimary: false,
      },
      {
        id: 'phone-2',
        phoneNumber: '+15555550102',
        label: 'Support main',
        ownerType: 'department',
        ownerId: 'dept-1',
        ownerName: 'Support',
        isPrimary: true,
      },
      {
        id: 'phone-3',
        phoneNumber: '+15555550103',
        label: null,
        ownerType: 'department',
        ownerId: 'dept-2',
        ownerName: 'Sales',
        isPrimary: false,
      },
    ]);
  });

  test('should fall back to the email of a user without a name', async () => {
    const { service } = serviceOver([
      row({ user: { id: 'user-1', name: null, email: 'alex@example.com' } }),
    ]);

    const [line] = await service.listOutboundLines('user-1');

    expect(line).toMatchObject({
      ownerType: 'user',
      ownerName: 'alex@example.com',
    });
  });
});
