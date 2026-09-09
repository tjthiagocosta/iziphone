import type { CachedRoutingSettings } from '@repo/events';
import { describe, expect, test } from 'vitest';
import { checkBusinessHours } from './business-hours.js';

const weekdays = [1, 2, 3, 4, 5].map((dayOfWeek) => ({
  dayOfWeek,
  isOpen: true,
  openTime: '09:00',
  closeTime: '17:00',
}));

const settings: CachedRoutingSettings = {
  timezone: 'America/New_York',
  is24Hours: false,
  openHoursRoutingType: 'SIMULTANEOUS',
  ringDuration: 20,
  closedHoursRoutingType: 'VOICEMAIL',
  closedHoursExternalNumber: null,
  voicemailGreetingUrl: null,
  businessHours: weekdays,
  holidays: [],
};

// A Wednesday. 14:30 UTC is 10:30 in New York during daylight saving time.
const wednesdayMorning = new Date('2026-09-09T14:30:00.000Z');
// The same Wednesday at 21:30 UTC is 17:30 in New York, after closing.
const wednesdayEvening = new Date('2026-09-09T21:30:00.000Z');
// A Saturday.
const saturday = new Date('2026-09-12T15:00:00.000Z');

describe('checkBusinessHours', () => {
  test('a 24 hour department is always open', () => {
    expect(
      checkBusinessHours({ ...settings, is24Hours: true }, saturday),
    ).toEqual({ isOpen: true });
  });

  test('is open inside the schedule on the department wall clock', () => {
    expect(checkBusinessHours(settings, wednesdayMorning)).toEqual({
      isOpen: true,
    });
  });

  test('is closed after closing time even when UTC is still inside the window', () => {
    expect(checkBusinessHours(settings, wednesdayEvening)).toEqual({
      isOpen: false,
      closedReason: 'OUTSIDE_HOURS',
    });
  });

  test('is closed on a day without a schedule', () => {
    expect(checkBusinessHours(settings, saturday)).toEqual({
      isOpen: false,
      closedReason: 'OUTSIDE_HOURS',
    });
  });

  test('is closed on a day whose schedule has no hours', () => {
    expect(
      checkBusinessHours(
        {
          ...settings,
          businessHours: [
            { dayOfWeek: 3, isOpen: true, openTime: null, closeTime: null },
          ],
        },
        wednesdayMorning,
      ),
    ).toEqual({ isOpen: false, closedReason: 'OUTSIDE_HOURS' });
  });

  test('closes early on the day boundary of the department zone, not UTC', () => {
    // 03:00 UTC on Thursday is still Wednesday 23:00 in New York.
    const lateWednesday = new Date('2026-09-10T03:00:00.000Z');
    const openLate = {
      ...settings,
      businessHours: [
        { dayOfWeek: 3, isOpen: true, openTime: '20:00', closeTime: '23:30' },
      ],
    };

    expect(checkBusinessHours(openLate, lateWednesday)).toEqual({
      isOpen: true,
    });
  });

  test('a one-off holiday overrides the schedule with its own routing', () => {
    expect(
      checkBusinessHours(
        {
          ...settings,
          holidays: [
            {
              name: 'Inventory day',
              date: '2026-09-09T00:00:00.000Z',
              isRecurring: false,
              routingType: 'EXTERNAL_NUMBER',
              routingValue: '+15555550199',
            },
          ],
        },
        wednesdayMorning,
      ),
    ).toEqual({
      isOpen: false,
      closedReason: 'HOLIDAY',
      holiday: {
        name: 'Inventory day',
        routingType: 'EXTERNAL_NUMBER',
        routingValue: '+15555550199',
      },
    });
  });

  test('a recurring holiday matches on month and day in any year', () => {
    const result = checkBusinessHours(
      {
        ...settings,
        holidays: [
          {
            name: 'Founders day',
            date: '2019-09-09T00:00:00.000Z',
            isRecurring: true,
            routingType: 'VOICEMAIL',
            routingValue: null,
          },
        ],
      },
      wednesdayMorning,
    );

    expect(result.isOpen).toBe(false);
    expect(result).toMatchObject({ closedReason: 'HOLIDAY' });
  });

  test('a one-off holiday from another year does not match', () => {
    expect(
      checkBusinessHours(
        {
          ...settings,
          holidays: [
            {
              name: 'Old holiday',
              date: '2019-09-09T00:00:00.000Z',
              isRecurring: false,
              routingType: 'VOICEMAIL',
              routingValue: null,
            },
          ],
        },
        wednesdayMorning,
      ),
    ).toEqual({ isOpen: true });
  });
});
