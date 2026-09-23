import type { PrismaClient } from '@repo/db';
import { describe, expect, test, vi } from 'vitest';
import {
  buildConversationScope,
  canAccessConversation,
  isLineOwnersThread,
  lineOwnerOf,
  loadConversationAudience,
  loadDepartmentIds,
} from './conversation-scope.js';

describe('lineOwnerOf', () => {
  test('names the user or the department that holds the line', () => {
    expect(lineOwnerOf({ userId: 'user-1', departmentId: null })).toEqual({
      kind: 'user',
      userId: 'user-1',
    });
    expect(lineOwnerOf({ userId: null, departmentId: 'dept-1' })).toEqual({
      kind: 'department',
      departmentId: 'dept-1',
    });
  });

  test('has no owner for a line nobody holds', () => {
    expect(lineOwnerOf({ userId: null, departmentId: null })).toBeNull();
  });
});

describe('isLineOwnersThread', () => {
  const alexThread = { userId: 'user-alex', departmentId: null };
  const salesThread = { userId: null, departmentId: 'dept-sales' };

  test('accepts the thread of whoever holds the line', () => {
    expect(
      isLineOwnersThread(alexThread, {
        userId: 'user-alex',
        departmentId: null,
      }),
    ).toBe(true);
    expect(
      isLineOwnersThread(salesThread, {
        userId: null,
        departmentId: 'dept-sales',
      }),
    ).toBe(true);
  });

  test('refuses a thread started before the line changed hands', () => {
    // User to user, department to department, and across the two.
    expect(
      isLineOwnersThread(alexThread, {
        userId: 'user-blair',
        departmentId: null,
      }),
    ).toBe(false);
    expect(
      isLineOwnersThread(salesThread, {
        userId: null,
        departmentId: 'dept-support',
      }),
    ).toBe(false);
    expect(
      isLineOwnersThread(alexThread, {
        userId: null,
        departmentId: 'dept-sales',
      }),
    ).toBe(false);
    expect(
      isLineOwnersThread(salesThread, {
        userId: 'user-alex',
        departmentId: null,
      }),
    ).toBe(false);
  });

  test('refuses every thread on a line nobody holds', () => {
    expect(
      isLineOwnersThread(
        { userId: null, departmentId: null },
        { userId: null, departmentId: null },
      ),
    ).toBe(false);
  });
});

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
