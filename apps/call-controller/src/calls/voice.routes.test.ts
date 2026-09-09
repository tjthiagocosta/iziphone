import { signJWT } from '@repo/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createControllerRouteApp,
  testControllerConfig,
} from '../test/route-test-helpers.js';
import type { CallState, LegMetadata } from './call-state.js';
import { voiceRoutes } from './voice.routes.js';

const activeCall: CallState = {
  conversationUuid: 'CAcall1',
  conversationName: 'call-CAcall1',
  direction: 'inbound',
  routingType: 'USER',
  from: '+15555550101',
  to: '+15555550102',
  callerLegUuid: 'CAcall1',
  agentLegUuid: 'CAleg1',
  activeAgentUserId: 'user-1',
  agentLegs: { CAleg1: 'user-1' },
  pendingAgentLegUuids: [],
  answered: true,
  voicemail: false,
  ending: false,
  createdAt: '2026-09-08T12:00:00.000Z',
};

function buildTelephony() {
  return {
    isConfigured: vi.fn(() => true),
    ensureUser: vi.fn(async () => undefined),
    generateClientJwt: vi.fn(() => 'client-jwt'),
    getLegMetadata: vi.fn<() => Promise<LegMetadata | null>>(async () => null),
    getCallState: vi.fn<() => Promise<CallState | null>>(async () => null),
    safeHangup: vi.fn(async () => undefined),
    requestConversationHangup: vi.fn<() => Promise<CallState | null>>(
      async () => null,
    ),
  };
}

describe('voiceRoutes', () => {
  let app: FastifyInstance;
  let telephony: ReturnType<typeof buildTelephony>;
  let authorization: string;

  beforeEach(async () => {
    telephony = buildTelephony();
    app = await createControllerRouteApp(voiceRoutes, {
      registerOptions: { telephony },
    });
    const token = await signJWT(
      { sub: 'user-1', email: 'agent@example.com', role: 'AGENT' },
      testControllerConfig.authSecret,
    );
    authorization = `Bearer ${token}`;
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/voice/jwt', () => {
    test('requires a bearer token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/voice/jwt',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: 'Unauthorized',
        message: 'Bearer token required',
      });
    });

    test('rejects a token signed with another secret', async () => {
      const token = await signJWT(
        { sub: 'user-1', email: 'agent@example.com', role: 'AGENT' },
        'a-different-secret-that-is-long-enough',
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/voice/jwt',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
    });

    test('issues a Twilio client token to the authenticated user', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/voice/jwt',
        headers: { authorization },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        jwt: 'client-jwt',
        identity: 'user-1',
        provider: 'twilio',
      });
      expect(telephony.ensureUser).toHaveBeenCalledWith('user-1');
      expect(telephony.generateClientJwt).toHaveBeenCalledWith('user-1');
    });

    test('answers 503 while Twilio is not configured', async () => {
      telephony.isConfigured.mockReturnValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/api/voice/jwt',
        headers: { authorization },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'Voice is not configured' });
    });
  });

  describe('POST /api/voice/calls/:legUuid/hangup', () => {
    const hangup = (legUuid: string) =>
      app.inject({
        method: 'POST',
        url: `/api/voice/calls/${legUuid}/hangup`,
        headers: { authorization },
      });

    test('answers 404 for a leg it does not know', async () => {
      const response = await hangup('CAunknown');

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Call leg not found' });
    });

    test('refuses a leg that belongs to somebody else', async () => {
      telephony.getLegMetadata.mockResolvedValue({
        conversationUuid: 'CAcall1',
        participantType: 'agent',
        participantId: 'user-2',
      });
      telephony.getCallState.mockResolvedValue({
        ...activeCall,
        activeAgentUserId: 'user-3',
      });

      const response = await hangup('CAleg2');

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: 'Forbidden' });
    });

    test('hangs a leg up directly when its call is already gone', async () => {
      telephony.getLegMetadata.mockResolvedValue({
        conversationUuid: 'CAcall1',
        participantType: 'agent',
        participantId: 'user-1',
      });

      const response = await hangup('CAleg1');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true, legUuid: 'CAleg1' });
      expect(telephony.safeHangup).toHaveBeenCalledWith('CAleg1');
    });

    test('lets the active agent end the whole call, even from the caller leg', async () => {
      telephony.getLegMetadata.mockResolvedValue({
        conversationUuid: 'CAcall1',
        participantType: 'caller',
        participantId: '+15555550101',
      });
      telephony.getCallState.mockResolvedValue(activeCall);
      telephony.requestConversationHangup.mockResolvedValue({
        ...activeCall,
        ending: true,
      });

      const response = await hangup('CAcall1');

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        legUuid: 'CAcall1',
        conversationUuid: 'CAcall1',
      });
      expect(telephony.requestConversationHangup).toHaveBeenCalledWith(
        'CAcall1',
        'user-1',
      );
      expect(telephony.safeHangup).not.toHaveBeenCalled();
    });
  });
});
