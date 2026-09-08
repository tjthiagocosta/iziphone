import { describe, expect, test, vi } from 'vitest';
import { buildCallScope, loadCallScope } from './call-scope.js';

describe('buildCallScope', () => {
  test.each(['ADMIN', 'SUPERVISOR'] as const)(
    'lets a %s see every call',
    (role) => {
      expect(buildCallScope({ id: 'user-1', role }, ['dept-1'])).toEqual({});
    },
  );

  test('limits an agent to their own calls and their departments', () => {
    expect(
      buildCallScope({ id: 'user-1', role: 'AGENT' }, ['dept-1', 'dept-2']),
    ).toEqual({
      OR: [
        { userId: 'user-1' },
        { departmentId: { in: ['dept-1', 'dept-2'] } },
      ],
    });
  });
});

describe('loadCallScope', () => {
  test('reads department memberships only for agents', async () => {
    const findMany = vi.fn(async () => [{ departmentId: 'dept-9' }]);
    const db = { userDepartment: { findMany } };

    await expect(
      loadCallScope(db, { id: 'user-2', role: 'SUPERVISOR' }),
    ).resolves.toEqual({});
    expect(findMany).not.toHaveBeenCalled();

    await expect(
      loadCallScope(db, { id: 'user-2', role: 'AGENT' }),
    ).resolves.toEqual({
      OR: [{ userId: 'user-2' }, { departmentId: { in: ['dept-9'] } }],
    });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'user-2' },
      select: { departmentId: true },
    });
  });
});
