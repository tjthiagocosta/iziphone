import { describe, expect, test } from 'vitest';
import { watermarkOf } from './paging';

describe('watermarkOf', () => {
  test('holds everything back while an unfinished list is empty', () => {
    expect(
      watermarkOf([
        { oldest: 300, exhausted: true },
        { oldest: null, exhausted: false },
      ]),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  test('releases everything once every list is finished', () => {
    expect(
      watermarkOf([
        { oldest: 300, exhausted: true },
        { oldest: null, exhausted: true },
      ]),
    ).toBe(Number.NEGATIVE_INFINITY);
  });

  test('stops at the newest of the unfinished boundaries', () => {
    expect(
      watermarkOf([
        { oldest: 200, exhausted: false },
        { oldest: 150, exhausted: false },
        { oldest: 10, exhausted: true },
      ]),
    ).toBe(200);
  });

  test('ignores a finished list that stopped earlier than the rest', () => {
    expect(
      watermarkOf([
        { oldest: 200, exhausted: false },
        { oldest: 900, exhausted: true },
      ]),
    ).toBe(200);
  });
});
