import { describe, expect, test } from 'vitest';
import {
  holderOf,
  isPrimaryAfter,
  ownerOf,
  RESERVE,
  requestedHolder,
  sameHolder,
  statusFor,
} from './number-holder.js';

const ALEX = { userId: 'user-alex', departmentId: null };
const SALES = { userId: null, departmentId: 'dept-sales' };
const SUPPORT = { userId: null, departmentId: 'dept-support' };

describe('requestedHolder', () => {
  test('keeps the holder when the change names no owner', () => {
    expect(requestedHolder(SALES, undefined)).toEqual(SALES);
  });

  test('sends the number to the reserve on null', () => {
    expect(requestedHolder(SALES, null)).toEqual(RESERVE);
  });

  test('names exactly one holder for a new owner', () => {
    expect(requestedHolder(SALES, { type: 'user', id: 'user-alex' })).toEqual(
      ALEX,
    );
    expect(
      requestedHolder(ALEX, { type: 'department', id: 'dept-support' }),
    ).toEqual(SUPPORT);
  });
});

describe('ownerOf and holderOf', () => {
  test('are inverse for every holder', () => {
    for (const holder of [ALEX, SALES, RESERVE]) {
      expect(holderOf(ownerOf(holder))).toEqual(holder);
    }
  });
});

describe('sameHolder', () => {
  test('tells a move from a stay', () => {
    expect(sameHolder(SALES, { ...SALES })).toBe(true);
    expect(sameHolder(SALES, SUPPORT)).toBe(false);
    expect(sameHolder(ALEX, RESERVE)).toBe(false);
  });
});

describe('statusFor', () => {
  test('marks a held number active and a reserved one reserved', () => {
    expect(statusFor(ALEX)).toBe('ACTIVE');
    expect(statusFor(SALES)).toBe('ACTIVE');
    expect(statusFor(RESERVE)).toBe('RESERVED');
  });
});

describe('isPrimaryAfter', () => {
  const base = {
    wasPrimary: false,
    requested: undefined,
    departmentHasPrimary: false,
  };

  test('never makes a user or the reserve primary', () => {
    expect(
      isPrimaryAfter({
        ...base,
        before: SALES,
        after: ALEX,
        wasPrimary: true,
        requested: true,
      }),
    ).toBe(false);
    expect(
      isPrimaryAfter({
        ...base,
        before: SALES,
        after: RESERVE,
        requested: true,
      }),
    ).toBe(false);
  });

  test('lets the admin choose', () => {
    expect(
      isPrimaryAfter({
        ...base,
        before: SALES,
        after: SALES,
        wasPrimary: true,
        requested: false,
      }),
    ).toBe(false);
    expect(
      isPrimaryAfter({
        ...base,
        before: SALES,
        after: SUPPORT,
        requested: true,
        departmentHasPrimary: true,
      }),
    ).toBe(true);
  });

  test('keeps a number standing in the department it stays in', () => {
    expect(
      isPrimaryAfter({
        ...base,
        before: SALES,
        after: SALES,
        wasPrimary: true,
      }),
    ).toBe(true);
  });

  test('does not carry a primary into another department that has one', () => {
    expect(
      isPrimaryAfter({
        ...base,
        before: SALES,
        after: SUPPORT,
        wasPrimary: true,
        departmentHasPrimary: true,
      }),
    ).toBe(false);
  });

  test('makes a number primary when it joins a department that has none', () => {
    expect(isPrimaryAfter({ ...base, before: RESERVE, after: SUPPORT })).toBe(
      true,
    );
  });
});
