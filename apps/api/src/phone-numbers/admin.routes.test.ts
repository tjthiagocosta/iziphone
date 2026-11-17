import type { PurchasedPhoneNumber } from '@repo/dto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AdminServiceError } from '../admin/index.js';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../test/route-test-helpers.js';
import { adminPhoneNumberRoutes } from './admin.routes.js';
import { PhoneNumberService } from './phone-number.service.js';
import { TwilioProviderError } from './twilio-numbers.js';

const CUSTOMER_CARE_SID = 'MGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('adminPhoneNumberRoutes', () => {
  let app: FastifyInstance;
  let searchAvailableSpy: ReturnType<typeof vi.spyOn>;
  let purchaseSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;
  let releaseSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    searchAvailableSpy = vi
      .spyOn(PhoneNumberService.prototype, 'searchAvailable')
      .mockResolvedValue({
        numbers: [
          {
            phoneNumber: '+15555550101',
            friendlyName: '(555) 555-0101',
            type: 'LOCAL',
            providerType: 'local',
            locality: null,
            region: null,
            postalCode: null,
            isoCountry: 'US',
            capabilities: {
              voice: true,
              sms: true,
              mms: false,
            },
          },
        ],
        monthlyPrice: { amount: '1.15', currency: 'USD' },
      });
    purchaseSpy = vi
      .spyOn(PhoneNumberService.prototype, 'purchase')
      .mockResolvedValue(purchased());
    updateSpy = vi
      .spyOn(PhoneNumberService.prototype, 'update')
      .mockImplementation(async () => {
        throw new AdminServiceError('Department not found');
      });
    releaseSpy = vi
      .spyOn(PhoneNumberService.prototype, 'release')
      .mockResolvedValue(null);

    app = await createApiRouteApp(
      withAuthenticatedUser(adminPhoneNumberRoutes),
    );
  });

  afterEach(async () => {
    searchAvailableSpy.mockRestore();
    purchaseSpy.mockRestore();
    updateSpy.mockRestore();
    releaseSpy.mockRestore();
    await app.close();
  });

  test('should return provider-backed available numbers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/available?type=LOCAL&country=US&limit=5',
    });

    expect(response.statusCode).toBe(200);
    expect(PhoneNumberService.prototype.searchAvailable).toHaveBeenCalledWith({
      type: 'LOCAL',
      country: 'US',
      limit: 5,
    });
    expect(response.json()).toEqual({
      numbers: [
        {
          phoneNumber: '+15555550101',
          friendlyName: '(555) 555-0101',
          type: 'LOCAL',
          providerType: 'local',
          locality: null,
          region: null,
          postalCode: null,
          isoCountry: 'US',
          capabilities: {
            voice: true,
            sms: true,
            mms: false,
          },
        },
      ],
      monthlyPrice: { amount: '1.15', currency: 'USD' },
    });
  });

  test('should pass the place and digit filters of a local search through', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/available?type=LOCAL&region=tx&locality=Springfield&contains=0101&containsAt=end&limit=20',
    });

    expect(response.statusCode).toBe(200);
    expect(PhoneNumberService.prototype.searchAvailable).toHaveBeenCalledWith({
      type: 'LOCAL',
      country: 'US',
      region: 'TX',
      locality: 'Springfield',
      contains: '0101',
      containsAt: 'end',
      limit: 20,
    });
  });

  test('should refuse a place filter on a toll-free search before asking Twilio', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/available?type=TOLL_FREE&areaCode=555',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Only local numbers can be searched by place',
    });
    expect(PhoneNumberService.prototype.searchAvailable).not.toHaveBeenCalled();
  });

  test('should buy a number for the owner named in the request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/purchase',
      payload: {
        phoneNumber: '+15555550101',
        type: 'LOCAL',
        owner: { type: 'department', id: 'dept-1' },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(PhoneNumberService.prototype.purchase).toHaveBeenCalledWith(
      {
        phoneNumber: '+15555550101',
        type: 'LOCAL',
        country: 'US',
        isPrimary: false,
        owner: { type: 'department', id: 'dept-1' },
      },
      'user-1',
      expect.any(String),
    );
  });

  test('should answer a purchase whose webhooks could not be set as bought, not connected', async () => {
    purchaseSpy.mockResolvedValueOnce(purchased({ connected: false }));

    const response = await app.inject({
      method: 'POST',
      url: '/purchase',
      payload: { phoneNumber: '+15555550101', type: 'LOCAL' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: 'phone-1', connected: false });
  });

  test('should refuse an owner that is neither a user nor a department', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/purchase',
      payload: {
        phoneNumber: '+15555550101',
        type: 'LOCAL',
        owner: { type: 'team', id: 'dept-1' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(PhoneNumberService.prototype.purchase).not.toHaveBeenCalled();
  });

  test('should reject purchase requests when the target user does not exist', async () => {
    purchaseSpy.mockRejectedValueOnce(new AdminServiceError('User not found'));

    const response = await app.inject({
      method: 'POST',
      url: '/purchase',
      payload: {
        phoneNumber: '+15555550101',
        type: 'LOCAL',
        owner: { type: 'user', id: 'user-404' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'User not found',
    });
  });

  test('should tell the admin when the number was taken before the purchase', async () => {
    purchaseSpy.mockRejectedValueOnce(
      new TwilioProviderError(
        'That number is no longer available. Search again and pick another one.',
        409,
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/purchase',
      payload: { phoneNumber: '+15555550101', type: 'LOCAL' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Conflict',
      message:
        'That number is no longer available. Search again and pick another one.',
    });
  });

  test('should pass a move to the reserve through as a null owner, with the holder the admin saw', async () => {
    updateSpy.mockResolvedValueOnce(purchased({ status: 'RESERVED' }));

    const response = await app.inject({
      method: 'PATCH',
      url: '/phone-1',
      payload: {
        owner: null,
        expectedOwner: { type: 'user', id: 'user-2' },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(PhoneNumberService.prototype.update).toHaveBeenCalledWith(
      'phone-1',
      { owner: null, expectedOwner: { type: 'user', id: 'user-2' } },
      'user-1',
      expect.any(String),
    );
  });

  test('should convert service update errors into bad-request responses', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/phone-1',
      payload: {
        owner: { type: 'department', id: 'dept-1' },
        isPrimary: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Department not found',
    });
  });

  test('should answer 409 when the number changed hands meanwhile', async () => {
    updateSpy.mockRejectedValueOnce(
      new AdminServiceError(
        'This number changed hands while you were editing it. Reload it and try again.',
        409,
      ),
    );

    const response = await app.inject({
      method: 'PATCH',
      url: '/phone-1',
      payload: { owner: { type: 'user', id: 'user-2' } },
    });

    expect(response.statusCode).toBe(409);
  });

  test('should reconnect a listed number and 404 on an unknown one', async () => {
    const reconnect = vi
      .spyOn(PhoneNumberService.prototype, 'reconnect')
      .mockResolvedValueOnce(purchased())
      .mockResolvedValueOnce(null);

    const found = await app.inject({
      method: 'POST',
      url: '/phone-1/reconnect',
    });
    const missing = await app.inject({
      method: 'POST',
      url: '/missing-phone/reconnect',
    });

    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ id: 'phone-1' });
    expect(missing.statusCode).toBe(404);
    expect(reconnect).toHaveBeenCalledWith(
      'phone-1',
      'user-1',
      expect.any(String),
    );
    reconnect.mockRestore();
  });

  test('should pass a purchase that joins no messaging service through as null', async () => {
    await app.inject({
      method: 'POST',
      url: '/purchase',
      payload: {
        phoneNumber: '+15555550101',
        type: 'LOCAL',
        messagingServiceSid: null,
      },
    });

    expect(PhoneNumberService.prototype.purchase).toHaveBeenCalledWith(
      expect.objectContaining({ messagingServiceSid: null }),
      'user-1',
      expect.any(String),
    );
  });

  test('should refuse a messaging service for a toll-free purchase before asking Twilio', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/purchase',
      payload: {
        phoneNumber: '+18005550101',
        type: 'TOLL_FREE',
        messagingServiceSid: CUSTOMER_CARE_SID,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(PhoneNumberService.prototype.purchase).not.toHaveBeenCalled();
  });

  test('should list the account’s messaging services with the default', async () => {
    const messagingServices = vi
      .spyOn(PhoneNumberService.prototype, 'messagingServices')
      .mockResolvedValueOnce({ services: null, defaultSid: CUSTOMER_CARE_SID });

    const response = await app.inject({
      method: 'GET',
      url: '/messaging-services',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      services: null,
      defaultSid: CUSTOMER_CARE_SID,
    });
    messagingServices.mockRestore();
  });

  test('should set the default messaging service, and refuse an id that is not one', async () => {
    const setDefault = vi
      .spyOn(PhoneNumberService.prototype, 'setDefaultMessagingService')
      .mockResolvedValueOnce({ defaultSid: CUSTOMER_CARE_SID });

    const set = await app.inject({
      method: 'PUT',
      url: '/messaging-services/default',
      payload: { messagingServiceSid: CUSTOMER_CARE_SID },
    });
    const refused = await app.inject({
      method: 'PUT',
      url: '/messaging-services/default',
      payload: { messagingServiceSid: 'PNaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });

    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ defaultSid: CUSTOMER_CARE_SID });
    expect(setDefault).toHaveBeenCalledWith(
      CUSTOMER_CARE_SID,
      'user-1',
      expect.any(String),
    );
    expect(refused.statusCode).toBe(400);
    expect(setDefault).toHaveBeenCalledTimes(1);
    setDefault.mockRestore();
  });

  test('should put a listed number in a messaging service and 404 on an unknown one', async () => {
    const change = {
      from: null,
      to: { sid: CUSTOMER_CARE_SID, friendlyName: 'Customer Care' },
    };
    const setMessagingService = vi
      .spyOn(PhoneNumberService.prototype, 'setMessagingService')
      .mockResolvedValueOnce(change)
      .mockResolvedValueOnce(null);
    const payload = {
      messagingServiceSid: CUSTOMER_CARE_SID,
      expectedMessagingServiceSid: null,
    };

    const found = await app.inject({
      method: 'PUT',
      url: '/phone-1/messaging-service',
      payload,
    });
    const missing = await app.inject({
      method: 'PUT',
      url: '/missing-phone/messaging-service',
      payload,
    });
    const unnamed = await app.inject({
      method: 'PUT',
      url: '/phone-1/messaging-service',
      payload: { messagingServiceSid: CUSTOMER_CARE_SID },
    });

    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual(change);
    expect(setMessagingService).toHaveBeenCalledWith(
      'phone-1',
      payload,
      'user-1',
      expect.any(String),
    );
    expect(missing.statusCode).toBe(404);
    // Without the service the admin saw, a move could undo someone else's.
    expect(unnamed.statusCode).toBe(400);
    expect(setMessagingService).toHaveBeenCalledTimes(2);
    setMessagingService.mockRestore();
  });

  test('should list the numbers the account holds that are not in the list', async () => {
    const listOwned = vi
      .spyOn(PhoneNumberService.prototype, 'listOwned')
      .mockResolvedValueOnce({ numbers: [], truncated: false });

    const response = await app.inject({ method: 'GET', url: '/owned' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ numbers: [], truncated: false });
    expect(listOwned).toHaveBeenCalledTimes(1);
    listOwned.mockRestore();
  });

  test('should import a number the account holds for the owner named in the request', async () => {
    const importOwned = vi
      .spyOn(PhoneNumberService.prototype, 'importOwned')
      .mockResolvedValueOnce(purchased({ connected: false }));

    const response = await app.inject({
      method: 'POST',
      url: '/import',
      payload: {
        phoneNumber: '+15555550101',
        label: 'Front desk',
        owner: { type: 'user', id: 'user-2' },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: 'phone-1', connected: false });
    expect(importOwned).toHaveBeenCalledWith(
      {
        phoneNumber: '+15555550101',
        label: 'Front desk',
        owner: { type: 'user', id: 'user-2' },
        isPrimary: false,
      },
      'user-1',
      expect.any(String),
    );
    importOwned.mockRestore();
  });

  test('should refuse an import that names no E.164 number, and pass a conflict through', async () => {
    const importOwned = vi
      .spyOn(PhoneNumberService.prototype, 'importOwned')
      .mockRejectedValueOnce(
        new AdminServiceError('This number is already in the list.', 409),
      );

    const malformed = await app.inject({
      method: 'POST',
      url: '/import',
      payload: { phoneNumber: 'PNaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const listed = await app.inject({
      method: 'POST',
      url: '/import',
      payload: { phoneNumber: '+15555550101' },
    });

    expect(malformed.statusCode).toBe(400);
    expect(listed.statusCode).toBe(409);
    expect(importOwned).toHaveBeenCalledTimes(1);
    importOwned.mockRestore();
  });

  test('should report a listed number’s connection and 404 on an unknown one', async () => {
    const connection = vi
      .spyOn(PhoneNumberService.prototype, 'connection')
      .mockResolvedValueOnce({
        state: 'checked',
        needsReconnect: ['voice-application'],
        texting: null,
      })
      .mockResolvedValueOnce(null);

    const found = await app.inject({ url: '/phone-1/connection' });
    const missing = await app.inject({ url: '/missing-phone/connection' });

    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual({
      state: 'checked',
      needsReconnect: ['voice-application'],
      texting: null,
    });
    expect(missing.statusCode).toBe(404);
    expect(connection).toHaveBeenCalledWith('phone-1');
    connection.mockRestore();
  });

  test('should refuse to release a number somebody holds', async () => {
    releaseSpy.mockRejectedValueOnce(
      new AdminServiceError(
        'Move this number to the reserve before releasing it.',
        409,
      ),
    );

    const response = await app.inject({ method: 'DELETE', url: '/phone-1' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'Conflict',
      message: 'Move this number to the reserve before releasing it.',
    });
  });

  test('should return 404 when releasing a phone number that does not exist', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/missing-phone',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Not Found',
      message: 'Phone number not found',
    });
  });

  test('should say when Twilio had nothing to cancel', async () => {
    releaseSpy.mockResolvedValueOnce({ cancelledAtTwilio: false });

    const response = await app.inject({ method: 'DELETE', url: '/phone-1' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cancelledAtTwilio: false });
  });

  test('should return an upstream error when provider release fails', async () => {
    releaseSpy.mockRejectedValueOnce(
      new TwilioProviderError('Provider release failed'),
    );

    const response = await app.inject({
      method: 'DELETE',
      url: '/phone-1',
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({
      error: 'Bad Gateway',
      message: 'Provider release failed',
    });
  });
});

function purchased(
  overrides: Partial<PurchasedPhoneNumber> = {},
): PurchasedPhoneNumber {
  return {
    id: 'phone-1',
    phoneNumber: '+15555550101',
    friendlyName: '(555) 555-0101',
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
    status: 'ACTIVE',
    isPrimary: false,
    assignedTo: null,
    createdAt: '2026-03-20T00:00:00.000Z',
    updatedAt: '2026-03-20T00:00:00.000Z',
    connected: true,
    messagingService: { state: 'none' },
    ...overrides,
  };
}
