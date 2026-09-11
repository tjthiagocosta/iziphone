import { describe, expect, test } from 'vitest';
import { initialsOf } from './initials';

describe('initialsOf', () => {
  test.each([
    ['Alex Morgan', 'AM'],
    ['Jordan Blake Rivera', 'JR'],
    ['Cher', 'CH'],
    ['  Sam   Rivera  ', 'SR'],
  ])('takes the first and last word of %j', (name, expected) => {
    expect(initialsOf(name, 'zz')).toBe(expected);
  });

  test.each([null, undefined, '', '   '])(
    'falls back to the caller value for %j',
    (name) => {
      expect(initialsOf(name, 'dana@example.com')).toBe('DA');
    },
  );

  test('a phone-number fallback keeps its last two digits when sliced by the caller', () => {
    expect(initialsOf(null, '+15550100118'.slice(-2))).toBe('18');
  });

  test('a fallback shorter than two characters is returned as is', () => {
    expect(initialsOf(null, 'd')).toBe('D');
    expect(initialsOf(null, '')).toBe('');
  });
});
