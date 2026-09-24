import { describe, expect, test } from 'vitest';
import { isSameMessageOwner } from './message-owner.js';

const alex = { type: 'user', id: 'user-alex' } as const;
const sales = { type: 'department', id: 'dept-sales' } as const;

describe('isSameMessageOwner', () => {
  test('matches the same user and the same department', () => {
    expect(isSameMessageOwner(alex, { type: 'user', id: 'user-alex' })).toBe(
      true,
    );
    expect(
      isSameMessageOwner(sales, { type: 'department', id: 'dept-sales' }),
    ).toBe(true);
  });

  test('tells two users, or two departments, apart', () => {
    expect(isSameMessageOwner(alex, { type: 'user', id: 'user-blair' })).toBe(
      false,
    );
    expect(
      isSameMessageOwner(sales, { type: 'department', id: 'dept-support' }),
    ).toBe(false);
  });

  test('never takes a department for a user that shares its id', () => {
    expect(isSameMessageOwner(alex, { type: 'department', id: alex.id })).toBe(
      false,
    );
  });

  test('ignores whatever else an owner carries, such as its name', () => {
    expect(
      isSameMessageOwner({ ...alex, name: 'Alex' }, { ...alex, name: 'A.' }),
    ).toBe(true);
  });

  test('never matches a missing owner, even another missing one', () => {
    expect(isSameMessageOwner(null, alex)).toBe(false);
    expect(isSameMessageOwner(alex, undefined)).toBe(false);
    expect(isSameMessageOwner(null, null)).toBe(false);
  });
});
