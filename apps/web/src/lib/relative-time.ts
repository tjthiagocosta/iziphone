/** Midnight local time on the day the instant falls in. */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Short label for a list row: the time today, `Yesterday`, the weekday within
 * the last week, and a dated form beyond that.
 *
 * Days are counted as calendar days, not elapsed hours, so something sent late
 * yesterday evening reads `Yesterday` rather than showing a bare time that is
 * indistinguishable from today. `now` is a parameter so this stays testable.
 */
export function formatRelativeTime(
  value: Date | string,
  now: Date = new Date(),
): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const days = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / MS_PER_DAY,
  );

  if (days <= 0) {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  if (days === 1) {
    return 'Yesterday';
  }

  if (days < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }

  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Identifies the calendar day an instant falls in, for grouping a timeline.
 * Local, like the labels: two things a reader saw on the same evening belong
 * under the same heading whatever the offset their timestamps carry.
 */
export function dayKey(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Heading over a day's worth of a thread. Same calendar-day arithmetic as
 * {@link formatRelativeTime}, but a day always names itself: a row in a list
 * shows the time it happened, a separator says which day that was.
 */
export function formatDayLabel(
  value: Date | string,
  now: Date = new Date(),
): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const days = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / MS_PER_DAY,
  );

  if (days <= 0) {
    return 'Today';
  }

  if (days === 1) {
    return 'Yesterday';
  }

  if (days < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'long' });
  }

  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  });
}
