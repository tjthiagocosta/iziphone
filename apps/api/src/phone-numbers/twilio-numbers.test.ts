import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, type Mock, test, vi } from 'vitest';
import {
  ReleaseRefusedError,
  type TwilioClientLike,
  TwilioNumberManagementService,
} from './twilio-numbers.js';

const OWNED_LINE = '+15555550101';
const OWNED_SID = 'PNaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_URL = 'https://api.example.com';
const CALLS_URL = 'https://calls.example.com';

/** A number whose webhooks all point at this deployment. */
const POINTED_HERE = {
  smsUrl: `${API_URL}/webhooks/twilio/messages/inbound`,
  statusCallback: `${CALLS_URL}/webhooks/twilio/voice/status`,
  voiceUrl: `${CALLS_URL}/webhooks/twilio/voice/inbound`,
  voiceFallbackUrl: `${CALLS_URL}/webhooks/twilio/voice/fallback`,
};

/** When the purchases below start, by the service's clock. */
const PURCHASE_STARTED = new Date('2026-04-21T12:00:00.000Z');
/** Twilio's date for a number sold a moment after that. */
const SOLD_JUST_NOW = '2026-04-21T12:00:03.000Z';
/** Twilio's date for a number another system has used for months. */
const HELD_SINCE_2025 = new Date('2025-12-05T15:42:00.000Z');

/** The account does not list the number before the purchase, then lists `numbers`. */
function listedOnlyAfterPurchase(...numbers: Record<string, unknown>[]) {
  return vi.fn().mockResolvedValueOnce([]).mockResolvedValue(numbers);
}

/** The account does not list the number before the purchase, then cannot be asked. */
function unreachableAfterPurchase() {
  return vi
    .fn()
    .mockResolvedValueOnce([])
    .mockRejectedValue(new Error('Twilio is unreachable'));
}

const log = { error: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger;

function buildService(
  client: Partial<TwilioClientLike>,
  overrides: {
    callControllerPublicUrl?: string | null;
    credentials?: null;
  } = {},
) {
  // The clock stands still at the start of the purchases.
  const now = () => new Date(PURCHASE_STARTED);

  return new TwilioNumberManagementService({
    credentials:
      overrides.credentials === null
        ? null
        : {
            accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            authToken: 'not-a-real-twilio-token',
          },
    publicUrl: API_URL,
    callControllerPublicUrl:
      overrides.callControllerPublicUrl === undefined
        ? CALLS_URL
        : overrides.callControllerPublicUrl,
    log,
    client: {
      availablePhoneNumbers: vi.fn(() => ({
        local: { list: vi.fn(async () => []) },
        tollFree: { list: vi.fn(async () => []) },
      })),
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource(),
      pricing: buildPricingResource(vi.fn(async () => ({}))),
      applications: { list: vi.fn(async () => []) },
      messaging: buildMessagingResource([]),
      ...client,
    } as TwilioClientLike,
    now,
  });
}

describe('TwilioNumberManagementService', () => {
  test('should query local inventory with Twilio capability filters', async () => {
    const localList = vi.fn(async () => [
      {
        phoneNumber: OWNED_LINE,
        friendlyName: '(555) 555-0101',
        locality: 'Example City',
        region: 'PA',
        postalCode: '50000',
        isoCountry: 'US',
        capabilities: { voice: true, sms: true, mms: true, fax: false },
      },
    ]);
    const service = buildService({
      availablePhoneNumbers: vi.fn(() => ({
        local: { list: localList },
        tollFree: { list: vi.fn(async () => []) },
      })),
    });

    const result = await service.searchAvailableNumbers({
      country: 'US',
      type: 'LOCAL',
      limit: 5,
      areaCode: '555',
    });

    expect(localList).toHaveBeenCalledWith(
      expect.objectContaining({
        areaCode: 555,
        limit: 5,
        pageSize: 5,
        smsEnabled: true,
        voiceEnabled: true,
        excludeAllAddressRequired: true,
        excludeLocalAddressRequired: true,
        excludeForeignAddressRequired: true,
      }),
    );
    expect(result).toEqual({
      numbers: [
        {
          phoneNumber: OWNED_LINE,
          friendlyName: '(555) 555-0101',
          type: 'LOCAL',
          providerType: 'local',
          locality: 'Example City',
          region: 'PA',
          postalCode: '50000',
          isoCountry: 'US',
          capabilities: { voice: true, sms: true, mms: true },
        },
      ],
    });
  });

  test('should pass place filters and anchor digits to the end when asked', async () => {
    const localList = vi.fn(async () => []);
    const service = buildService({
      availablePhoneNumbers: vi.fn(() => ({
        local: { list: localList },
        tollFree: { list: vi.fn(async () => []) },
      })),
    });

    await service.searchAvailableNumbers({
      country: 'US',
      type: 'LOCAL',
      limit: 20,
      region: 'TX',
      locality: 'Springfield',
      contains: '0101',
      containsAt: 'end',
    });

    expect(localList).toHaveBeenCalledWith(
      expect.objectContaining({
        inRegion: 'TX',
        inLocality: 'Springfield',
        contains: '0101$',
      }),
    );
  });

  test('should leave digits unanchored unless asked for the end', async () => {
    const localList = vi.fn(async () => []);
    const service = buildService({
      availablePhoneNumbers: vi.fn(() => ({
        local: { list: localList },
        tollFree: { list: vi.fn(async () => []) },
      })),
    });

    await service.searchAvailableNumbers({
      country: 'US',
      type: 'LOCAL',
      limit: 20,
      contains: 'PIZZA',
    });

    expect(localList).toHaveBeenCalledWith(
      expect.objectContaining({ contains: 'PIZZA' }),
    );
  });

  test('should map toll-free searches to the Twilio toll-free inventory', async () => {
    const tollFreeList = vi.fn(async () => [
      {
        phoneNumber: '+18885550102',
        friendlyName: '(888) 555-0102',
        isoCountry: 'US',
        capabilities: { voice: true, sms: true, mms: false, fax: false },
      },
    ]);
    const service = buildService({
      availablePhoneNumbers: vi.fn(() => ({
        local: { list: vi.fn(async () => []) },
        tollFree: { list: tollFreeList },
      })),
    });

    const result = await service.searchAvailableNumbers({
      country: 'US',
      type: 'TOLL_FREE',
      limit: 1,
    });

    expect(tollFreeList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1, pageSize: 1 }),
    );
    expect(result.numbers[0]).toMatchObject({
      phoneNumber: '+18885550102',
      type: 'TOLL_FREE',
      providerType: 'toll-free',
      locality: null,
    });
  });

  test('should point messaging webhooks at the API and voice webhooks, the number status callback included, at the call controller', async () => {
    const update = vi.fn(async (params: Record<string, unknown>) => ({
      sid: OWNED_SID,
      ...params,
    }));
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }]),
        update,
      }),
    });

    await service.configureNumber(OWNED_LINE);

    expect(update).toHaveBeenCalledWith({
      smsUrl: `${API_URL}/webhooks/twilio/messages/inbound`,
      smsMethod: 'POST',
      statusCallback: `${CALLS_URL}/webhooks/twilio/voice/status`,
      statusCallbackMethod: 'POST',
      voiceUrl: `${CALLS_URL}/webhooks/twilio/voice/inbound`,
      voiceMethod: 'POST',
      voiceFallbackUrl: `${CALLS_URL}/webhooks/twilio/voice/fallback`,
      voiceFallbackMethod: 'POST',
    });
  });

  test('should refuse to configure a number the account does not have as a conflict', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => []),
      }),
    });

    await expect(service.configureNumber(OWNED_LINE)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test('should take off a TwiML App and a SIP trunk, and answer what the number had', async () => {
    const update = vi.fn(async (params: Record<string, unknown>) => ({
      sid: OWNED_SID,
      phoneNumber: OWNED_LINE,
      ...params,
    }));
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            voiceUrl: 'https://demo.example.com/welcome/voice',
            voiceMethod: 'GET',
            voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            trunkSid: 'TKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            smsApplicationSid: '',
          },
        ]),
        update,
      }),
    });

    const before = await service.configureNumber(OWNED_LINE);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ voiceApplicationSid: '', trunkSid: '' }),
    );
    expect(update.mock.calls[0]?.[0]).not.toHaveProperty('smsApplicationSid');
    expect(before).toMatchObject({
      voiceUrl: 'https://demo.example.com/welcome/voice',
      voiceMethod: 'GET',
      voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      smsApplicationSid: null,
      trunkSid: 'TKaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  test('should hand over what the number had before changing it, and change nothing when that fails', async () => {
    const update = vi.fn();
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ]),
        update,
      }),
    });
    const auditDown = new Error('db down');
    const beforeChange = vi.fn(async () => {
      throw auditDown;
    });

    await expect(
      service.configureNumber(OWNED_LINE, beforeChange),
    ).rejects.toBe(auditDown);
    expect(beforeChange).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    );
    expect(update).not.toHaveBeenCalled();
  });

  test('should take a webhook called with GET for one that needs Reconnect, and set it to POST', async () => {
    const update = vi.fn(async (params: Record<string, unknown>) => ({
      sid: OWNED_SID,
      phoneNumber: OWNED_LINE,
      ...params,
    }));
    const list = vi.fn(async () => [
      {
        sid: OWNED_SID,
        phoneNumber: OWNED_LINE,
        ...POINTED_HERE,
        voiceMethod: 'GET',
        type: 'local',
        capabilities: { voice: true, sms: false },
      },
    ]);
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ list, update }),
    });

    expect(await service.checkConnection(OWNED_LINE, 'LOCAL')).toEqual({
      state: 'checked',
      needsReconnect: ['voice-url'],
      texting: null,
      messagingService: null,
    });

    await service.configureNumber(OWNED_LINE);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ voiceMethod: 'POST' }),
    );
  });

  test('should fail when Twilio’s answer still has the TwiML App attached', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ]),
        update: vi.fn(async (params: Record<string, unknown>) => ({
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
          ...params,
          voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        })),
      }),
    });

    await expect(service.configureNumber(OWNED_LINE)).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('a TwiML App takes its calls'),
    });
  });

  test('should read a number to import with what it carries, and refuse one the account lacks', async () => {
    const list = vi.fn(async (params: Record<string, unknown>) =>
      params.phoneNumber === OWNED_LINE
        ? [
            {
              sid: OWNED_SID,
              phoneNumber: OWNED_LINE,
              friendlyName: 'Old front desk',
              type: 'toll-free',
              capabilities: { voice: true, sms: true, mms: false, fax: false },
              smsUrl: 'https://demo.example.com/sms',
              voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          ]
        : [],
    );
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ list }),
    });

    const read = await service.readNumberForImport(OWNED_LINE);

    expect(read.metadata).toMatchObject({
      friendlyName: 'Old front desk',
      type: 'TOLL_FREE',
      smsEnabled: true,
      mmsEnabled: false,
    });
    expect(read.settings).toMatchObject({
      smsUrl: 'https://demo.example.com/sms',
      voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    await expect(
      service.readNumberForImport('+15555550199'),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('should refuse to read a number to import without a call controller URL, before asking Twilio', async () => {
    const list = vi.fn(async () => []);
    const service = buildService(
      { incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ list }) },
      { callControllerPublicUrl: null },
    );

    await expect(service.readNumberForImport(OWNED_LINE)).rejects.toMatchObject(
      { statusCode: 503 },
    );
    expect(list).not.toHaveBeenCalled();
  });

  test('should refuse to configure a number without a call controller URL', async () => {
    const service = buildService(
      {
        incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
          list: vi.fn(async () => [
            { sid: OWNED_SID, phoneNumber: OWNED_LINE },
          ]),
        }),
      },
      { callControllerPublicUrl: null },
    );

    await expect(service.configureNumber(OWNED_LINE)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  test('should refuse a purchase without a call controller URL before buying', async () => {
    const create = vi.fn();
    const service = buildService(
      { incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ create }) },
      { callControllerPublicUrl: null },
    );

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(create).not.toHaveBeenCalled();
  });

  test('should refuse a purchase without credentials as not configured', async () => {
    const service = new TwilioNumberManagementService({
      credentials: null,
      publicUrl: API_URL,
      callControllerPublicUrl: CALLS_URL,
      log,
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: 'Twilio number management is not configured',
    });
  });

  test('should reject countries other than US before contacting Twilio', async () => {
    const create = vi.fn();
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ create }),
    });

    await expect(
      service.buyNumber({ country: 'BR', phoneNumber: '+5511555501010' }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(create).not.toHaveBeenCalled();
  });

  test('should refuse, before buying, a number the account already holds', async () => {
    const create = vi.fn();
    const update = vi.fn();
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            dateCreated: HELD_SINCE_2025,
            voiceApplicationSid: 'APbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          },
        ]),
        create,
        update,
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(
        /has had this number since 2025-12-05.*Add a number you own/,
      ),
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('should count a number the account got moments ago as bought, without buying it again', async () => {
    // An earlier Buy from here whose answer was lost, ninety seconds before.
    const create = vi.fn();
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            dateCreated: '2026-04-21T11:58:30.000Z',
          },
        ]),
        create,
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).resolves.toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  test.each([
    ['gives no date for', undefined],
    ['dates just before the window', '2026-04-21T11:49:59.000Z'],
  ])(
    'should refuse, before buying, a held number Twilio %s',
    async (_how, dateCreated) => {
      const create = vi.fn();
      const service = buildService({
        incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
          list: vi.fn(async () => [
            { sid: OWNED_SID, phoneNumber: OWNED_LINE, dateCreated },
          ]),
          create,
        }),
      });

      await expect(
        service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('Add a number you own'),
      });
      expect(create).not.toHaveBeenCalled();
    },
  );

  test('should buy nothing when the account cannot be checked for the number first', async () => {
    const create = vi.fn();
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => {
          throw new Error('Twilio is unreachable');
        }),
        create,
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('nothing was bought'),
    });
    expect(create).not.toHaveBeenCalled();
  });

  test('should refuse, and leave as it is, a number Twilio answers the purchase with but dates long before', async () => {
    // Twilio answers a purchase of a number the account holds with that
    // number, as if it had just sold it.
    const update = vi.fn();
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        create: vi.fn(async () => ({
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
          dateCreated: HELD_SINCE_2025,
        })),
        update,
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(
        /has had this number since 2025-12-05.*Add a number you own/,
      ),
    });
    expect(update).not.toHaveBeenCalled();
  });

  test.each([
    ['dated a moment after it started', SOLD_JUST_NOW],
    // This host's clock runs twelve minutes fast.
    ['dated twelve minutes before it started', '2026-04-21T11:48:00.000Z'],
    ['with no date, after the account did not list it', undefined],
  ])(
    'should take a purchase Twilio answers %s as bought',
    async (_when, dateCreated) => {
      const create = vi.fn(async () => ({
        sid: OWNED_SID,
        phoneNumber: OWNED_LINE,
        dateCreated,
      }));
      const service = buildService({
        incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ create }),
      });

      await expect(
        service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
      ).resolves.toBeUndefined();
      expect(create).toHaveBeenCalledWith({ phoneNumber: OWNED_LINE });
    },
  );

  test('should tell a number taken meanwhile from any other purchase failure', async () => {
    const taken = Object.assign(new Error('Number not available'), {
      code: 21422,
    });
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        create: vi.fn(async () => {
          throw taken;
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('no longer available'),
    });
  });

  test('should report a purchase whose answer was lost as bought when the account has the number', async () => {
    const list = listedOnlyAfterPurchase({
      sid: OWNED_SID,
      phoneNumber: OWNED_LINE,
      dateCreated: SOLD_JUST_NOW,
    });
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list,
        create: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).resolves.toBeUndefined();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: OWNED_LINE }),
    );
  });

  test('should count a number taken by this very account as bought', async () => {
    // Another tab's purchase got it after the account was read.
    const taken = Object.assign(new Error('Number not available'), {
      code: 21422,
      status: 400,
    });
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: listedOnlyAfterPurchase({
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
          dateCreated: new Date(SOLD_JUST_NOW),
        }),
        create: vi.fn(async () => {
          throw taken;
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).resolves.toBeUndefined();
  });

  test('should count a number another tab bought minutes earlier as bought, within the window', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        // Nine minutes before this purchase started, by Twilio's clock.
        list: listedOnlyAfterPurchase({
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
          dateCreated: '2026-04-21T11:51:00.000Z',
        }),
        create: vi.fn(async () => {
          throw Object.assign(new Error('Number not available'), {
            code: 21422,
            status: 400,
          });
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).resolves.toBeUndefined();
  });

  test('should refuse, and leave as it is, a taken number the account held before', async () => {
    const update = vi.fn();
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Number not available'), {
        code: 21422,
        status: 400,
      });
    });
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: listedOnlyAfterPurchase({
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
          dateCreated: new Date('2025-03-14T09:12:00.000Z'),
          voiceApplicationSid: 'APbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        }),
        create,
        update,
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(
        /has had this number since 2025-03-14.*Add a number you own/,
      ),
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  test('should refuse a taken number Twilio dated just before the window', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: listedOnlyAfterPurchase({
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
          dateCreated: '2026-04-21T11:49:59.000Z',
        }),
        create: vi.fn(async () => {
          throw Object.assign(new Error('Number not available'), {
            code: 21422,
          });
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test('should refuse a taken number Twilio gives no date for', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: listedOnlyAfterPurchase({
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
        }),
        create: vi.fn(async () => {
          throw Object.assign(new Error('Number not available'), {
            code: 21422,
          });
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Add a number you own'),
    });
  });

  test('should refuse an unanswered purchase of a number the account held before', async () => {
    const update = vi.fn();
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: listedOnlyAfterPurchase({
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
          dateCreated: '2025-03-14T09:12:00.000Z',
        }),
        create: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
        update,
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('Add a number you own'),
    });
    expect(update).not.toHaveBeenCalled();
  });

  test('should not call a taken number unavailable when the account cannot be checked for it', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: unreachableAfterPurchase(),
        create: vi.fn(async () => {
          throw Object.assign(new Error('Number not available'), {
            code: 21422,
            status: 400,
          });
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({ statusCode: 504 });
  });

  test('should report a purchase that failed inside Twilio as bought when the account has the number', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: listedOnlyAfterPurchase({
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
          dateCreated: SOLD_JUST_NOW,
        }),
        create: vi.fn(async () => {
          throw Object.assign(new Error('Internal error'), {
            code: 20500,
            status: 500,
          });
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).resolves.toBeUndefined();
  });

  test('should report a purchase failure when the account cannot be asked either', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: unreachableAfterPurchase(),
        create: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 504,
      message: expect.stringContaining('socket hang up'),
    });
  });

  test('should not report a lost purchase as failed because the account does not list the number yet', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => []),
        create: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({
      statusCode: 504,
      message: expect.stringContaining('does not list the number yet'),
    });
  });

  test('should report other refusals as a provider error', async () => {
    const list = vi.fn(async () => []);
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list,
        create: vi.fn(async () => {
          throw Object.assign(new Error('Account suspended'), {
            code: 20005,
            status: 401,
          });
        }),
      }),
    });

    await expect(
      service.buyNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({ statusCode: 502, message: 'Account suspended' });
    // Only the check before buying: a refusal bought nothing to look for.
    expect(list).toHaveBeenCalledTimes(1);
  });

  test('should release an owned Twilio number by SID', async () => {
    const remove = vi.fn(async () => true);
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }]),
        remove,
      }),
    });

    await expect(service.cancelNumber(OWNED_LINE)).resolves.toBe('released');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('should reconnect a number hosted on the account, not only one bought from Twilio', async () => {
    const update = vi.fn(async (params: Record<string, unknown>) => ({
      sid: OWNED_SID,
      ...params,
    }));
    const list = vi.fn(async (params: Record<string, unknown>) =>
      params.origin === 'twilio'
        ? []
        : [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }],
    );
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ list, update }),
    });

    await service.configureNumber(OWNED_LINE);

    expect(update).toHaveBeenCalledTimes(1);
  });

  test('should release a number hosted on the account, not only one bought from Twilio', async () => {
    const remove = vi.fn(async () => true);
    const list = vi.fn(async (params: Record<string, unknown>) =>
      params.origin === 'twilio'
        ? []
        : [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }],
    );
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ list, remove }),
    });

    await expect(service.cancelNumber(OWNED_LINE)).resolves.toBe('released');
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('should count a removal whose answer was lost when the account no longer has the number', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce([{ sid: OWNED_SID, phoneNumber: OWNED_LINE }])
      .mockResolvedValueOnce([]);
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list,
        remove: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
      }),
    });

    await expect(service.cancelNumber(OWNED_LINE)).resolves.toBe('released');
  });

  test('should count a removal another release finished first, whatever the listing still shows', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }]),
        remove: vi.fn(async () => {
          throw Object.assign(
            new Error('The requested resource was not found'),
            {
              code: 20404,
              status: 404,
            },
          );
        }),
      }),
    });

    await expect(service.cancelNumber(OWNED_LINE)).resolves.toBe('released');
  });

  test('should call a removal unconfirmed when the account still lists the number after a lost answer', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }]),
        remove: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
      }),
    });

    await expect(service.cancelNumber(OWNED_LINE)).resolves.toBe('unconfirmed');
  });

  test('should report a removal Twilio refused while it still has the number', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }]),
        remove: vi.fn(async () => {
          throw Object.assign(
            new Error('Number is in use by a regulatory bundle'),
            { code: 21649, status: 400 },
          );
        }),
      }),
    });

    const refused = service.cancelNumber(OWNED_LINE);

    await expect(refused).rejects.toBeInstanceOf(ReleaseRefusedError);
    await expect(refused).rejects.toMatchObject({
      statusCode: 502,
      message: 'Number is in use by a regulatory bundle',
    });
  });

  test('should take a refused removal at its word when the account cannot be asked', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi
          .fn()
          .mockResolvedValueOnce([{ sid: OWNED_SID, phoneNumber: OWNED_LINE }])
          .mockRejectedValueOnce(new Error('Twilio is unreachable')),
        remove: vi.fn(async () => {
          throw Object.assign(
            new Error('Number is in use by a regulatory bundle'),
            { code: 21649, status: 400 },
          );
        }),
      }),
    });

    await expect(service.cancelNumber(OWNED_LINE)).rejects.toMatchObject({
      statusCode: 502,
      message: 'Number is in use by a regulatory bundle',
    });
  });

  test('should call a removal unconfirmed when neither Twilio nor the account answers', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi
          .fn()
          .mockResolvedValueOnce([{ sid: OWNED_SID, phoneNumber: OWNED_LINE }])
          .mockRejectedValueOnce(new Error('Twilio is unreachable')),
        remove: vi.fn(async () => {
          throw new Error('socket hang up');
        }),
      }),
    });

    await expect(service.cancelNumber(OWNED_LINE)).resolves.toBe('unconfirmed');
  });

  test('should report a number the account no longer has instead of failing', async () => {
    const remove = vi.fn(async () => true);
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => []),
        remove,
      }),
    });

    await expect(service.cancelNumber(OWNED_LINE)).resolves.toBe(
      'not-in-account',
    );
    expect(remove).not.toHaveBeenCalled();
  });

  test('should read text capabilities written in capitals', async () => {
    const localList = vi.fn(async () => [
      {
        phoneNumber: OWNED_LINE,
        capabilities: { voice: true, SMS: true, MMS: true },
      },
    ]);
    const service = buildService({
      availablePhoneNumbers: vi.fn(() => ({
        local: { list: localList },
        tollFree: { list: vi.fn(async () => []) },
      })),
    });

    const result = await service.searchAvailableNumbers({
      country: 'US',
      type: 'LOCAL',
      limit: 5,
    });

    expect(result.numbers[0]?.capabilities).toEqual({
      voice: true,
      sms: true,
      mms: true,
    });
  });

  test('should quote the monthly price for the number type', async () => {
    const fetch = vi.fn(async () => ({
      priceUnit: 'usd',
      phoneNumberPrices: [
        { numberType: 'local', basePrice: '1.15', currentPrice: '1.15' },
        { numberType: 'Toll Free', basePrice: 2.15, currentPrice: 2.15 },
      ],
    }));
    const countries = vi.fn(() => ({ fetch }));
    const service = buildService({
      pricing: { v1: { phoneNumbers: { countries } } },
    });

    await expect(service.getMonthlyPrice('US', 'LOCAL')).resolves.toEqual({
      amount: '1.15',
      currency: 'USD',
    });
    await expect(service.getMonthlyPrice('US', 'TOLL_FREE')).resolves.toEqual({
      amount: '2.15',
      currency: 'USD',
    });
    expect(countries).toHaveBeenCalledWith('US');
  });

  test('should answer no price when the price list lacks the number type', async () => {
    const service = buildService({
      pricing: buildPricingResource(
        vi.fn(async () => ({
          priceUnit: 'USD',
          phoneNumberPrices: [{ numberType: 'mobile', basePrice: '1.00' }],
        })),
      ),
    });

    await expect(service.getMonthlyPrice('US', 'LOCAL')).resolves.toBeNull();
  });

  test('should report missing configuration by name without contacting Twilio', async () => {
    const list = vi.fn(async () => []);
    const service = new TwilioNumberManagementService({
      credentials: null,
      publicUrl: API_URL,
      callControllerPublicUrl: null,
      log,
      client: {
        availablePhoneNumbers: vi.fn(),
        incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ list }),
      } as unknown as TwilioClientLike,
    });

    const report = await service.getReadinessReport([]);

    expect(service.hasAnyConfiguration()).toBe(false);
    expect(report.status).toBe('error');
    expect(report.account).toEqual({
      sid: null,
      configured: false,
      reachable: null,
    });
    expect(report.issues).toEqual([
      'Twilio credentials are not configured',
      'Call controller public URL is not configured; voice webhooks cannot be set',
    ]);
    expect(list).not.toHaveBeenCalled();
  });

  test('should flag listed numbers that need Reconnect, and only those', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            ...POINTED_HERE,
          },
          {
            sid: 'PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            phoneNumber: '+15555550102',
            ...POINTED_HERE,
            smsUrl: 'https://old.example.com/webhooks/twilio/messages/inbound',
          },
          {
            // Set up before calls had their own status route: Reconnect fixes it.
            sid: 'PNcccccccccccccccccccccccccccccccc',
            phoneNumber: '+15555550103',
            ...POINTED_HERE,
            statusCallback: `${API_URL}/webhooks/twilio/messages/status`,
          },
          {
            // Right webhooks, but a TwiML App attached by hand wins over them.
            sid: 'PNdddddddddddddddddddddddddddddddd',
            phoneNumber: '+15555550104',
            ...POINTED_HERE,
            voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
          {
            // Serves something else on the same account; not ours to judge.
            sid: 'PNeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            phoneNumber: '+15555550105',
            voiceUrl: 'https://agent.example.com/voice',
          },
        ]),
      }),
    });

    const report = await service.getReadinessReport(
      ['+15555550101', '+15555550102', '+15555550103', '+15555550104'].map(
        (phoneNumber) => ({ phoneNumber, type: 'TOLL_FREE' as const }),
      ),
    );

    expect(report.status).toBe('error');
    expect(report.account.reachable).toBe(true);
    expect(report.numbers).toEqual({
      checked: 4,
      misconfigured: ['+15555550102', '+15555550103', '+15555550104'],
      reasons: {
        '+15555550102': ['sms-url'],
        '+15555550103': ['status-callback'],
        '+15555550104': ['voice-application'],
      },
      notInAccount: [],
      untracked: 1,
      texting: {},
    });
    expect(report.issues).toEqual([
      '+15555550102 needs Reconnect: its messaging URL points elsewhere or is not called with POST',
      '+15555550103 needs Reconnect: its status callback points elsewhere or is not called with POST',
      '+15555550104 needs Reconnect: a TwiML App takes its calls',
    ]);
  });

  test('should warn about a listed number the account does not hold without failing', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          { sid: OWNED_SID, phoneNumber: OWNED_LINE, ...POINTED_HERE },
        ]),
      }),
    });

    const report = await service.getReadinessReport([
      { phoneNumber: OWNED_LINE, type: 'LOCAL' },
      { phoneNumber: '+15555550109', type: 'LOCAL' },
    ]);

    expect(report.status).toBe('ok');
    expect(report.numbers.notInAccount).toEqual(['+15555550109']);
    expect(report.warnings).toEqual([expect.stringContaining('+15555550109')]);
  });

  test('should warn when a messaging service takes a number’s texts, and stop once it lets the number’s webhook have them', async () => {
    const texting = {
      sid: OWNED_SID,
      phoneNumber: OWNED_LINE,
      capabilities: { voice: true, sms: true },
      ...POINTED_HERE,
    };
    const services = (useInboundWebhookOnNumber: boolean) =>
      buildMessagingResource([
        {
          sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          friendlyName: 'Customer Care',
          useInboundWebhookOnNumber,
          senders: [OWNED_LINE],
        },
      ]);
    const tracked = [{ phoneNumber: OWNED_LINE, type: 'LOCAL' as const }];
    const incomingPhoneNumbers = buildIncomingPhoneNumbersResource({
      list: vi.fn(async () => [texting]),
    });

    const taken = await buildService({
      incomingPhoneNumbers,
      messaging: services(false),
    }).getReadinessReport(tracked);
    const back = await buildService({
      incomingPhoneNumbers,
      messaging: services(true),
    }).getReadinessReport(tracked);

    expect(taken.status).toBe('ok');
    expect(taken.numbers.texting).toEqual({
      [OWNED_LINE]: {
        kind: 'service-takes-texts',
        service: {
          sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          friendlyName: 'Customer Care',
        },
      },
    });
    expect(taken.warnings).toEqual([
      expect.stringContaining('"Customer Care"'),
    ]);
    expect(back.warnings).toEqual([]);
    expect(back.numbers.texting).toEqual({});
  });

  test('should not warn about a service that keeps its senders’ texts but sends them here itself', async () => {
    const report = await buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            capabilities: { voice: true, sms: true },
            ...POINTED_HERE,
          },
        ]),
      }),
      messaging: buildMessagingResource([
        {
          sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          friendlyName: 'Customer Care',
          useInboundWebhookOnNumber: false,
          inboundRequestUrl: POINTED_HERE.smsUrl,
          senders: [OWNED_LINE],
        },
      ]),
    }).getReadinessReport([{ phoneNumber: OWNED_LINE, type: 'LOCAL' }]);

    expect(report.warnings).toEqual([]);
    expect(report.numbers.texting).toEqual({});
  });

  test('should note that a local number in no messaging service cannot text yet', async () => {
    const report = await buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            type: 'local',
            capabilities: { voice: true, sms: true },
            ...POINTED_HERE,
          },
        ]),
      }),
    }).getReadinessReport([{ phoneNumber: OWNED_LINE, type: 'LOCAL' }]);

    expect(report.status).toBe('ok');
    expect(report.numbers.texting).toEqual({
      [OWNED_LINE]: { kind: 'unregistered' },
    });
    expect(report.warnings).toEqual([expect.stringContaining('A2P 10DLC')]);
  });

  test('should say once that texting was not checked when the services cannot be read', async () => {
    const report = await buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            capabilities: { sms: true },
            ...POINTED_HERE,
          },
        ]),
      }),
      messaging: {
        v1: {
          services: Object.assign(
            vi.fn(() => ({ phoneNumbers: { list: vi.fn() } })),
            {
              list: vi.fn(async () => {
                throw new Error('Forbidden');
              }),
            },
          ),
        },
      },
    }).getReadinessReport([{ phoneNumber: OWNED_LINE, type: 'LOCAL' }]);

    expect(report.status).toBe('ok');
    expect(report.warnings).toEqual([
      "The account's messaging services could not be read, so whether texts reach the listed numbers was not checked.",
    ]);
  });

  test('should report an unreachable account as an issue', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => {
          throw new Error('Authentication failed');
        }),
      }),
    });

    const report = await service.getReadinessReport([]);

    expect(report.status).toBe('error');
    expect(report.account.reachable).toBe(false);
    expect(report.issues).toEqual(['Authentication failed']);
  });

  test('should describe every account number with what takes its calls and texts today', async () => {
    const applicationsList = vi.fn(async () => [
      { sid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', friendlyName: 'Old IVR' },
    ]);
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            friendlyName: 'Main line',
            type: 'local',
            capabilities: { voice: true, sms: true, mms: true, fax: false },
            voiceUrl: 'https://demo.example.com/welcome/voice',
            voiceApplicationSid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            smsUrl: '',
          },
          {
            sid: 'PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            phoneNumber: '+15555550102',
            type: 'local',
            capabilities: { voice: true, sms: true },
            smsUrl: 'https://agent.example.com/sms',
          },
        ]),
      }),
      applications: { list: applicationsList },
      messaging: buildMessagingResource([
        {
          sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          friendlyName: 'Customer Care',
          useInboundWebhookOnNumber: true,
          senders: ['+15555550102'],
        },
      ]),
    });

    const owned = await service.listAccountNumbers();

    expect(owned.truncated).toBe(false);
    expect(owned.numbers).toEqual([
      {
        phoneNumber: OWNED_LINE,
        friendlyName: 'Main line',
        type: 'LOCAL',
        capabilities: { voice: true, sms: true, mms: true, fax: false },
        attached: {
          voiceUrlHost: 'demo.example.com',
          smsUrlHost: null,
          voiceApplication: {
            sid: 'APaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            friendlyName: 'Old IVR',
          },
          smsApplication: null,
          sipTrunkSid: null,
          messagingService: null,
        },
        texting: { kind: 'unregistered' },
      },
      expect.objectContaining({
        phoneNumber: '+15555550102',
        attached: expect.objectContaining({
          smsUrlHost: 'agent.example.com',
          voiceApplication: null,
          messagingService: {
            sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            friendlyName: 'Customer Care',
          },
        }),
        texting: null,
      }),
    ]);
  });

  test('should not ask for application names when no number has one attached', async () => {
    const applicationsList = vi.fn(async () => []);
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }]),
      }),
      applications: { list: applicationsList },
    });

    await service.listAccountNumbers();

    expect(applicationsList).not.toHaveBeenCalled();
  });

  test('should say whether a listed number reaches this deployment now', async () => {
    const list = vi.fn(async (params: Record<string, unknown>) =>
      params.phoneNumber === OWNED_LINE
        ? [
            {
              sid: OWNED_SID,
              phoneNumber: OWNED_LINE,
              capabilities: { voice: true, sms: true },
              ...POINTED_HERE,
              voiceUrl: 'https://demo.example.com/voice',
            },
          ]
        : [],
    );
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({ list }),
      messaging: buildMessagingResource([
        {
          sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          friendlyName: 'Customer Care',
          useInboundWebhookOnNumber: false,
          senders: [OWNED_LINE],
        },
      ]),
    });

    await expect(service.checkConnection(OWNED_LINE, 'LOCAL')).resolves.toEqual(
      {
        state: 'checked',
        needsReconnect: ['voice-url'],
        texting: {
          kind: 'service-takes-texts',
          service: {
            sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            friendlyName: 'Customer Care',
          },
        },
        messagingService: {
          sid: 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          friendlyName: 'Customer Care',
          campaign: {
            status: 'approved',
            twilioStatus: 'VERIFIED',
            useCase: 'CUSTOMER_CARE',
            description: 'Customer Care replies',
          },
          keepsIncomingTexts: true,
        },
      },
    );
    await expect(
      service.checkConnection('+15555550109', 'LOCAL'),
    ).resolves.toEqual({ state: 'not-in-account' });
  });

  test('should call texting unknown rather than read more messaging services than a check should', async () => {
    const services = Array.from({ length: 21 }, (_, index) => ({
      sid: `MG${String(index).padStart(32, '0')}`,
      friendlyName: `Service ${index}`,
      useInboundWebhookOnNumber: true,
      senders: [],
    }));
    const messaging = buildMessagingResource(services);
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            capabilities: { sms: true },
            ...POINTED_HERE,
          },
        ]),
      }),
      messaging,
    });

    const connection = await service.checkConnection(OWNED_LINE, 'LOCAL');

    expect(connection).toMatchObject({ texting: { kind: 'unknown' } });
    expect(messaging.v1.services).not.toHaveBeenCalled();
  });
});

describe('TwilioNumberManagementService messaging services', () => {
  const CUSTOMER_CARE = 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const APPOINTMENTS = 'MGbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const ownedNumbers = () =>
    buildIncomingPhoneNumbersResource({
      list: vi.fn(async () => [
        {
          sid: OWNED_SID,
          phoneNumber: OWNED_LINE,
          capabilities: { voice: true, sms: true },
          ...POINTED_HERE,
        },
      ]),
    });
  const twoServices = (
    overrides: {
      customerCare?: Partial<FakeMessagingService>;
      appointments?: Partial<FakeMessagingService>;
    } = {},
  ) =>
    buildMessagingResource([
      {
        sid: CUSTOMER_CARE,
        friendlyName: 'Customer Care',
        useInboundWebhookOnNumber: true,
        senders: [OWNED_LINE],
        ...overrides.customerCare,
      },
      {
        sid: APPOINTMENTS,
        friendlyName: 'Appointments',
        useInboundWebhookOnNumber: true,
        senders: [],
        ...overrides.appointments,
      },
    ]);

  test.each([
    [null, 'has no A2P 10DLC campaign'],
    ['IN_PROGRESS', 'not approved yet'],
    ['FAILED', 'was not approved'],
  ])(
    'should warn about a listed local number whose service has campaign %s',
    async (campaignStatus, says) => {
      const messaging = twoServices({ customerCare: { campaignStatus } });
      const report = await buildService({
        incomingPhoneNumbers: ownedNumbers(),
        messaging,
      }).getReadinessReport([{ phoneNumber: OWNED_LINE, type: 'LOCAL' }]);

      expect(report.warnings).toEqual([expect.stringContaining(says)]);
      // Only the campaigns of services holding a listed local number are read.
      expect(
        messaging.v1.services(APPOINTMENTS).usAppToPerson.list,
      ).not.toHaveBeenCalled();
    },
  );

  test('should not hold a toll-free number to its service’s campaign', async () => {
    const report = await buildService({
      incomingPhoneNumbers: ownedNumbers(),
      messaging: twoServices({ customerCare: { campaignStatus: null } }),
    }).getReadinessReport([{ phoneNumber: OWNED_LINE, type: 'TOLL_FREE' }]);

    expect(report.warnings).toEqual([]);
  });

  test('should call texting unknown when a campaign cannot be read', async () => {
    const messaging = twoServices();
    messaging.v1
      .services(CUSTOMER_CARE)
      .usAppToPerson.list.mockRejectedValueOnce(new Error('Forbidden'));

    const connection = await buildService({
      incomingPhoneNumbers: ownedNumbers(),
      messaging,
    }).checkConnection(OWNED_LINE, 'LOCAL');

    expect(connection).toMatchObject({
      texting: { kind: 'unknown' },
      messagingService: null,
    });
  });

  test('should list every service with its campaign and whether it keeps incoming texts', async () => {
    const services = await buildService({
      messaging: twoServices({
        appointments: {
          campaignStatus: 'FAILED',
          useInboundWebhookOnNumber: false,
          inboundRequestUrl: 'https://agent.example.com/sms',
        },
      }),
    }).listMessagingServices();

    expect(services).toEqual([
      {
        sid: CUSTOMER_CARE,
        friendlyName: 'Customer Care',
        campaign: expect.objectContaining({ status: 'approved' }),
        keepsIncomingTexts: false,
      },
      {
        sid: APPOINTMENTS,
        friendlyName: 'Appointments',
        campaign: expect.objectContaining({
          status: 'not-approved',
          twilioStatus: 'FAILED',
        }),
        keepsIncomingTexts: true,
      },
    ]);
  });

  test('should answer the services unknown when they cannot be listed', async () => {
    const messaging = twoServices();
    messaging.v1.services.list.mockRejectedValueOnce(new Error('Forbidden'));

    await expect(
      buildService({ messaging }).listMessagingServices(),
    ).resolves.toBe('unknown');
  });

  test('should read one service, and answer null for a sid the account does not have', async () => {
    const service = buildService({ messaging: twoServices() });

    await expect(service.readMessagingService(APPOINTMENTS)).resolves.toEqual(
      expect.objectContaining({
        sid: APPOINTMENTS,
        friendlyName: 'Appointments',
      }),
    );
    await expect(
      service.readMessagingService('MGcccccccccccccccccccccccccccccccc'),
    ).resolves.toBeNull();
  });

  test('should say which service a number sends for, null for none', async () => {
    const service = buildService({
      incomingPhoneNumbers: ownedNumbers(),
      messaging: twoServices(),
    });

    await expect(service.currentMessagingService(OWNED_LINE)).resolves.toEqual({
      sid: CUSTOMER_CARE,
      friendlyName: 'Customer Care',
    });
  });

  test('should add a number that is in no service', async () => {
    const messaging = twoServices({ customerCare: { senders: [] } });
    const service = buildService({
      incomingPhoneNumbers: ownedNumbers(),
      messaging,
    });

    await expect(
      service.addToMessagingService(OWNED_LINE, APPOINTMENTS),
    ).resolves.toEqual({ state: 'joined' });
    expect(messaging.sendersOf(APPOINTMENTS)).toEqual([OWNED_LINE]);
  });

  test('should keep a number in the service it is in already', async () => {
    const messaging = twoServices();
    const service = buildService({
      incomingPhoneNumbers: ownedNumbers(),
      messaging,
    });

    await expect(
      service.addToMessagingService(OWNED_LINE, APPOINTMENTS),
    ).resolves.toEqual({
      state: 'kept',
      service: { sid: CUSTOMER_CARE, friendlyName: 'Customer Care' },
    });
    expect(messaging.sendersOf(CUSTOMER_CARE)).toEqual([OWNED_LINE]);
    expect(messaging.sendersOf(APPOINTMENTS)).toEqual([]);
  });

  test('should take an addition whose answer was lost but that Twilio made', async () => {
    const messaging = twoServices({ customerCare: { senders: [] } });
    const create = messaging.v1.services(APPOINTMENTS).phoneNumbers.create;
    const add = create.getMockImplementation();
    create.mockImplementationOnce(async (params) => {
      await add?.(params);
      throw new Error('socket hang up');
    });

    await expect(
      buildService({
        incomingPhoneNumbers: ownedNumbers(),
        messaging,
      }).addToMessagingService(OWNED_LINE, APPOINTMENTS),
    ).resolves.toEqual({ state: 'joined' });
  });

  test('should move a number, writing it down before anything changes', async () => {
    const messaging = twoServices();
    const service = buildService({
      incomingPhoneNumbers: ownedNumbers(),
      messaging,
    });
    const beforeChange = vi.fn(async () => {
      expect(messaging.sendersOf(CUSTOMER_CARE)).toEqual([OWNED_LINE]);
    });

    await expect(
      service.moveToMessagingService(
        OWNED_LINE,
        APPOINTMENTS,
        CUSTOMER_CARE,
        beforeChange,
      ),
    ).resolves.toEqual({
      from: { sid: CUSTOMER_CARE, friendlyName: 'Customer Care' },
      changed: true,
    });
    expect(beforeChange).toHaveBeenCalledWith({
      sid: CUSTOMER_CARE,
      friendlyName: 'Customer Care',
    });
    expect(messaging.sendersOf(CUSTOMER_CARE)).toEqual([]);
    expect(messaging.sendersOf(APPOINTMENTS)).toEqual([OWNED_LINE]);
  });

  test('should refuse a move when the number is not in the service the admin saw', async () => {
    const messaging = twoServices();
    const beforeChange = vi.fn();

    await expect(
      buildService({
        incomingPhoneNumbers: ownedNumbers(),
        messaging,
      }).moveToMessagingService(OWNED_LINE, APPOINTMENTS, null, beforeChange),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(beforeChange).not.toHaveBeenCalled();
    expect(messaging.sendersOf(CUSTOMER_CARE)).toEqual([OWNED_LINE]);
  });

  test('should change nothing when the number is in that service already', async () => {
    const messaging = twoServices();
    const beforeChange = vi.fn();

    await expect(
      buildService({
        incomingPhoneNumbers: ownedNumbers(),
        messaging,
      }).moveToMessagingService(
        OWNED_LINE,
        CUSTOMER_CARE,
        CUSTOMER_CARE,
        beforeChange,
      ),
    ).resolves.toMatchObject({ changed: false });
    expect(beforeChange).not.toHaveBeenCalled();
    expect(
      messaging.v1.services(CUSTOMER_CARE).phoneNumbers,
    ).not.toHaveBeenCalled();
  });

  test('should put the number back when the new service refuses it', async () => {
    const messaging = twoServices({ appointments: { refusesSenders: true } });

    await expect(
      buildService({
        incomingPhoneNumbers: ownedNumbers(),
        messaging,
      }).moveToMessagingService(OWNED_LINE, APPOINTMENTS, CUSTOMER_CARE),
    ).rejects.toThrow('It is back in "Customer Care", as before.');
    expect(messaging.sendersOf(CUSTOMER_CARE)).toEqual([OWNED_LINE]);
  });

  test('should say the number is in no service when it cannot be put back', async () => {
    const messaging = twoServices({
      customerCare: { refusesSenders: true },
      appointments: { refusesSenders: true },
    });

    await expect(
      buildService({
        incomingPhoneNumbers: ownedNumbers(),
        messaging,
      }).moveToMessagingService(OWNED_LINE, APPOINTMENTS, CUSTOMER_CARE),
    ).rejects.toThrow('it is in no messaging service now');
    expect(messaging.sendersOf(CUSTOMER_CARE)).toEqual([]);
  });

  test('should change nothing when the services cannot be read', async () => {
    const messaging = twoServices();
    messaging.v1.services.list.mockRejectedValueOnce(new Error('Forbidden'));

    await expect(
      buildService({
        incomingPhoneNumbers: ownedNumbers(),
        messaging,
      }).moveToMessagingService(OWNED_LINE, APPOINTMENTS, CUSTOMER_CARE),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(messaging.sendersOf(CUSTOMER_CARE)).toEqual([OWNED_LINE]);
  });
});

interface FakeMessagingService {
  sid: string;
  friendlyName: string;
  useInboundWebhookOnNumber: boolean;
  inboundRequestUrl?: string;
  senders: string[];
  /** The campaign's status at Twilio: VERIFIED unless a test says otherwise, null for none. */
  campaignStatus?: string | null;
  /** Twilio refuses every number added to it. */
  refusesSenders?: boolean;
}

/**
 * The account's messaging services, holding their senders the way Twilio
 * does: one service per number, added and removed by the number's `PN` sid.
 * `sendersOf` reads them back after a test changed them.
 */
function buildMessagingResource(
  services: FakeMessagingService[],
  numbersBySid: Record<string, string> = { [OWNED_SID]: OWNED_LINE },
) {
  const senders = new Map(
    services.map((service) => [service.sid, [...service.senders]]),
  );
  const phoneOf = (numberSid: string) => {
    const phoneNumber = numbersBySid[numberSid];

    if (!phoneNumber) {
      throw Object.assign(new Error('The requested resource was not found'), {
        code: 20404,
        status: 404,
      });
    }
    return phoneNumber;
  };
  const contexts = new Map<string, ReturnType<typeof contextOf>>();
  const contextOf = (sid: string) => {
    const service = services.find((candidate) => candidate.sid === sid);

    return {
      fetch: vi.fn(async () => {
        if (!service) {
          throw Object.assign(
            new Error('The requested resource was not found'),
            { code: 20404, status: 404 },
          );
        }

        const {
          senders: _senders,
          campaignStatus: _campaignStatus,
          refusesSenders: _refusesSenders,
          ...fields
        } = service;
        return fields;
      }),
      phoneNumbers: Object.assign(
        vi.fn((numberSid: string) => ({
          remove: vi.fn(async () => {
            const phoneNumber = phoneOf(numberSid);

            senders.set(
              sid,
              (senders.get(sid) ?? []).filter((held) => held !== phoneNumber),
            );
            return true;
          }),
        })),
        {
          list: vi.fn(async () =>
            (senders.get(sid) ?? []).map((phoneNumber) => ({ phoneNumber })),
          ),
          create: vi.fn(
            async ({ phoneNumberSid }: { phoneNumberSid: string }) => {
              const phoneNumber = phoneOf(phoneNumberSid);

              if (service?.refusesSenders) {
                throw new Error(
                  'Phone number is already in use by another service',
                );
              }
              if (
                [...senders.values()].some((held) => held.includes(phoneNumber))
              ) {
                throw new Error(
                  'Phone Number or Short Code is already in the Messaging Service',
                );
              }

              senders.set(sid, [...(senders.get(sid) ?? []), phoneNumber]);
              return { sid: phoneNumberSid, phoneNumber };
            },
          ),
        },
      ),
      usAppToPerson: {
        list: vi.fn(async () => {
          const campaignStatus =
            service?.campaignStatus === undefined
              ? 'VERIFIED'
              : service.campaignStatus;

          return campaignStatus === null
            ? []
            : [
                {
                  campaignStatus,
                  usAppToPersonUsecase: 'CUSTOMER_CARE',
                  description: `${service?.friendlyName} replies`,
                },
              ];
        }),
      },
    };
  };
  const servicesResource = Object.assign(
    vi.fn((sid: string) => {
      const context = contexts.get(sid) ?? contextOf(sid);

      contexts.set(sid, context);
      return context;
    }),
    {
      list: vi.fn(async (params: Record<string, unknown>) =>
        services
          .slice(0, Number(params.limit ?? services.length))
          .map(
            ({
              senders: _senders,
              campaignStatus: _campaignStatus,
              refusesSenders: _refusesSenders,
              ...service
            }) => service,
          ),
      ),
    },
  );

  return {
    v1: { services: servicesResource },
    sendersOf: (sid: string) => senders.get(sid) ?? [],
  };
}

function buildPricingResource(fetch: Mock): TwilioClientLike['pricing'] {
  return { v1: { phoneNumbers: { countries: vi.fn(() => ({ fetch })) } } };
}

function buildIncomingPhoneNumbersResource(overrides?: {
  list?: Mock;
  create?: Mock;
  update?: Mock;
  remove?: Mock;
  fetch?: Mock;
}) {
  const list = overrides?.list ?? vi.fn(async () => []);
  const create =
    overrides?.create ??
    vi.fn(async () => ({ sid: OWNED_SID, phoneNumber: OWNED_LINE }));
  // Twilio answers an update with the number as it now is.
  const update =
    overrides?.update ??
    vi.fn(async (params: Record<string, unknown>) => ({
      sid: OWNED_SID,
      phoneNumber: OWNED_LINE,
      ...params,
    }));
  const remove = overrides?.remove ?? vi.fn(async () => true);
  const fetch =
    overrides?.fetch ??
    vi.fn(async () => ({ sid: OWNED_SID, phoneNumber: OWNED_LINE }));

  const resource = ((_: string) => ({
    update,
    remove,
    fetch,
  })) as ReturnType<typeof buildIncomingPhoneNumbersResource> & {
    create: typeof create;
    list: typeof list;
  };

  resource.create = create;
  resource.list = list;

  return resource;
}
