import type { OutboundCallLine } from '@repo/dto';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createApiRouteApp,
  withAuthenticatedUser,
} from '../test/route-test-helpers.js';
import { CallLineService } from './call-line.service.js';
import { callLineRoutes } from './call-lines.routes.js';

const supportLine: OutboundCallLine = {
  id: 'phone-1',
  phoneNumber: '+15555550100',
  label: 'Support',
  ownerType: 'department',
  ownerId: 'dept-1',
  ownerName: 'Support',
  isPrimary: true,
};

describe('callLineRoutes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createApiRouteApp(withAuthenticatedUser(callLineRoutes), {
      db: { phoneNumber: {} },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  test('should return the lines the signed-in user may call from', async () => {
    const listOutboundLines = vi
      .spyOn(CallLineService.prototype, 'listOutboundLines')
      .mockResolvedValue([supportLine]);

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(listOutboundLines).toHaveBeenCalledWith('user-1');
    expect(response.json()).toEqual({ lines: [supportLine] });
  });

  test('should answer an empty list for a user without any line', async () => {
    vi.spyOn(CallLineService.prototype, 'listOutboundLines').mockResolvedValue(
      [],
    );

    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ lines: [] });
  });
});
