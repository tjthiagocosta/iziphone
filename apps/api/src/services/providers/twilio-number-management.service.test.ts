import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, type Mock, test, vi } from 'vitest';
import {
  type TwilioClientLike,
  TwilioNumberManagementService,
} from './twilio-number-management.service.js';

const OWNED_LINE = '+15555550101';
const OWNED_SID = 'PNaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API_URL = 'https://api.example.com';
const CALLS_URL = 'https://calls.example.com';

const log = { error: vi.fn() } as unknown as FastifyBaseLogger;

function buildService(
  client: Partial<TwilioClientLike>,
  overrides: {
    callControllerPublicUrl?: string | null;
    credentials?: null;
  } = {},
) {
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
      ...client,
    } as TwilioClientLike,
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

  test('should point messaging webhooks at the API and voice webhooks at the call controller', async () => {
    const update = vi.fn(async () => ({ sid: OWNED_SID }));
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }]),
        update,
      }),
    });

    await service.configureNumber({ country: 'US', phoneNumber: OWNED_LINE });

    expect(update).toHaveBeenCalledWith({
      smsUrl: `${API_URL}/webhooks/twilio/messages/inbound`,
      smsMethod: 'POST',
      statusCallback: `${API_URL}/webhooks/twilio/messages/status`,
      statusCallbackMethod: 'POST',
      voiceUrl: `${CALLS_URL}/webhooks/twilio/voice/inbound`,
      voiceMethod: 'POST',
      voiceFallbackUrl: `${CALLS_URL}/webhooks/twilio/voice/fallback`,
      voiceFallbackMethod: 'POST',
    });
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

    await expect(
      service.configureNumber({ country: 'US', phoneNumber: OWNED_LINE }),
    ).rejects.toMatchObject({ statusCode: 503 });
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

  test('should release an owned Twilio number by SID', async () => {
    const remove = vi.fn(async () => true);
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [{ sid: OWNED_SID, phoneNumber: OWNED_LINE }]),
        remove,
      }),
    });

    await service.cancelNumber({ country: 'US', phoneNumber: OWNED_LINE });

    expect(remove).toHaveBeenCalledTimes(1);
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

    const report = await service.getReadinessReport();

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

  test('should flag owned numbers whose webhooks point elsewhere', async () => {
    const service = buildService({
      incomingPhoneNumbers: buildIncomingPhoneNumbersResource({
        list: vi.fn(async () => [
          {
            sid: OWNED_SID,
            phoneNumber: OWNED_LINE,
            smsUrl: `${API_URL}/webhooks/twilio/messages/inbound`,
            statusCallback: `${API_URL}/webhooks/twilio/messages/status`,
            voiceUrl: `${CALLS_URL}/webhooks/twilio/voice/inbound`,
            voiceFallbackUrl: `${CALLS_URL}/webhooks/twilio/voice/fallback/`,
          },
          {
            sid: 'PNbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            phoneNumber: '+15555550102',
            smsUrl: 'https://old.example.com/webhooks/twilio/messages/inbound',
          },
        ]),
      }),
    });

    const report = await service.getReadinessReport();

    expect(report.status).toBe('error');
    expect(report.account.reachable).toBe(true);
    expect(report.numbers).toEqual({
      checked: 2,
      misconfigured: ['+15555550102'],
    });
    expect(report.issues).toEqual([
      '1 owned number(s) have webhooks that do not point at this deployment',
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

    const report = await service.getReadinessReport();

    expect(report.status).toBe('error');
    expect(report.account.reachable).toBe(false);
    expect(report.issues).toEqual(['Authentication failed']);
  });
});

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
  const update = overrides?.update ?? vi.fn(async () => ({ sid: OWNED_SID }));
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
