import type { PrismaClient } from '@repo/db';
import { describe, expect, test, vi } from 'vitest';
import {
  buildConversationScope,
  canAccessConversation,
  isLineOwnersThread,
  lineOwnerOf,
  loadConversationAudience,
  loadDepartmentIds,
  toMessageOwner,
} from './conversation-scope.js';

describe('lineOwnerOf', () => {
  test('names the user or the department that holds the line', () => {
    expect(lineOwnerOf({ userId: 'user-1', departmentId: null })).toEqual({
      type: 'user',
      id: 'user-1',
    });
    expect(lineOwnerOf({ userId: null, departmentId: 'dept-1' })).toEqual({
      type: 'department',
      id: 'dept-1',
    });
  });

  test('has no owner for a line nobody holds', () => {
    expect(lineOwnerOf({ userId: null, departmentId: null })).toBeNull();
  });
});

describe('toMessageOwner', () => {
  const user = { name: 'Alex Rivera', email: 'alex@example.com' };
  const department = { name: 'Sales' };

  test('shows a user by name, or by email when they have none', () => {
    expect(
      toMessageOwner({
        userId: 'user-alex',
        departmentId: null,
        user,
        department: null,
      }),
    ).toEqual({ type: 'user', id: 'user-alex', name: 'Alex Rivera' });
    expect(
      toMessageOwner({
        userId: 'user-alex',
        departmentId: null,
        user: { name: null, email: 'alex@example.com' },
        department: null,
      }),
    ).toEqual({ type: 'user', id: 'user-alex', name: 'alex@example.com' });
  });

  test('shows a department by name', () => {
    expect(
      toMessageOwner({
        userId: null,
        departmentId: 'dept-sales',
        user: null,
        department,
      }),
    ).toEqual({ type: 'department', id: 'dept-sales', name: 'Sales' });
  });

  test('reads the owner the way every comparison does', () => {
    // Both columns set cannot be written through the product; if a row ever
    // carried both, what is shown must be the owner sends are judged by.
    expect(
      toMessageOwner({
        userId: 'user-alex',
        departmentId: 'dept-sales',
        user,
        department,
      }),
    ).toMatchObject({ type: 'user', id: 'user-alex' });
    // And it is that owner's row that names it: without it there is no name
    // to show, not the other owner's.
    expect(
      toMessageOwner({
        userId: 'user-alex',
        departmentId: 'dept-sales',
        user: null,
        department,
      }),
    ).toBeNull();
  });

  test('has no owner for a row that has none', () => {
    expect(
      toMessageOwner({ userId: null, departmentId: null, user, department }),
    ).toBeNull();
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
