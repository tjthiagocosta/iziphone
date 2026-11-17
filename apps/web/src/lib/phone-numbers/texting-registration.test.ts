import type { MessagingServiceOption } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  campaignUseCaseLabel,
  changeServiceTerms,
  choiceOf,
  hasServiceToJoin,
  joinNotice,
  joinTerms,
  mayChooseServiceOnImport,
  NO_SERVICE,
  optionRefusal,
  presetValue,
  requestFieldOf,
  serviceOptionLabel,
  textingStatus,
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

describe('the picker’s choice', () => {
  const response = {
    services: [CUSTOMER_CARE, APPOINTMENTS, UNREGISTERED],
    defaultSid: CUSTOMER_CARE.sid,
  };

  test('starts on the default, or none when there is no usable one', () => {
    expect(presetValue(response)).toBe(CUSTOMER_CARE.sid);
    expect(presetValue({ ...response, defaultSid: null })).toBe(NO_SERVICE);
    expect(presetValue({ ...response, defaultSid: UNREGISTERED.sid })).toBe(
      NO_SERVICE,
    );
    expect(presetValue({ services: null, defaultSid: null })).toBeNull();
    expect(presetValue(null)).toBeNull();
  });

  test('sends a service’s sid, null for none, and nothing when the services are unread', () => {
    expect(requestFieldOf(choiceOf(response, APPOINTMENTS.sid))).toBe(
      APPOINTMENTS.sid,
    );
    expect(requestFieldOf(choiceOf(response, NO_SERVICE))).toBeNull();
    expect(
      requestFieldOf(choiceOf({ services: null, defaultSid: null }, null)),
    ).toBeUndefined();
  });
});

describe('hasServiceToJoin', () => {
  test('finds a service the number could move to, other than its own', () => {
    const response = {
      services: [CUSTOMER_CARE, UNREGISTERED],
      defaultSid: null,
    };

    expect(hasServiceToJoin(response, null)).toBe(true);
    expect(hasServiceToJoin(response, CUSTOMER_CARE.sid)).toBe(false);
    expect(
      hasServiceToJoin(
        { ...response, services: [...response.services, APPOINTMENTS] },
        CUSTOMER_CARE.sid,
      ),
    ).toBe(true);
    expect(hasServiceToJoin(null, null)).toBe(false);
  });
});

describe('joinTerms', () => {
  test('says an approved campaign registers the texts', () => {
    const [joins] = joinTerms({ kind: 'service', service: CUSTOMER_CARE });

    expect(joins).toContain('It joins “Customer Care”');
    expect(joins).toContain('registers its texts');
  });

  test('says texts stay blocked while the campaign is in review', () => {
    expect(
      joinTerms({ kind: 'service', service: APPOINTMENTS }).join(' '),
    ).toContain('stay blocked until the carriers approve it');
  });

  test('warns when the service keeps the number’s incoming texts', () => {
    expect(
      joinTerms({
        kind: 'service',
        service: service({ keepsIncomingTexts: true }),
      }).at(-1),
    ).toContain('Defer to sender’s webhook');
  });

  test('says a number in none cannot text, and what happens when the services are unread', () => {
    expect(joinTerms({ kind: 'none' })[0]).toContain('block its texts');
    expect(joinTerms({ kind: 'default' })[0]).toContain('default');
  });
});

describe('changeServiceTerms', () => {
  test('says the number leaves one service for the other and the rest stays', () => {
    const terms = changeServiceTerms(CUSTOMER_CARE, APPOINTMENTS);

    expect(terms[0]).toContain(
      'leaves “Customer Care” and joins “Appointments”',
    );
    expect(terms[0]).toContain('for a moment it is in neither');
    expect(terms.at(-1)).toContain('other numbers in “Customer Care”');
  });

  test('only says what joining means for a number in none', () => {
    expect(changeServiceTerms(null, CUSTOMER_CARE)).toEqual(
      joinTerms({ kind: 'service', service: CUSTOMER_CARE }),
    );
  });
});

describe('joinNotice', () => {
  test('has nothing to add unless joining failed', () => {
    expect(joinNotice({ state: 'joined', service: CUSTOMER_CARE })).toBeNull();
    expect(joinNotice({ state: 'kept', service: CUSTOMER_CARE })).toBeNull();
    expect(joinNotice({ state: 'none' })).toBeNull();
  });

  test('names the service and the reason, and sends the admin to the number’s page', () => {
    const notice = joinNotice({
      state: 'failed',
      service: { sid: CUSTOMER_CARE.sid, friendlyName: 'Customer Care' },
      message: 'Twilio did not add it.',
    });

    expect(notice).toContain(
      'did not join the messaging service “Customer Care”',
    );
    expect(notice).toContain('its page can do');
  });
});

describe('textingStatus', () => {
  const local = { type: 'LOCAL', smsEnabled: true } as const;
  const checked = (
    messagingService: MessagingServiceOption | null,
    texting: { kind: 'unknown' } | null = null,
  ) =>
    ({
      state: 'checked',
      needsReconnect: [],
      texting,
      messagingService,
    }) as const;

  test('offers a move for a registered number', () => {
    expect(textingStatus(local, checked(CUSTOMER_CARE))).toEqual({
      headline:
        'Registered through “Customer Care” · Campaign: Customer care · Approved',
      details: [],
      tone: 'registered',
      action: 'change',
      current: { sid: CUSTOMER_CARE.sid, friendlyName: 'Customer Care' },
    });
  });

  test('says texts stay blocked while the campaign is in review', () => {
    const status = textingStatus(local, checked(APPOINTMENTS));

    expect(status.headline).toMatch(/^In “Appointments”/);
    expect(status.details[0]).toContain('stay blocked');
    expect(status.tone).toBe('blocked');
  });

  test('offers to add a number in no service', () => {
    expect(textingStatus(local, checked(null))).toMatchObject({
      headline: 'Not registered: US carriers block its texts',
      tone: 'blocked',
      action: 'add',
      current: null,
    });
  });

  test('offers nothing when the services could not be read', () => {
    expect(
      textingStatus(local, checked(null, { kind: 'unknown' })),
    ).toMatchObject({ headline: 'Could not check', action: null });
  });

  test('leaves toll-free and text-less numbers to the Twilio Console', () => {
    expect(
      textingStatus({ type: 'TOLL_FREE', smsEnabled: true }, checked(null)),
    ).toMatchObject({
      headline: 'Verified in the Twilio Console',
      action: null,
    });
    expect(
      textingStatus({ type: 'LOCAL', smsEnabled: false }, checked(null)),
    ).toMatchObject({ action: null });
  });
});

describe('mayChooseServiceOnImport', () => {
  const inNone = {
    phoneNumber: '+15555550101',
    friendlyName: '(555) 555-0101',
    type: 'LOCAL',
    capabilities: { voice: true, sms: true, mms: false, fax: false },
    releasedHere: false,
    attached: {
      voiceUrlHost: null,
      smsUrlHost: null,
      voiceApplication: null,
      smsApplication: null,
      sipTrunkSid: null,
      messagingService: null,
    },
    texting: { kind: 'unregistered' },
  } as const;

  test('offers a choice for a local number that texts and is in no service', () => {
    expect(mayChooseServiceOnImport(inNone)).toBe(true);
  });

  test('leaves a number in a service, toll-free, text-less or unread alone', () => {
    expect(
      mayChooseServiceOnImport({
        ...inNone,
        attached: {
          ...inNone.attached,
          messagingService: {
            sid: CUSTOMER_CARE.sid,
            friendlyName: 'Customer Care',
          },
        },
        texting: null,
      }),
    ).toBe(false);
    expect(mayChooseServiceOnImport({ ...inNone, type: 'TOLL_FREE' })).toBe(
      false,
    );
    expect(
      mayChooseServiceOnImport({
        ...inNone,
        capabilities: { ...inNone.capabilities, sms: false },
      }),
    ).toBe(false);
    expect(
      mayChooseServiceOnImport({ ...inNone, texting: { kind: 'unknown' } }),
    ).toBe(false);
  });
});
