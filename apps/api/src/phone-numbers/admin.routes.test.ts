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
      });
    purchaseSpy = vi
      .spyOn(PhoneNumberService.prototype, 'purchase')
      .mockResolvedValue({
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
      });
    updateSpy = vi
      .spyOn(PhoneNumberService.prototype, 'update')
      .mockImplementation(async () => {
        throw new AdminServiceError('Department not found');
      });
    releaseSpy = vi
      .spyOn(PhoneNumberService.prototype, 'release')
      .mockResolvedValue(false);

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
    });
  });

  test('should reject purchase requests that assign the number to both a user and a department', async () => {
    purchaseSpy.mockRejectedValueOnce(
      new AdminServiceError(
        'Cannot assign phone number to both user and department',
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/purchase',
      payload: {
        phoneNumber: '+15555550101',
        type: 'LOCAL',
        userId: 'user-1',
        departmentId: 'dept-1',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Cannot assign phone number to both user and department',
    });
  });

  test('should reject purchase requests when the target user does not exist', async () => {
    purchaseSpy.mockRejectedValueOnce(new AdminServiceError('User not found'));

    const response = await app.inject({
      method: 'POST',
      url: '/purchase',
      payload: {
        phoneNumber: '+15555550101',
        type: 'LOCAL',
        userId: 'user-404',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'User not found',
    });
  });

  test('should convert service update errors into bad-request responses', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/phone-1',
      payload: {
        departmentId: 'dept-1',
        isPrimary: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Bad Request',
      message: 'Department not found',
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
