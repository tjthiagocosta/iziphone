import { describe, expect, test } from 'vitest';
import { lineDescription, lineName, threadLineName } from './line';

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

describe('threadLineName', () => {
  const mainLine = { id: 'line-1', phoneNumber: '+15555550142', label: 'Main' };
  const salesThread = {
    sourcePhoneNumber: mainLine,
    owner: { name: 'Sales' },
  };
  const supportThread = {
    sourcePhoneNumber: mainLine,
    owner: { name: 'Support' },
  };

  test('names a thread by its line when it is the only one on that line', () => {
    const otherLine = {
      sourcePhoneNumber: {
        id: 'line-2',
        phoneNumber: '+15555550199',
        label: null,
      },
      owner: { name: 'Sales' },
    };

    expect(threadLineName(salesThread, [salesThread, otherLine])).toBe('Main');
    expect(threadLineName(otherLine, [salesThread, otherLine])).toBe(
      '(555) 555-0199',
    );
  });

  test('adds the owner when the reader has two threads on one line', () => {
    // The line changed hands and the reader can see both owners' threads;
    // without the owner the two links would read the same.
    const threads = [salesThread, supportThread];

    expect(threadLineName(salesThread, threads)).toBe('Main · Sales');
    expect(threadLineName(supportThread, threads)).toBe('Main · Support');
  });

  test('falls back to the line alone for a thread whose owner is gone', () => {
    const orphan = { sourcePhoneNumber: mainLine, owner: null };

    expect(threadLineName(orphan, [orphan, supportThread])).toBe('Main');
  });
});
