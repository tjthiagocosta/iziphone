import { describe, expect, test } from 'vitest';
import { dayKey, formatDayLabel, formatRelativeTime } from './relative-time';

/** Thursday 2026-09-10, 09:30 local. */
const now = new Date(2026, 8, 10, 9, 30);

describe('formatRelativeTime', () => {
  test('shows the time for something earlier today', () => {
    expect(formatRelativeTime(new Date(2026, 8, 10, 8, 5), now)).toBe(
      '8:05 AM',
    );
  });

  test('shows the time for a future instant rather than a negative day count', () => {
    expect(formatRelativeTime(new Date(2026, 8, 10, 23, 45), now)).toBe(
      '11:45 PM',
    );
  });

  test('counts calendar days, so late yesterday is Yesterday', () => {
    expect(formatRelativeTime(new Date(2026, 8, 9, 23, 40), now)).toBe(
      'Yesterday',
    );
  });

  test('names the weekday within the last week', () => {
    expect(formatRelativeTime(new Date(2026, 8, 7, 12, 0), now)).toBe('Monday');
  });

  test('dates anything a week or more old', () => {
    expect(formatRelativeTime(new Date(2026, 8, 3, 12, 0), now)).toBe(
      'Thu, Sep 3',
    );
  });

  test('accepts an ISO string, as every dto timestamp is one', () => {
    const iso = new Date(2026, 8, 9, 23, 40).toISOString();
    expect(formatRelativeTime(iso, now)).toBe('Yesterday');
  });

  test('returns an empty label for an unparseable value', () => {
    expect(formatRelativeTime('not a date', now)).toBe('');
  });
});

describe('formatDayLabel', () => {
  const now = new Date('2026-03-20T15:00:00');

  test('names the day rather than the time, unlike a list row', () => {
    expect(formatDayLabel(new Date('2026-03-20T09:00:00'), now)).toBe('Today');
    expect(formatRelativeTime(new Date('2026-03-20T09:00:00'), now)).toBe(
      '9:00 AM',
    );
  });

  test('counts calendar days, so late last night is Yesterday', () => {
    expect(formatDayLabel(new Date('2026-03-19T23:40:00'), now)).toBe(
      'Yesterday',
    );
  });

  test('uses the weekday within the week and a dated form beyond it', () => {
    expect(formatDayLabel(new Date('2026-03-16T10:00:00'), now)).toBe('Monday');
    expect(formatDayLabel(new Date('2026-03-02T10:00:00'), now)).toBe(
      'Monday, Mar 2',
    );
  });

  test('answers nothing for a value that is not a time', () => {
    expect(formatDayLabel('not a date', now)).toBe('');
    expect(dayKey('not a date')).toBe('');
  });
});

describe('dayKey', () => {
  test('groups two instants on the same local day together', () => {
    expect(dayKey(new Date('2026-03-19T23:40:00'))).toBe('2026-03-19');
    expect(dayKey(new Date('2026-03-20T00:10:00'))).toBe('2026-03-20');
  });
});
