import type { PrismaClient } from '@repo/db';
import { describe, expect, test, vi } from 'vitest';
import {
  buildConversationScope,
  canAccessConversation,
  loadConversationAudience,
  loadDepartmentIds,
} from './conversation-scope.js';

describe('buildConversationScope', () => {
  test('covers the user own conversations and their departments', () => {
    expect(buildConversationScope('user-1', ['dept-1', 'dept-2'])).toEqual({
      OR: [
        { userId: 'user-1' },
        { departmentId: { in: ['dept-1', 'dept-2'] } },
      ],
    });
  });

  test('asks for no department when the user is in none', () => {
    // An empty `in` matches nothing, but leaving the clause out keeps the
    // filter to the one condition that can match.
    expect(buildConversationScope('user-1', [])).toEqual({
      OR: [{ userId: 'user-1' }],
    });
  });
});

describe('canAccessConversation', () => {
  test('agrees with the filter on a row already loaded', () => {
    expect(
      canAccessConversation(
        { userId: 'user-1', departmentId: null },
        'user-1',
        [],
      ),
    ).toBe(true);
    expect(
      canAccessConversation(
        { userId: null, departmentId: 'dept-1' },
        'user-1',
        ['dept-1'],
      ),
    ).toBe(true);
    expect(
      canAccessConversation(
        { userId: null, departmentId: 'dept-9' },
        'user-1',
        ['dept-1'],
      ),
    ).toBe(false);
    expect(
      canAccessConversation(
        { userId: 'user-2', departmentId: null },
        'user-1',
        [],
      ),
    ).toBe(false);
  });
});

describe('loadConversationAudience', () => {
  const audienceOf = async (conversation: unknown) => {
    const findUnique = vi.fn(async () => conversation);
    const audience = await loadConversationAudience(
      {
        messageConversation: { findUnique },
      } as unknown as Pick<PrismaClient, 'messageConversation'>,
      'conversation-1',
    );

    return { audience, findUnique };
  };

  test('asks the database only for members who are still here', async () => {
    const { findUnique } = await audienceOf({ userId: null, department: null });

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          department: {
            select: expect.objectContaining({
              users: {
                where: { user: { deletedAt: null } },
                select: { userId: true },
              },
            }),
          },
        }),
      }),
    );
  });

  test('leaves out an owner who has been deleted', async () => {
    // Deleting a user ends their sessions and releases their numbers, but the
    // conversation keeps pointing at them and their membership rows stay.
    const { audience } = await audienceOf({
      userId: 'user-1',
      user: { deletedAt: new Date('2026-09-01T00:00:00.000Z') },
      department: {
        deletedAt: null,
        users: [{ userId: 'user-2' }],
      },
    });

    expect(audience).toEqual(['user-2']);
  });

  test('keeps an owner who is still here', async () => {
    const { audience } = await audienceOf({
      userId: 'user-1',
      user: { deletedAt: null },
      department: null,
    });

    expect(audience).toEqual(['user-1']);
  });
});

describe('loadDepartmentIds', () => {
  test('leaves out a department that has been deleted', async () => {
    const findMany = vi.fn(async () => [{ departmentId: 'dept-1' }]);

    await expect(
      loadDepartmentIds({ userDepartment: { findMany } }, 'user-1'),
    ).resolves.toEqual(['dept-1']);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', department: { deletedAt: null } },
      select: { departmentId: true },
    });
  });
});
