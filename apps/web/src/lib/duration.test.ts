import { describe, expect, test } from 'vitest';
import { formatDuration } from './duration';

describe('formatDuration', () => {
  test.each([
    [5, '0:05'],
    [65, '1:05'],
    [599, '9:59'],
    [3600, '1:00:00'],
    [3661, '1:01:01'],
    [37_230, '10:20:30'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'answers 0:00 for %j',
    (seconds) => {
      expect(formatDuration(seconds)).toBe('0:00');
    },
  );

  test('truncates fractional seconds', () => {
    expect(formatDuration(65.9)).toBe('1:05');
  });
});
