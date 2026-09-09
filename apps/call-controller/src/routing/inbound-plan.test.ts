import type { CachedRouting, CachedRoutingSettings } from '@repo/events';
import { describe, expect, test } from 'vitest';
import { planInboundCall, voicemailGreeting } from './inbound-plan.js';

const settings: CachedRoutingSettings = {
  timezone: 'UTC',
  is24Hours: true,
  openHoursRoutingType: 'SIMULTANEOUS',
  ringDuration: 25,
  closedHoursRoutingType: 'VOICEMAIL',
  closedHoursExternalNumber: null,
  voicemailGreetingUrl: null,
  businessHours: [],
  holidays: [],
};

const closedSettings: CachedRoutingSettings = {
  ...settings,
  is24Hours: false,
  businessHours: [],
};

const department: CachedRouting = {
  type: 'DEPARTMENT',
  departmentId: 'dept-1',
  departmentName: 'Support',
  userIds: ['user-b', 'user-a', 'user-c'],
  orderedUsers: [
    { userId: 'user-c', order: 2 },
    { userId: 'user-a', order: 0 },
    { userId: 'user-b', order: 1 },
  ],
  settings,
  cachedAt: '2026-09-08T12:00:00.000Z',
};

const now = new Date('2026-09-09T14:30:00.000Z');

describe('planInboundCall', () => {
  test('a direct line rings its owner', () => {
    expect(
      planInboundCall(
        {
          type: 'USER',
          userId: 'user-1',
          userName: 'Alex Example',
          userIds: ['user-1'],
          cachedAt: '2026-09-08T12:00:00.000Z',
        },
        now,
      ),
    ).toEqual({
      action: 'ring',
      strategy: 'SIMULTANEOUS',
      userIds: ['user-1'],
      ringDuration: undefined,
      whenNobodyIsOnline: 'user-unavailable',
    });
  });

  test('an open department rings everyone at once by default', () => {
    expect(planInboundCall(department, now)).toEqual({
      action: 'ring',
      strategy: 'SIMULTANEOUS',
      userIds: ['user-b', 'user-a', 'user-c'],
      ringDuration: 25,
      whenNobodyIsOnline: 'no-agents',
    });
  });

  test('a fixed-order department rings users by their order', () => {
    const plan = planInboundCall(
      {
        ...department,
        settings: { ...settings, openHoursRoutingType: 'FIXED_ORDER' },
      },
      now,
    );

    expect(plan).toEqual({
      action: 'ring',
      strategy: 'FIXED_ORDER',
      userIds: ['user-a', 'user-b', 'user-c'],
      ringDuration: 25,
      whenNobodyIsOnline: 'fixed-order-unavailable',
    });
  });

  test('a closed department goes to voicemail', () => {
    expect(
      planInboundCall({ ...department, settings: closedSettings }, now),
    ).toEqual({ action: 'voicemail', reason: 'closed-hours' });
  });

  test('a closed department forwards when configured with an external number', () => {
    expect(
      planInboundCall(
        {
          ...department,
          settings: {
            ...closedSettings,
            closedHoursRoutingType: 'EXTERNAL_NUMBER',
            closedHoursExternalNumber: '+15555550199',
          },
        },
        now,
      ),
    ).toEqual({
      action: 'forward',
      phoneNumber: '+15555550199',
      ringDuration: 25,
    });
  });

  test('a holiday applies its own routing over the closed-hours default', () => {
    expect(
      planInboundCall(
        {
          ...department,
          settings: {
            ...settings,
            is24Hours: false,
            closedHoursRoutingType: 'VOICEMAIL',
            holidays: [
              {
                name: 'Inventory day',
                date: '2026-09-09T00:00:00.000Z',
                isRecurring: false,
                routingType: 'EXTERNAL_NUMBER',
                routingValue: '+15555550198',
              },
            ],
          },
        },
        now,
      ),
    ).toEqual({
      action: 'forward',
      phoneNumber: '+15555550198',
      ringDuration: 25,
    });
  });

  test('a department without settings rings everyone', () => {
    expect(
      planInboundCall({ ...department, settings: undefined }, now),
    ).toMatchObject({ action: 'ring', strategy: 'SIMULTANEOUS' });
  });
});

describe('voicemailGreeting', () => {
  test('every reason has a greeting', () => {
    expect(voicemailGreeting('closed-hours')).toMatch(/currently closed/);
    expect(voicemailGreeting('missing-routing')).toMatch(/not configured/);
    expect(voicemailGreeting('user-unavailable')).toMatch(/unavailable/);
  });
});
