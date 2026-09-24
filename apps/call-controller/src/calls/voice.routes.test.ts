import type { OwnAvailabilityResponse, UserAvailability } from '@repo/dto';
import { signJWT } from '@repo/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createControllerRouteApp,
  testControllerConfig,
} from '../test/route-test-helpers.js';
import type { CallControlResult, OutboundGrantResult } from './call-flow.js';
import type { CallState, LegMetadata } from './call-state.js';
import { voiceRoutes } from './voice.routes.js';

const activeCall: CallState = {
  version: 3,
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
  };
}

function buildFlow() {
  return {
    grantOutboundCall: vi.fn<() => Promise<OutboundGrantResult>>(async () => ({
      ok: true,
      grant: 'a-grant-token',
      expiresInSeconds: 60,
    })),
    holdCall: vi.fn<() => Promise<CallControlResult<{ held: boolean }>>>(
      async () => ({ ok: true, conversationUuid: 'CAcall1', held: true }),
    ),
    transferCall: vi.fn<
      () => Promise<CallControlResult<{ targetUserId: string }>>
    >(async () => ({
      ok: true,
      conversationUuid: 'CAcall1',
      targetUserId: 'user-2',
    })),
    cancelTransfer: vi.fn<() => Promise<CallControlResult>>(async () => ({
      ok: true,
      conversationUuid: 'CAcall1',
    })),
    declineOfferedCall: vi.fn(async () => undefined),
    endCall: vi.fn<() => Promise<CallState | null>>(async () => null),
  };
}

const ownAvailability: OwnAvailabilityResponse = {
  availability: { userId: 'user-1', state: 'available', revision: 4 },
  doNotDisturb: false,
};

function buildAvailability() {
  return {
    availabilityOf: vi.fn(async (userIds: string[]) =>
      userIds.map(
        (userId): UserAvailability => ({
          userId,
          state: 'busy',
          revision: 2,
        }),
      ),
    ),
    ownAvailability: vi.fn(async () => ownAvailability),
    setDoNotDisturb: vi.fn(
      async (
        _userId: string,
        on: boolean,
      ): Promise<OwnAvailabilityResponse> => ({
        availability: {
          userId: 'user-1',
          state: on ? 'dnd' : 'available',
          revision: 5,
        },
        doNotDisturb: on,
      }),
    ),
  };
}

describe('voiceRoutes', () => {
  let app: FastifyInstance;
  let telephony: ReturnType<typeof buildTelephony>;
  let flow: ReturnType<typeof buildFlow>;
  let availability: ReturnType<typeof buildAvailability>;
  let authorization: string;

  beforeEach(async () => {
    telephony = buildTelephony();
    flow = buildFlow();
    availability = buildAvailability();
    app = await createControllerRouteApp(voiceRoutes, {
      registerOptions: { telephony, flow, availability },
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

  describe('POST /api/voice/outbound-grants', () => {
    const ask = (payload: unknown, headers = { authorization }) =>
      app.inject({
        method: 'POST',
        url: '/api/voice/outbound-grants',
        headers,
        payload,
      });

    test('requires a bearer token', async () => {
      const response = await ask(
        { to: '+15555550199', fromNumber: '+15555550102' },
        {} as { authorization: string },
      );

      expect(response.statusCode).toBe(401);
      expect(flow.grantOutboundCall).not.toHaveBeenCalled();
    });

    test('grants the authenticated user a call to the number, as typed, from the line', async () => {
      const response = await ask({
        to: '(555) 555-0199',
        fromNumber: '+15555550102',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        grant: 'a-grant-token',
        expiresInSeconds: 60,
      });
      // The user is the token's, whatever the body says.
      expect(flow.grantOutboundCall).toHaveBeenCalledWith({
        userId: 'user-1',
        to: '+15555550199',
        fromNumber: '+15555550102',
      });
    });

    test('is not told who is asking by the body', async () => {
      await ask({
        to: '+15555550199',
        fromNumber: '+15555550102',
        userId: 'user-2',
      });

      expect(flow.grantOutboundCall).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1' }),
      );
    });

    test.each([
      ['no line', { to: '+15555550199' }],
      [
        'a line that is not E.164',
        { to: '+15555550199', fromNumber: 'user-1' },
      ],
      ['no number', { fromNumber: '+15555550102' }],
      [
        'a number that cannot be dialed',
        { to: '12', fromNumber: '+15555550102' },
      ],
    ])('answers 400 to a request with %s', async (_name, payload) => {
      const response = await ask(payload);

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Bad Request',
        message: 'to and fromNumber must be phone numbers',
      });
      expect(flow.grantOutboundCall).not.toHaveBeenCalled();
    });

    test.each([
      ['line-not-allowed', 403, 'You are not allowed to call from that number'],
      [
        'line-unavailable',
        409,
        'The number you are calling from is not available',
      ],
      [
        'line-without-voice',
        409,
        'The number you are calling from cannot place calls',
      ],
    ] as const)(
      'answers a refusal (%s) with its status, sentence and code',
      async (refusal, status, message) => {
        flow.grantOutboundCall.mockResolvedValue({ ok: false, refusal });

        const response = await ask({
          to: '+15555550199',
          fromNumber: '+15555550102',
        });

        expect(response.statusCode).toBe(status);
        expect(response.json()).toEqual({
          error: 'Refused',
          message,
          code: refusal,
        });
      },
    );
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
      flow.endCall.mockResolvedValue({
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
      expect(flow.endCall).toHaveBeenCalledWith('CAcall1', 'user-1');
      expect(telephony.safeHangup).not.toHaveBeenCalled();
    });

    describe('around a transfer', () => {
      const transferring: CallState = {
        ...activeCall,
        agentLegs: { CAleg1: 'user-1', CAleg2: 'user-2' },
        pendingAgentLegUuids: ['CAleg2'],
        pendingTransferToUserId: 'user-2',
        transferInitiatedBy: 'user-1',
        transferOriginLegUuid: 'CAleg1',
      };

      test('releases only the agent who leaves while their transfer rings', async () => {
        telephony.getLegMetadata.mockResolvedValue({
          conversationUuid: 'CAcall1',
          participantType: 'agent',
          participantId: 'user-1',
        });
        telephony.getCallState.mockResolvedValue(transferring);

        const response = await hangup('CAleg1');

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          success: true,
          legUuid: 'CAleg1',
          conversationUuid: 'CAcall1',
        });
        expect(telephony.safeHangup).toHaveBeenCalledWith('CAleg1');
        expect(flow.endCall).not.toHaveBeenCalled();
        expect(flow.declineOfferedCall).not.toHaveBeenCalled();
      });

      test('is a decline when the teammate hangs up the leg that is ringing them', async () => {
        const token = await signJWT(
          { sub: 'user-2', email: 'teammate@example.com', role: 'AGENT' },
          testControllerConfig.authSecret,
        );
        telephony.getLegMetadata.mockResolvedValue({
          conversationUuid: 'CAcall1',
          participantType: 'agent',
          participantId: 'user-2',
        });
        telephony.getCallState.mockResolvedValue(transferring);

        const response = await app.inject({
          method: 'POST',
          url: '/api/voice/calls/CAleg2/hangup',
          headers: { authorization: `Bearer ${token}` },
        });

        expect(response.statusCode).toBe(200);
        expect(flow.declineOfferedCall).toHaveBeenCalledWith(
          'CAcall1',
          'user-2',
        );
        expect(flow.endCall).not.toHaveBeenCalled();
        expect(telephony.safeHangup).not.toHaveBeenCalled();
      });

      test('a late hangup from the agent who handed the call over does not end it for the teammate', async () => {
        telephony.getLegMetadata.mockResolvedValue({
          conversationUuid: 'CAcall1',
          participantType: 'agent',
          participantId: 'user-1',
        });
        telephony.getCallState.mockResolvedValue({
          ...activeCall,
          agentLegUuid: 'CAleg2',
          activeAgentUserId: 'user-2',
          agentLegs: { CAleg2: 'user-2' },
        });

        const response = await hangup('CAleg1');

        expect(response.statusCode).toBe(200);
        expect(telephony.safeHangup).toHaveBeenCalledWith('CAleg1');
        expect(flow.endCall).not.toHaveBeenCalled();
      });
    });
  });

  describe.each([
    ['hold', { hold: true }],
    ['transfer', { targetUserId: 'user-2' }],
    ['transfer/cancel', undefined],
  ] as const)('POST /api/voice/calls/:legUuid/%s', (action, payload) => {
    const control = (headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: `/api/voice/calls/CAleg1/${action}`,
        headers,
        payload,
      });

    test('requires a bearer token', async () => {
      const response = await control({});

      expect(response.statusCode).toBe(401);
      expect(flow.holdCall).not.toHaveBeenCalled();
      expect(flow.transferCall).not.toHaveBeenCalled();
      expect(flow.cancelTransfer).not.toHaveBeenCalled();
    });

    test('rejects a token signed with another secret', async () => {
      const token = await signJWT(
        { sub: 'user-1', email: 'agent@example.com', role: 'AGENT' },
        'a-different-secret-that-is-long-enough',
      );

      const response = await control({ authorization: `Bearer ${token}` });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: 'Unauthorized',
        message: 'Invalid token',
      });
      expect(flow.holdCall).not.toHaveBeenCalled();
      expect(flow.transferCall).not.toHaveBeenCalled();
      expect(flow.cancelTransfer).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/voice/calls/:legUuid/hold', () => {
    const hold = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/voice/calls/CAleg1/hold',
        headers: { authorization },
        payload: payload as Record<string, unknown>,
      });

    test('holds the call for the caller of the request, by their own leg', async () => {
      const response = await hold({ hold: true });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        conversationUuid: 'CAcall1',
        held: true,
      });
      expect(flow.holdCall).toHaveBeenCalledWith(
        { userId: 'user-1', legUuid: 'CAleg1' },
        true,
      );
    });

    test('answers with what happened, not with what was asked', async () => {
      flow.holdCall.mockResolvedValue({
        ok: true,
        conversationUuid: 'CAcall1',
        held: false,
      });

      const response = await hold({ hold: false });

      expect(response.json()).toMatchObject({ held: false });
      expect(flow.holdCall).toHaveBeenCalledWith(
        { userId: 'user-1', legUuid: 'CAleg1' },
        false,
      );
    });

    test.each([
      ['no body', undefined],
      ['a hold that is not a boolean', { hold: 'yes' }],
    ])('answers 400 to %s', async (_name, payload) => {
      const response = await hold(payload);

      expect(response.statusCode).toBe(400);
      expect(flow.holdCall).not.toHaveBeenCalled();
    });

    test.each([
      ['leg-not-found', 404, 'That call is not known here'],
      ['not-on-call', 403, 'Only the agent on the call can do that'],
      ['not-connected', 409, 'The call is not connected'],
      ['transfer-pending', 409, 'A transfer is already ringing for this call'],
      ['call-gone', 409, 'The call has already ended'],
      ['provider-error', 502, 'The phone provider did not accept the request'],
    ] as const)('refuses with %s as %i', async (refusal, status, message) => {
      flow.holdCall.mockResolvedValue({ ok: false, refusal });

      const response = await hold({ hold: true });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual({
        error: 'Refused',
        message,
        code: refusal,
      });
    });
  });

  describe('POST /api/voice/calls/:legUuid/transfer', () => {
    const transfer = (payload: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/voice/calls/CAleg1/transfer',
        headers: { authorization },
        payload: payload as Record<string, unknown>,
      });

    test('starts the transfer for the caller of the request, by their own leg', async () => {
      const response = await transfer({ targetUserId: 'user-2' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        conversationUuid: 'CAcall1',
        targetUserId: 'user-2',
      });
      expect(flow.transferCall).toHaveBeenCalledWith(
        { userId: 'user-1', legUuid: 'CAleg1' },
        'user-2',
      );
    });

    test.each([
      ['no body', undefined],
      ['an empty target', { targetUserId: '' }],
    ])('answers 400 to %s', async (_name, payload) => {
      const response = await transfer(payload);

      expect(response.statusCode).toBe(400);
      expect(flow.transferCall).not.toHaveBeenCalled();
    });

    test.each([
      ['leg-not-found', 404],
      ['not-on-call', 403],
      ['not-connected', 409],
      ['transfer-pending', 409],
      ['transfer-to-self', 409],
      ['target-on-call', 409],
      ['target-busy', 409],
      ['target-dnd', 409],
      ['target-offline', 409],
      ['no-transfer-pending', 409],
      ['call-gone', 409],
      ['provider-error', 502],
    ] as const)('refuses with %s as %i', async (refusal, status) => {
      flow.transferCall.mockResolvedValue({ ok: false, refusal });

      const response = await transfer({ targetUserId: 'user-2' });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        error: 'Refused',
        code: refusal,
      });
    });
  });

  describe('POST /api/voice/calls/:legUuid/transfer/cancel', () => {
    const cancel = () =>
      app.inject({
        method: 'POST',
        url: '/api/voice/calls/CAleg1/transfer/cancel',
        headers: { authorization },
      });

    test('cancels the transfer for the caller of the request', async () => {
      const response = await cancel();

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        success: true,
        conversationUuid: 'CAcall1',
      });
      expect(flow.cancelTransfer).toHaveBeenCalledWith({
        userId: 'user-1',
        legUuid: 'CAleg1',
      });
    });

    test.each([
      ['leg-not-found', 404],
      ['not-on-call', 403],
      ['no-transfer-pending', 409],
    ] as const)('refuses with %s as %i', async (refusal, status) => {
      flow.cancelTransfer.mockResolvedValue({ ok: false, refusal });

      const response = await cancel();

      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ code: refusal });
    });
  });

  describe('availability', () => {
    test('requires a bearer token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/voice/availability?userIds=user-2',
      });

      expect(response.statusCode).toBe(401);
      expect(availability.availabilityOf).not.toHaveBeenCalled();
    });

    test('reports where each teammate stands, once each', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/voice/availability?userIds=user-2,user-3,user-2',
        headers: { authorization },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        users: [
          { userId: 'user-2', state: 'busy', revision: 2 },
          { userId: 'user-3', state: 'busy', revision: 2 },
        ],
      });
      expect(availability.availabilityOf).toHaveBeenCalledWith([
        'user-2',
        'user-3',
      ]);
    });

    test.each([
      ['no list', ''],
      ['an empty list', '?userIds=,'],
      [
        'too many teammates',
        `?userIds=${Array.from({ length: 201 }, (_, index) => `user-${index}`).join(',')}`,
      ],
    ])('answers 400 to %s', async (_name, query) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/voice/availability${query}`,
        headers: { authorization },
      });

      expect(response.statusCode).toBe(400);
      expect(availability.availabilityOf).not.toHaveBeenCalled();
    });

    test('reports the asking user their own availability and do not disturb', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/voice/availability/me',
        headers: { authorization },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(ownAvailability);
      expect(availability.ownAvailability).toHaveBeenCalledWith('user-1');
    });

    test('turns do not disturb on for the asking user only', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/voice/availability/me/do-not-disturb',
        headers: { authorization },
        payload: { doNotDisturb: true, userId: 'user-2' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        availability: { userId: 'user-1', state: 'dnd', revision: 5 },
        doNotDisturb: true,
      });
      expect(availability.setDoNotDisturb).toHaveBeenCalledExactlyOnceWith(
        'user-1',
        true,
      );
    });

    test('answers 400 to a do not disturb that is not a boolean', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/voice/availability/me/do-not-disturb',
        headers: { authorization },
        payload: { doNotDisturb: 'yes' },
      });

      expect(response.statusCode).toBe(400);
      expect(availability.setDoNotDisturb).not.toHaveBeenCalled();
    });
  });
});
