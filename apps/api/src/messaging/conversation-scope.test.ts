import { describe, expect, test, vi } from 'vitest';
import {
  buildConversationScope,
  canAccessConversation,
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
