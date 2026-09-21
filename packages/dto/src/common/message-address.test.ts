import { describe, expect, test } from 'vitest';
import { canReceiveMessages, toMessageAddress } from './message-address.js';

describe('toMessageAddress', () => {
  test.each([
    ['+15550100123', '+15550100123'],
    ['(555) 010-0123', '+15550100123'],
    ['15550100123', '+15550100123'],
  ])('reads %s as the phone number %s', (input, expected) => {
    expect(toMessageAddress(input)).toEqual({
      kind: 'phone',
      value: expected,
    });
  });

  test.each(['555', '55501', '555015', '5550155'])(
    'reads %s as a short code',
    (input) => {
      expect(toMessageAddress(input)).toEqual({
        kind: 'short-code',
        value: input,
      });
    },
  );

  test.each(['EXAMPLECO', 'Example Co', 'PARCEL-01', '55'])(
    'reads %s as a sender id',
    (input) => {
      expect(toMessageAddress(input)).toEqual({
        kind: 'alphanumeric',
        value: input,
      });
    },
  );

  test('trims what the provider sent', () => {
    expect(toMessageAddress('  EXAMPLECO  ')).toEqual({
      kind: 'alphanumeric',
      value: 'EXAMPLECO',
    });
  });

  test('refuses an empty value and one too long to be an address', () => {
    expect(toMessageAddress('')).toBeNull();
    expect(toMessageAddress('   ')).toBeNull();
    expect(toMessageAddress('E'.repeat(65))).toBeNull();
  });
});

describe('canReceiveMessages', () => {
  test.each(['+15550100123', '55501'])('%s can be written back to', (value) => {
    expect(canReceiveMessages(value)).toBe(true);
  });

  test.each(['EXAMPLECO', ''])('%j cannot be written back to', (value) => {
    expect(canReceiveMessages(value)).toBe(false);
  });
});
