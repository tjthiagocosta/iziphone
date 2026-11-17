import { describe, expect, test } from 'vitest';
import {
  defaultRefusal,
  ImportPhoneNumberSchema,
  joinRefusal,
  MessagingServicesResponseSchema,
  OwnedPhoneNumberSchema,
  PhoneNumberConnectionSchema,
  PhoneNumberListQuerySchema,
  PhoneNumberResponseSchema,
  PurchasedPhoneNumberSchema,
  PurchasePhoneNumberSchema,
  SearchAvailableNumbersSchema,
  UpdateDefaultMessagingServiceSchema,
  UpdatePhoneNumberSchema,
} from './phone-number.schemas.js';

const CUSTOMER_CARE_SID = 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const APPROVED = {
  status: 'approved' as const,
  twilioStatus: 'VERIFIED',
  useCase: 'CUSTOMER_CARE',
  description: 'Replies to customers who wrote first',
};

describe('PurchasePhoneNumberSchema', () => {
  test('requires an E.164 number', () => {
    expect(PurchasePhoneNumberSchema.safeParse({ type: 'LOCAL' }).success).toBe(
      false,
    );
    expect(
      PurchasePhoneNumberSchema.safeParse({
        type: 'LOCAL',
        phoneNumber: '5555550100',
      }).success,
    ).toBe(false);
  });

  test('defaults country and isPrimary', () => {
    expect(
      PurchasePhoneNumberSchema.parse({
        type: 'LOCAL',
        phoneNumber: '+15555550100',
      }),
    ).toEqual({
      type: 'LOCAL',
      phoneNumber: '+15555550100',
      country: 'US',
      isPrimary: false,
    });
  });

  test('takes one owner, a user or a department', () => {
    const base = { type: 'LOCAL', phoneNumber: '+15555550100' };

    expect(
      PurchasePhoneNumberSchema.parse({
        ...base,
        owner: { type: 'department', id: 'dept-sales' },
      }).owner,
    ).toEqual({ type: 'department', id: 'dept-sales' });
    expect(
      PurchasePhoneNumberSchema.safeParse({
        ...base,
        owner: { type: 'team', id: 'dept-sales' },
      }).success,
    ).toBe(false);
  });
});

describe('ImportPhoneNumberSchema', () => {
  test('names the number in E.164 and puts it in the reserve unless told', () => {
    expect(
      ImportPhoneNumberSchema.parse({ phoneNumber: '+15555550100' }),
    ).toEqual({ phoneNumber: '+15555550100', isPrimary: false });
    expect(
      ImportPhoneNumberSchema.safeParse({ phoneNumber: '5555550100' }).success,
    ).toBe(false);
  });

  test('takes a primary only for a department', () => {
    const base = { phoneNumber: '+15555550100', isPrimary: true };

    expect(
      ImportPhoneNumberSchema.safeParse({
        ...base,
        owner: { type: 'department', id: 'dept-sales' },
      }).success,
    ).toBe(true);
    expect(
      ImportPhoneNumberSchema.safeParse({
        ...base,
        owner: { type: 'user', id: 'user-alex' },
      }).success,
    ).toBe(false);
    expect(ImportPhoneNumberSchema.safeParse(base).success).toBe(false);
  });
});

describe('PhoneNumberConnectionSchema', () => {
  test('carries reasons and a texting note only for a number it could check', () => {
    expect(
      PhoneNumberConnectionSchema.parse({
        state: 'checked',
        needsReconnect: ['voice-application'],
        texting: {
          kind: 'service-takes-texts',
          service: { sid: 'MGaaaa', friendlyName: 'Front desk texts' },
        },
      }),
    ).toMatchObject({ needsReconnect: ['voice-application'] });
    expect(
      PhoneNumberConnectionSchema.safeParse({ state: 'checked' }).success,
    ).toBe(false);
    expect(
      PhoneNumberConnectionSchema.parse({ state: 'not-in-account' }),
    ).toEqual({ state: 'not-in-account' });
  });

  test('refuses a reason it does not know and a service note without its service', () => {
    expect(
      PhoneNumberConnectionSchema.safeParse({
        state: 'checked',
        needsReconnect: ['fax'],
        texting: null,
      }).success,
    ).toBe(false);
    expect(
      PhoneNumberConnectionSchema.safeParse({
        state: 'checked',
        needsReconnect: [],
        texting: { kind: 'service-takes-texts' },
      }).success,
    ).toBe(false);
  });
});

describe('OwnedPhoneNumberSchema', () => {
  test('describes what the number has attached today', () => {
    const owned = OwnedPhoneNumberSchema.parse({
      phoneNumber: '+15555550100',
      friendlyName: '(555) 555-0100',
      type: 'LOCAL',
      capabilities: { voice: true, sms: true, mms: true, fax: false },
      releasedHere: false,
      attached: {
        voiceUrlHost: 'voice.example.com',
        smsUrlHost: null,
        voiceApplication: { sid: 'APaaaa', friendlyName: null },
        smsApplication: null,
        sipTrunkSid: null,
        messagingService: null,
      },
      texting: { kind: 'unregistered' },
    });

    expect(owned.attached.voiceApplication).toEqual({
      sid: 'APaaaa',
      friendlyName: null,
    });
  });
});

describe('UpdatePhoneNumberSchema', () => {
  test('tells "to the reserve" from "keep the holder"', () => {
    expect(UpdatePhoneNumberSchema.parse({ owner: null }).owner).toBeNull();
    expect(UpdatePhoneNumberSchema.parse({ label: 'Front desk' })).toEqual({
      label: 'Front desk',
    });
  });

  test('refuses an owner without an id', () => {
    expect(
      UpdatePhoneNumberSchema.safeParse({ owner: { type: 'user' } }).success,
    ).toBe(false);
  });

  test('carries the holder the admin saw, the reserve included', () => {
    expect(
      UpdatePhoneNumberSchema.parse({
        owner: { type: 'user', id: 'user-1' },
        expectedOwner: null,
      }).expectedOwner,
    ).toBeNull();
    expect(
      UpdatePhoneNumberSchema.parse({
        owner: null,
        expectedOwner: { type: 'department', id: 'dept-sales' },
      }).expectedOwner,
    ).toEqual({ type: 'department', id: 'dept-sales' });
  });
});

describe('SearchAvailableNumbersSchema', () => {
  test('defaults country and limit', () => {
    expect(SearchAvailableNumbersSchema.parse({ type: 'LOCAL' })).toEqual({
      country: 'US',
      type: 'LOCAL',
      limit: 10,
    });
  });

  test('rejects non-US searches', () => {
    const result = SearchAvailableNumbersSchema.safeParse({
      country: 'CA',
      type: 'LOCAL',
    });
    expect(result.success).toBe(false);
  });

  test('rejects place filters for toll-free numbers', () => {
    for (const filter of [
      { areaCode: '555' },
      { region: 'TX' },
      { locality: 'Springfield' },
    ]) {
      const result = SearchAvailableNumbersSchema.safeParse({
        type: 'TOLL_FREE',
        ...filter,
      });
      expect(result.success).toBe(false);
    }
  });

  test('upper-cases a state and refuses anything but two letters', () => {
    expect(
      SearchAvailableNumbersSchema.parse({ type: 'LOCAL', region: ' tx ' })
        .region,
    ).toBe('TX');
    expect(
      SearchAvailableNumbersSchema.safeParse({ type: 'LOCAL', region: 'Texas' })
        .success,
    ).toBe(false);
  });

  test('takes digits or keypad letters to look for, without wildcards', () => {
    expect(
      SearchAvailableNumbersSchema.parse({
        type: 'LOCAL',
        contains: 'PIZZA',
        containsAt: 'end',
      }),
    ).toMatchObject({ contains: 'PIZZA', containsAt: 'end' });

    for (const contains of ['5', '55*01', '0101$', '12345678901']) {
      expect(
        SearchAvailableNumbersSchema.safeParse({ type: 'LOCAL', contains })
          .success,
      ).toBe(false);
    }
  });

  test('caps how many numbers one search returns', () => {
    expect(
      SearchAvailableNumbersSchema.safeParse({ type: 'LOCAL', limit: '31' })
        .success,
    ).toBe(false);
  });
});

describe('PhoneNumberListQuerySchema', () => {
  test('filters by who holds the number', () => {
    expect(
      PhoneNumberListQuerySchema.parse({ assignedTo: 'nobody' }).assignedTo,
    ).toBe('nobody');
    expect(
      PhoneNumberListQuerySchema.safeParse({ assignedTo: 'someone' }).success,
    ).toBe(false);
  });
});

describe('PurchasedPhoneNumberSchema', () => {
  test('says whether Twilio took the number’s settings', () => {
    const bought = {
      id: 'phone-1',
      phoneNumber: '+15555550100',
      friendlyName: null,
      type: 'LOCAL',
      label: null,
      provider: 'TWILIO',
      locality: null,
      region: null,
      country: 'US',
      voiceEnabled: true,
      smsEnabled: true,
      mmsEnabled: false,
      faxEnabled: false,
      status: 'RESERVED',
      isPrimary: false,
      assignedTo: null,
      createdAt: '2026-04-21T12:00:00.000Z',
      updatedAt: '2026-04-21T12:00:00.000Z',
    };

    expect(
      PurchasedPhoneNumberSchema.parse({ ...bought, connected: false })
        .connected,
    ).toBe(false);
    expect(PurchasedPhoneNumberSchema.safeParse(bought).success).toBe(false);
  });
});

describe('MessagingServicesResponseSchema', () => {
  test('carries null services when they could not be read', () => {
    expect(
      MessagingServicesResponseSchema.parse({
        services: null,
        defaultSid: null,
      }),
    ).toEqual({ services: null, defaultSid: null });
    expect(
      MessagingServicesResponseSchema.safeParse({
        services: [
          {
            sid: CUSTOMER_CARE_SID,
            friendlyName: 'Customer Care',
            campaign: { ...APPROVED, status: 'rejected' },
            keepsIncomingTexts: false,
          },
        ],
        defaultSid: null,
      }).success,
    ).toBe(false);
  });
});

describe('UpdateDefaultMessagingServiceSchema', () => {
  test('takes a messaging service id or null for none', () => {
    expect(
      UpdateDefaultMessagingServiceSchema.parse({ messagingServiceSid: null }),
    ).toEqual({ messagingServiceSid: null });
    expect(
      UpdateDefaultMessagingServiceSchema.safeParse({
        messagingServiceSid: 'MGnot-a-sid',
      }).success,
    ).toBe(false);
  });
});

describe('joinRefusal and defaultRefusal', () => {
  const service = (
    campaign: typeof APPROVED | null,
    keepsIncomingTexts = false,
  ) => ({ campaign, keepsIncomingTexts });

  test('let a number join a service whose campaign is approved or in review', () => {
    expect(joinRefusal(service(APPROVED))).toBeNull();
    expect(
      joinRefusal(service({ ...APPROVED, status: 'in-review' as never })),
    ).toBeNull();
  });

  test('refuse a service with no campaign or one that was not approved', () => {
    expect(joinRefusal(service(null))).toBe('no-campaign');
    expect(
      joinRefusal(service({ ...APPROVED, status: 'not-approved' as never })),
    ).toBe('campaign-not-approved');
  });

  test('refuse as the default a service that keeps its incoming texts, which one number may join', () => {
    expect(joinRefusal(service(APPROVED, true))).toBeNull();
    expect(defaultRefusal(service(APPROVED, true))).toBe(
      'keeps-incoming-texts',
    );
    expect(defaultRefusal(service(null, true))).toBe('no-campaign');
    expect(defaultRefusal(service(APPROVED))).toBeNull();
  });
});

describe('PhoneNumberResponseSchema', () => {
  test('accepts numbers imported from the previous provider', () => {
    const result = PhoneNumberResponseSchema.safeParse({
      id: 'phone-1',
      phoneNumber: '+15555550100',
      friendlyName: null,
      type: 'LOCAL',
      label: null,
      provider: 'VONAGE',
      locality: null,
      region: null,
      country: 'US',
      voiceEnabled: true,
      smsEnabled: true,
      mmsEnabled: false,
      faxEnabled: false,
      status: 'ACTIVE',
      isPrimary: false,
      assignedTo: null,
      createdAt: '2026-04-21T12:00:00.000Z',
      updatedAt: '2026-04-21T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});
