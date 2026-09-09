import { describe, expect, test } from 'vitest';
import { formatPhoneNumber } from './phone-number';

describe('formatPhoneNumber', () => {
  test.each([
    ['+15550100100', '(555) 010-0100'],
    ['5550100100', '(555) 010-0100'],
    ['(555) 010-0100', '(555) 010-0100'],
    ['1 555 010 0100', '(555) 010-0100'],
  ])('formats %s', (input, expected) => {
    expect(formatPhoneNumber(input)).toBe(expected);
  });

  test.each(['+44 20 5550 0100', '911', '', 'anonymous'])(
    'leaves %s as typed',
    (input) => {
      expect(formatPhoneNumber(input)).toBe(input);
    },
  );
});
