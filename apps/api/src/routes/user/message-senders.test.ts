import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MessageSenderService } from '../../services/messaging/message-sender.service.js';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../../test/route-test-helpers.js';
import userRoutes from './index.js';
import messageSenderRoutes from './message-senders.js';

describe('messageSenderRoutes', () => {
  let app: FastifyInstance;
  let listAllowedSendersSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    listAllowedSendersSpy = vi
      .spyOn(MessageSenderService.prototype, 'listAllowedSenders')
      .mockResolvedValue([
        {
          id: 'phone-1',
          phoneNumber: '+15555550100',
          label: 'Support',
          ownerType: 'department',
          ownerId: 'dept-1',
          ownerName: 'Support',
          isPrimary: true,
          smsEnabled: true,
          mmsEnabled: false,
        },
      ]);

    app = await createApiRouteApp(withAuthenticatedUser(messageSenderRoutes), {
      db: {
        phoneNumber: {},
      },
    });
  });

  afterEach(async () => {
    listAllowedSendersSpy.mockRestore();
    await app.close();
  });

  test('should return messaging-capable sender numbers for the authenticated user', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
    });

    expect(response.statusCode).toBe(200);
    expect(listAllowedSendersSpy).toHaveBeenCalledWith('user-1');
    expect(response.json()).toEqual({
      senders: [
        {
          id: 'phone-1',
          phoneNumber: '+15555550100',
          label: 'Support',
          ownerType: 'department',
          ownerId: 'dept-1',
          ownerName: 'Support',
          isPrimary: true,
          smsEnabled: true,
          mmsEnabled: false,
        },
      ],
    });
  });

  test('should reject requests without an authenticated user', async () => {
    await app.close();
    app = await createApiRouteApp(userRoutes, {
      user: null,
      db: {
        phoneNumber: {},
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/message-senders',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Authentication required',
    });
  });
});
