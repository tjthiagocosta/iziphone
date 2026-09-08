import { describe, expect, test } from 'vitest';
import {
  E164PhoneNumberSchema,
  IsoDateTimeSchema,
  PhoneNumberInputSchema,
  QueryBooleanSchema,
  TimeOfDaySchema,
  TimeZoneSchema,
} from './primitives.js';

describe('E164PhoneNumberSchema', () => {
  test('accepts a canonical number', () => {
    expect(E164PhoneNumberSchema.safeParse('+15555550100').success).toBe(true);
  });

  test.each(['15555550100', '+1 555 555 0100', '+1234', '+1234567890123456'])(
    'rejects %s',
    (value) => {
      expect(E164PhoneNumberSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('PhoneNumberInputSchema', () => {
  test.each([
    ['+15555550100', '+15555550100'],
    [' (555) 555-0100 ', '(555) 555-0100'],
    ['1-555-555-0100', '1-555-555-0100'],
    ['+44 20 7946 0958', '+44 20 7946 0958'],
  ])('accepts %s and trims it', (input, expected) => {
    expect(PhoneNumberInputSchema.parse(input)).toBe(expected);
  });

  test.each(['', '   ', 'abc', '555-0100', '2-555-555-0100', '+12'])(
    'rejects %j',
    (value) => {
      expect(PhoneNumberInputSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('QueryBooleanSchema', () => {
  test.each([
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    [true, true],
    [false, false],
  ])('parses %j as %s', (input, expected) => {
    expect(QueryBooleanSchema.parse(input)).toBe(expected);
  });

  test('rejects arbitrary strings instead of treating them as truthy', () => {
    expect(QueryBooleanSchema.safeParse('maybe').success).toBe(false);
  });
});

describe('TimeOfDaySchema', () => {
  test.each(['00:00', '09:30', '23:59'])('accepts %s', (value) => {
    expect(TimeOfDaySchema.safeParse(value).success).toBe(true);
  });

  test.each(['24:00', '09:60', '9:30', '99:99', '09:30:00'])(
    'rejects %s',
    (value) => {
      expect(TimeOfDaySchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('IsoDateTimeSchema', () => {
  test('accepts UTC and offset timestamps', () => {
    expect(
      IsoDateTimeSchema.safeParse('2026-04-21T12:00:00.000Z').success,
    ).toBe(true);
    expect(
      IsoDateTimeSchema.safeParse('2026-04-21T09:00:00-03:00').success,
    ).toBe(true);
  });

  test('rejects dates without a time or zone', () => {
    expect(IsoDateTimeSchema.safeParse('2026-04-21').success).toBe(false);
    expect(IsoDateTimeSchema.safeParse('2026-04-21T12:00:00').success).toBe(
      false,
    );
  });
});

describe('TimeZoneSchema', () => {
  test('accepts IANA names', () => {
    expect(TimeZoneSchema.safeParse('America/Sao_Paulo').success).toBe(true);
    expect(TimeZoneSchema.safeParse('UTC').success).toBe(true);
  });

  test('rejects unknown names and abbreviations', () => {
    expect(TimeZoneSchema.safeParse('Mars/Olympus').success).toBe(false);
    expect(TimeZoneSchema.safeParse('').success).toBe(false);
  });
});
