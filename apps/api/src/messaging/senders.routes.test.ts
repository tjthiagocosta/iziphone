import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../test/route-test-helpers.js';
import { MessageSenderService } from './sender.service.js';
import { messageSenderRoutes } from './senders.routes.js';

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
});
