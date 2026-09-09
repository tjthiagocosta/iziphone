import type { ClosedHoursRoutingType } from '@repo/dto';
import type { CachedHoliday, CachedRoutingSettings } from '@repo/events';

export type BusinessHoursStatus =
  | { isOpen: true }
  | { isOpen: false; closedReason: 'OUTSIDE_HOURS' }
  | {
      isOpen: false;
      closedReason: 'HOLIDAY';
      holiday: {
        name: string;
        routingType: ClosedHoursRoutingType;
        routingValue: string | null;
      };
    };

/**
 * Whether a department is open at `now`, evaluated on the department's own
 * wall clock. Holidays win over the weekly schedule.
 */
export function checkBusinessHours(
  settings: CachedRoutingSettings,
  now: Date = new Date(),
): BusinessHoursStatus {
  if (settings.is24Hours) {
    return { isOpen: true };
  }

  const local = wallClock(now, settings.timezone);

  const holiday = findHoliday(local, settings.holidays);
  if (holiday) {
    return {
      isOpen: false,
      closedReason: 'HOLIDAY',
      holiday: {
        name: holiday.name,
        routingType: holiday.routingType,
        routingValue: holiday.routingValue,
      },
    };
  }

  const schedule = settings.businessHours.find(
    (hours) => hours.dayOfWeek === local.dayOfWeek,
  );
  if (!schedule?.isOpen || !schedule.openTime || !schedule.closeTime) {
    return { isOpen: false, closedReason: 'OUTSIDE_HOURS' };
  }

  // HH:MM strings compare correctly as text.
  const isWithinHours =
    local.time >= schedule.openTime && local.time < schedule.closeTime;

  return isWithinHours
    ? { isOpen: true }
    : { isOpen: false, closedReason: 'OUTSIDE_HOURS' };
}

interface WallClock {
  /** YYYY-MM-DD */
  date: string;
  /** MM-DD, for recurring holidays */
  monthDay: string;
  /** HH:MM, 24-hour */
  time: string;
  /** 0 is Sunday */
  dayOfWeek: number;
}

function wallClock(instant: Date, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';

  const monthDay = `${part('month')}-${part('day')}`;

  return {
    date: `${part('year')}-${monthDay}`,
    monthDay,
    time: `${part('hour')}:${part('minute')}`,
    dayOfWeek: WEEKDAYS.indexOf(part('weekday')),
  };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Holiday dates are calendar days stored as midnight UTC, so they are read
 * with UTC getters; the server's own zone must not shift them by a day.
 */
function findHoliday(
  local: WallClock,
  holidays: CachedHoliday[],
): CachedHoliday | undefined {
  return holidays.find((holiday) => {
    const date = new Date(holiday.date);
    const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
    const day = `${date.getUTCDate()}`.padStart(2, '0');
    const monthDay = `${month}-${day}`;

    return holiday.isRecurring
      ? local.monthDay === monthDay
      : local.date === `${date.getUTCFullYear()}-${monthDay}`;
  });
}
