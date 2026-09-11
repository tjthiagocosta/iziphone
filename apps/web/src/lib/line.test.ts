import { describe, expect, test } from 'vitest';
import { lineDescription, lineName } from './line';

describe('lineName', () => {
  test('prefers the label the number was given', () => {
    expect(lineName({ phoneNumber: '+15555550188', label: 'Support' })).toBe(
      'Support',
    );
  });

  test('falls back to the owner, then to the number itself', () => {
    expect(
      lineName({
        phoneNumber: '+15555550188',
        label: null,
        ownerName: 'Support',
      }),
    ).toBe('Support');
    expect(lineName({ phoneNumber: '+15555550188', label: null })).toBe(
      '(555) 555-0188',
    );
  });

  test('reads a blank label as no label', () => {
    expect(lineName({ phoneNumber: '+15555550188', label: '  ' })).toBe(
      '(555) 555-0188',
    );
  });
});

describe('lineDescription', () => {
  test('separates the name from the number instead of nesting brackets', () => {
    expect(
      lineDescription({ phoneNumber: '+15555550188', label: 'Support' }),
    ).toBe('Support · (555) 555-0188');
  });

  test('shows an unnamed line as its number once', () => {
    expect(lineDescription({ phoneNumber: '+15555550188', label: null })).toBe(
      '(555) 555-0188',
    );
  });
});
