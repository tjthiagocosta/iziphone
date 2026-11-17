import type { MessagingServiceOption } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  campaignUseCaseLabel,
  optionRefusal,
  serviceOptionLabel,
} from './texting-registration';

const APPROVED = {
  status: 'approved',
  twilioStatus: 'VERIFIED',
  useCase: 'CUSTOMER_CARE',
  description: 'Replies to customers who wrote first',
} as const;

function service(
  overrides: Partial<MessagingServiceOption> = {},
): MessagingServiceOption {
  return {
    sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    friendlyName: 'Customer Care',
    campaign: APPROVED,
    keepsIncomingTexts: false,
    ...overrides,
  };
}

const CUSTOMER_CARE = service();
const APPOINTMENTS = service({
  sid: 'MGbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  friendlyName: 'Appointments',
  campaign: { ...APPROVED, status: 'in-review', useCase: 'MIXED' },
});
const UNREGISTERED = service({
  sid: 'MGcccccccccccccccccccccccccccccccc',
  friendlyName: 'Old alerts',
  campaign: null,
});

describe('serviceOptionLabel', () => {
  test('names the service, its campaign’s use case and its state', () => {
    expect(serviceOptionLabel(CUSTOMER_CARE)).toBe(
      'Customer Care · Campaign: Customer care · Approved',
    );
    expect(serviceOptionLabel(UNREGISTERED)).toBe('Old alerts · No campaign');
  });

  test('tells apart services that share a name by the end of their sid', () => {
    const twin = service({
      sid: 'MGdddddddddddddddddddddddddd12ab34',
      campaign: null,
    });
    const among = [CUSTOMER_CARE, twin, APPOINTMENTS];

    expect(serviceOptionLabel(twin, among)).toBe(
      'Customer Care (…12ab34) · No campaign',
    );
    expect(serviceOptionLabel(APPOINTMENTS, among)).toBe(
      'Appointments · Campaign: Mixed · In review',
    );
  });

  test('reads a use case Twilio sends in capitals', () => {
    expect(campaignUseCaseLabel('LOW_VOLUME')).toBe('Low volume');
    expect(campaignUseCaseLabel('')).toBe('Unknown');
  });
});

describe('optionRefusal', () => {
  test('lets a number join a campaign approved or in review', () => {
    expect(optionRefusal(CUSTOMER_CARE, 'number')).toBeNull();
    expect(optionRefusal(APPOINTMENTS, 'number')).toBeNull();
    expect(optionRefusal(UNREGISTERED, 'number')).toBe('no campaign');
    expect(
      optionRefusal(
        service({ campaign: { ...APPROVED, status: 'not-approved' } }),
        'number',
      ),
    ).toBe('campaign not approved');
  });

  test('keeps a service that keeps incoming texts out of the default only', () => {
    const keeps = service({ keepsIncomingTexts: true });

    expect(optionRefusal(keeps, 'number')).toBeNull();
    expect(optionRefusal(keeps, 'default')).toBe('keeps incoming texts');
  });
});
