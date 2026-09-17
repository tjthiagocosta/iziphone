import type { CachedRouting, CachedRoutingSettings } from '@repo/events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import { createFakeTelephony } from '../test/fake-telephony.js';
import { testControllerConfig } from '../test/route-test-helpers.js';
import type { CallEventPublisher } from './call-events.js';
import { CallFlow } from './call-flow.js';

const caller = '+15555550101';
const businessNumber = '+15555550102';
const customerNumber = '+15555550199';

const settings: CachedRoutingSettings = {
  timezone: 'UTC',
  is24Hours: true,
  openHoursRoutingType: 'SIMULTANEOUS',
  ringDuration: 20,
  closedHoursRoutingType: 'VOICEMAIL',
  closedHoursExternalNumber: null,
  voicemailGreetingUrl: null,
  businessHours: [],
  holidays: [],
};

const department: CachedRouting = {
  type: 'DEPARTMENT',
  departmentId: 'dept-1',
  departmentName: 'Support',
  userIds: ['user-1', 'user-2'],
  orderedUsers: [
    { userId: 'user-1', order: 0 },
    { userId: 'user-2', order: 1 },
  ],
  settings,
  cachedAt: '2026-09-08T12:00:00.000Z',
};

function buildFlow(
  options: { routing?: CachedRouting | null; online?: string[] } = {},
) {
  const fake = createFakeTelephony();
  const online = new Set(options.online ?? ['user-1', 'user-2']);
  const events = {
    callIncoming: vi.fn(async () => undefined),
    callStarted: vi.fn(async () => undefined),
    callEnded: vi.fn(async () => undefined),
    callMissed: vi.fn(async () => undefined),
    callTransferred: vi.fn(async () => undefined),
    callHeld: vi.fn(async () => undefined),
    callResumed: vi.fn(async () => undefined),
    callParticipantStatus: vi.fn(async () => undefined),
    callRecordingReady: vi.fn(async () => undefined),
    callTranscriptionReady: vi.fn(async () => undefined),
  } satisfies CallEventPublisher;
  const realtime = {
    notifyIncomingCall: vi.fn(async (userIds: string[]) =>
      userIds.filter((userId) => online.has(userId)),
    ),
    trackCallParticipants: vi.fn(async () => undefined),
    notifyTransferOutcome: vi.fn(async () => undefined),
  };
  const routing = {
    lookupByPhone: vi.fn(async () =>
      options.routing === undefined ? department : options.routing,
    ),
  };
  const flow = new CallFlow({
    telephony: fake.telephony,
    routing,
    events,
    realtime,
    log: createFakeLogger(),
  });

  return { flow, events, realtime, routing, online, ...fake };
}

/** Let background work started by a webhook handler settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An inbound call that user-1 answered on CAleg1; the caller is CAcall1. */
async function answeredCall() {
  const context = buildFlow({ online: ['user-1'] });
  await context.flow.acceptInboundCall({
    callSid: 'CAcall1',
    from: caller,
    to: businessNumber,
  });
  await context.flow.handleConferenceEvent({
    conversationUuid: 'CAcall1',
    conferenceSid: 'CFconference1',
    event: 'participant-join',
    legUuid: 'CAleg1',
    participantLabel: 'agent|user-1|nonce',
  });
  return context;
}

/** A call user-1 placed from CAagent1 that the number answered on CAleg1. */
async function answeredOutboundCall() {
  const context = buildFlow({ online: ['user-1', 'user-2'] });
  await context.flow.startOutboundCall({
    callSid: 'CAagent1',
    agentUserId: 'user-1',
    targetNumber: customerNumber,
  });
  await settle();
  await context.flow.handleConferenceEvent({
    conversationUuid: 'CAagent1',
    conferenceSid: 'CFconference1',
    event: 'participant-join',
    legUuid: 'CAleg1',
    participantLabel: 'external|%2B15555550199|nonce',
  });
  return context;
}

const agent = { userId: 'user-1', legUuid: 'CAleg1' };

/** The answered call, with user-2 online and a transfer to them ringing on CAleg2. */
async function transferringCall() {
  const context = await answeredCall();
  context.online.add('user-2');
  await expect(context.flow.transferCall(agent, 'user-2')).resolves.toEqual({
    ok: true,
    conversationUuid: 'CAcall1',
    targetUserId: 'user-2',
  });
  return context;
}

describe('CallFlow', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 })),
    );
  });

  describe('inbound calls', () => {
    test('a number without routing goes straight to voicemail', async () => {
      const { flow, events, telephony } = buildFlow({ routing: null });

      const twiml = await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });

      expect(twiml).toContain('This number is not configured');
      expect(events.callIncoming).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        from: caller,
        to: businessNumber,
        direction: 'inbound',
        callerLegUuid: 'CAcall1',
      });
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        voicemail: true,
        callerLegUuid: 'CAcall1',
      });
      await expect(telephony.getLegMetadata('CAcall1')).resolves.toEqual({
        conversationUuid: 'CAcall1',
        participantType: 'caller',
        participantId: caller,
      });
    });

    test('rings every online agent of the department and parks the caller in the conference', async () => {
      const { flow, events, realtime, twilio, telephony } = buildFlow();

      const twiml = await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });

      expect(twiml).toContain('<Conference');
      expect(realtime.notifyIncomingCall).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        expect.objectContaining({
          conversationUuid: 'CAcall1',
          from: caller,
          routingType: 'DEPARTMENT',
          departmentName: 'Support',
        }),
      );
      expect(twilio.created.map((leg) => leg.to)).toEqual([
        expect.stringMatching(/^client:user-1\?/),
        expect.stringMatching(/^client:user-2\?/),
      ]);
      expect(events.callIncoming).toHaveBeenCalledWith(
        expect.objectContaining({ departmentId: 'dept-1' }),
      );
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        ringStrategy: 'SIMULTANEOUS',
        ringDuration: 20,
        departmentName: 'Support',
      });
    });

    test('goes to voicemail and reports a missed call when nobody is online', async () => {
      const { flow, events, twilio } = buildFlow({ online: [] });

      const twiml = await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });

      expect(twiml).toContain('Nobody is available');
      expect(twilio.created).toHaveLength(0);
      expect(events.callMissed).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        from: caller,
        to: businessNumber,
        departmentId: 'dept-1',
        userId: undefined,
      });
    });

    test('a fixed-order department rings the first online user only', async () => {
      const { flow, twilio, telephony } = buildFlow({
        routing: {
          ...department,
          settings: { ...settings, openHoursRoutingType: 'FIXED_ORDER' },
        },
        online: ['user-2'],
      });

      await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });

      expect(twilio.created.map((leg) => leg.to)).toEqual([
        expect.stringMatching(/^client:user-2\?/),
      ]);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        routingQueue: ['user-1', 'user-2'],
        currentQueueIndex: 1,
      });
    });

    test('a closed department forwards to its external number', async () => {
      const { flow, twilio } = buildFlow({
        routing: {
          ...department,
          settings: {
            ...settings,
            is24Hours: false,
            closedHoursRoutingType: 'EXTERNAL_NUMBER',
            closedHoursExternalNumber: '+15555550199',
          },
        },
      });

      const twiml = await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });
      await settle();

      expect(twiml).toContain('<Conference');
      expect(twilio.created).toEqual([
        expect.objectContaining({
          to: '+15555550199',
          from: businessNumber,
          timeout: 20,
        }),
      ]);
    });

    test('sends the caller to voicemail when the forward cannot be dialed', async () => {
      const { flow, twilio, events } = buildFlow({
        routing: {
          ...department,
          settings: {
            ...settings,
            is24Hours: false,
            closedHoursRoutingType: 'EXTERNAL_NUMBER',
            closedHoursExternalNumber: '+15555550199',
          },
        },
      });
      twilio.failWith('+15555550199', new Error('Twilio rejected the dial'));

      await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });
      await settle();

      expect(twilio.redirects()).toEqual([
        expect.objectContaining({ legUuid: 'CAcall1' }),
      ]);
      expect(events.callMissed).toHaveBeenCalled();
    });
  });

  describe('while ringing', () => {
    async function ringingCall(options: Parameters<typeof buildFlow>[0] = {}) {
      const context = buildFlow(options);
      await context.flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });
      return context;
    }

    test('the first agent to join wins and the others stop ringing', async () => {
      const { flow, events, twilio, telephony } = await ringingCall();

      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        conferenceSid: 'CFconference1',
        event: 'participant-join',
        legUuid: 'CAleg2',
        participantLabel: 'agent|user-2|nonce',
      });

      expect(events.callStarted).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        from: caller,
        to: businessNumber,
        userId: 'user-2',
        departmentId: 'dept-1',
        direction: 'inbound',
        agentLegUuid: 'CAleg2',
        externalLegUuid: undefined,
      });
      expect(twilio.hangups()).toEqual(['CAleg1']);
      expect(events.callParticipantStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          legUuid: 'CAleg2',
          status: 'answered',
          eventType: 'DIAL_ANSWERED',
        }),
      );
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        answered: true,
        activeAgentUserId: 'user-2',
        agentLegUuid: 'CAleg2',
        conferenceSid: 'CFconference1',
      });
    });

    test('the caller goes to voicemail once every agent leg has timed out', async () => {
      const { flow, events, twilio } = await ringingCall();

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'no-answer',
      });
      expect(twilio.redirects()).toHaveLength(0);

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg2',
        status: 'no-answer',
      });

      expect(twilio.redirects()).toEqual([
        expect.objectContaining({
          legUuid: 'CAcall1',
          params: { twiml: expect.stringContaining('<Record') },
        }),
      ]);
      expect(events.callMissed).toHaveBeenCalledTimes(1);
      expect(events.callParticipantStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          legUuid: 'CAleg1',
          status: 'no-answer',
          eventType: 'DIAL_NO_ANSWER',
        }),
      );
    });

    test('a fixed-order department moves on to the next user when one does not answer', async () => {
      const { flow, twilio, telephony } = await ringingCall({
        routing: {
          ...department,
          settings: { ...settings, openHoursRoutingType: 'FIXED_ORDER' },
        },
      });
      expect(twilio.created).toHaveLength(1);

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'no-answer',
      });

      expect(twilio.created.map((leg) => leg.to)).toEqual([
        expect.stringMatching(/^client:user-1\?/),
        expect.stringMatching(/^client:user-2\?/),
      ]);
      expect(twilio.redirects()).toHaveLength(0);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        currentQueueIndex: 1,
      });
    });

    test('handles the end of a leg once, although Twilio reports it twice', async () => {
      const { flow, events, twilio, telephony } = await ringingCall({
        routing: {
          ...department,
          settings: { ...settings, openHoursRoutingType: 'FIXED_ORDER' },
        },
      });

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'no-answer',
      });
      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-leave',
        legUuid: 'CAleg1',
        participantLabel: 'agent|user-1|nonce',
      });

      expect(twilio.created).toHaveLength(2);
      expect(twilio.redirects()).toHaveLength(0);
      expect(events.callParticipantStatus).toHaveBeenCalledTimes(1);
      await expect(telephony.getLegMetadata('CAleg1')).resolves.toBeNull();
    });

    test('a rejected call hangs everyone up and ends once the legs are gone', async () => {
      const { flow, events, telephony, twilio } = await ringingCall();

      await telephony.requestConversationHangup('CAcall1', 'user-1');
      expect(twilio.hangups().sort()).toEqual(['CAcall1', 'CAleg1', 'CAleg2']);

      for (const legUuid of ['CAleg1', 'CAleg2']) {
        await flow.handleCallStatus({
          conversationUuid: 'CAcall1',
          legUuid,
          status: 'canceled',
        });
      }
      expect(events.callEnded).not.toHaveBeenCalled();

      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-leave',
        legUuid: 'CAcall1',
        participantLabel: 'caller|%2B15555550101|nonce',
      });

      expect(events.callEnded).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationUuid: 'CAcall1',
          status: 'completed',
        }),
      );
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
      await expect(telephony.getLegMetadata('CAleg1')).resolves.toBeNull();
    });
  });

  describe('voicemail', () => {
    async function callInVoicemail() {
      const context = buildFlow({ online: ['user-1'] });
      await context.flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });
      await context.flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'no-answer',
      });
      expect(context.twilio.redirects()).toHaveLength(1);
      // Twilio pulls the caller out of the conference to play the greeting.
      await context.flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-leave',
        legUuid: 'CAcall1',
        participantLabel: 'caller|%2B15555550101|nonce',
        duration: 20,
      });
      return context;
    }

    test('keeps the caller connected while the voicemail records', async () => {
      const { events, twilio, telephony } = await callInVoicemail();

      expect(twilio.hangups()).toEqual([]);
      expect(events.callEnded).not.toHaveBeenCalled();
      expect(events.callParticipantStatus).not.toHaveBeenCalledWith(
        expect.objectContaining({ legUuid: 'CAcall1', status: 'completed' }),
      );
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        voicemail: true,
        callerLegUuid: 'CAcall1',
      });
    });

    test('does not send the caller to voicemail twice', async () => {
      const { flow, twilio } = await callInVoicemail();

      // A late timeout for a leg that was already hung up.
      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'no-answer',
      });

      expect(twilio.redirects()).toHaveLength(1);
    });

    test('ends the call when the recording is ready', async () => {
      const { flow, events, telephony } = await callInVoicemail();

      await flow.handleRecordingReady({
        conversationUuid: 'CAcall1',
        recordingUrl: 'https://api.twilio.example.com/recordings/RE1',
        duration: 12,
        context: 'routing-timeout',
      });

      expect(events.callRecordingReady).toHaveBeenCalledTimes(1);
      expect(events.callEnded).toHaveBeenCalledTimes(1);
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
    });

    test('ends the call when the caller hangs up before leaving a message', async () => {
      const { flow, events, telephony } = await callInVoicemail();

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAcall1',
        status: 'completed',
        duration: 25,
      });

      expect(events.callEnded).toHaveBeenCalledWith(
        expect.objectContaining({ conversationUuid: 'CAcall1', duration: 25 }),
      );
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
      await expect(telephony.getLegMetadata('CAcall1')).resolves.toBeNull();
    });
  });

  describe('answered calls', () => {
    test('ends when the caller hangs up', async () => {
      const { flow, events, twilio, telephony } = await answeredCall();

      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-leave',
        legUuid: 'CAcall1',
        participantLabel: 'caller|%2B15555550101|nonce',
        duration: 90,
      });

      expect(twilio.hangups()).toEqual(['CAleg1']);
      expect(events.callEnded).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        duration: 90,
        status: 'completed',
        callerLegUuid: 'CAcall1',
        agentLegUuid: 'CAleg1',
        externalLegUuid: undefined,
      });
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
    });

    test('ends when the active agent drops off', async () => {
      const { flow, events, twilio } = await answeredCall();

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'completed',
        duration: 45,
      });

      expect(twilio.hangups()).toContain('CAcall1');
      expect(events.callEnded).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', duration: 45 }),
      );
    });

    test('releases an agent who picks up after somebody else already has the call', async () => {
      const { flow, events, twilio, telephony } = buildFlow();
      await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });
      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-join',
        legUuid: 'CAleg1',
        participantLabel: 'agent|user-1|nonce',
      });
      expect(twilio.hangups()).toEqual(['CAleg2']);

      // user-2 answered in the moment before their ring was cancelled.
      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-join',
        legUuid: 'CAleg2',
        participantLabel: 'agent|user-2|nonce',
      });

      expect(twilio.hangups()).toEqual(['CAleg2', 'CAleg2']);
      expect(events.callStarted).toHaveBeenCalledTimes(1);
      expect(events.callTransferred).not.toHaveBeenCalled();
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        activeAgentUserId: 'user-1',
        agentLegUuid: 'CAleg1',
      });
    });
  });

  describe('declining an offered call', () => {
    test('ends a call nobody has answered yet, as a rejection always has', async () => {
      const { flow, twilio, telephony } = buildFlow();
      await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });

      await flow.declineOfferedCall('CAcall1', 'user-2');

      expect(twilio.hangups().sort()).toEqual(['CAcall1', 'CAleg1', 'CAleg2']);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        ending: true,
        endingRequestedBy: 'user-2',
      });
    });

    test('does nothing to a call somebody else is already talking on', async () => {
      const { flow, twilio, telephony } = await answeredCall();

      await flow.declineOfferedCall('CAcall1', 'user-2');

      expect(twilio.hangups()).toEqual([]);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        ending: false,
        activeAgentUserId: 'user-1',
      });
    });

    test('ignores a call it does not know', async () => {
      const { flow, twilio } = buildFlow();

      await flow.declineOfferedCall('CAunknown', 'user-2');

      expect(twilio.hangups()).toEqual([]);
    });
  });

  describe('holding a call', () => {
    test('holds the other party with hold audio and records it', async () => {
      const { flow, events, twilio, telephony } = await answeredCall();

      await expect(flow.holdCall(agent, true)).resolves.toEqual({
        ok: true,
        conversationUuid: 'CAcall1',
        held: true,
      });

      expect(twilio.participantUpdates).toEqual([
        {
          conferenceSid: 'CFconference1',
          legUuid: 'CAcall1',
          params: {
            hold: true,
            holdUrl: testControllerConfig.twilio?.holdAudioUrl,
            holdMethod: 'GET',
          },
        },
      ]);
      expect(events.callHeld).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        userId: 'user-1',
        legUuid: 'CAcall1',
      });
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        held: true,
      });
    });

    test('brings the other party back and records that too', async () => {
      const { flow, events, twilio, telephony } = await answeredCall();
      await flow.holdCall(agent, true);

      await expect(flow.holdCall(agent, false)).resolves.toEqual({
        ok: true,
        conversationUuid: 'CAcall1',
        held: false,
      });

      expect(twilio.holds()).toEqual([true, false]);
      expect(twilio.participantUpdates.at(-1)?.params).toEqual({
        hold: false,
        holdUrl: undefined,
        holdMethod: undefined,
      });
      expect(events.callResumed).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        userId: 'user-1',
        legUuid: 'CAcall1',
      });
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        held: false,
      });
    });

    test('a second press asks Twilio again but is recorded once', async () => {
      const { flow, events, twilio } = await answeredCall();

      await flow.holdCall(agent, true);
      await expect(flow.holdCall(agent, true)).resolves.toEqual({
        ok: true,
        conversationUuid: 'CAcall1',
        held: true,
      });

      expect(twilio.holds()).toEqual([true, true]);
      expect(events.callHeld).toHaveBeenCalledTimes(1);
    });

    test('two presses at the same moment both succeed and leave the call held', async () => {
      const { flow, twilio, telephony } = await answeredCall();

      const results = await Promise.all([
        flow.holdCall(agent, true),
        flow.holdCall(agent, true),
      ]);

      expect(results).toEqual([
        { ok: true, conversationUuid: 'CAcall1', held: true },
        { ok: true, conversationUuid: 'CAcall1', held: true },
      ]);
      expect(twilio.holds()).toEqual([true, true]);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        held: true,
      });
    });

    test('resuming a call that is not held changes nothing', async () => {
      const { flow, events } = await answeredCall();

      await expect(flow.holdCall(agent, false)).resolves.toMatchObject({
        ok: true,
        held: false,
      });

      expect(events.callResumed).not.toHaveBeenCalled();
    });

    test('holds the number that was dialed on an outbound call', async () => {
      const { flow, events, twilio } = await answeredOutboundCall();

      await expect(
        flow.holdCall({ userId: 'user-1', legUuid: 'CAagent1' }, true),
      ).resolves.toMatchObject({ ok: true, held: true });

      expect(twilio.participantUpdates).toEqual([
        expect.objectContaining({ legUuid: 'CAleg1' }),
      ]);
      expect(events.callHeld).toHaveBeenCalledWith({
        conversationUuid: 'CAagent1',
        userId: 'user-1',
        legUuid: 'CAleg1',
      });
    });

    test('says so when Twilio refuses, and records nothing', async () => {
      const { flow, events, twilio, telephony } = await answeredCall();
      twilio.failHoldWith(new Error('Twilio is unavailable'));

      await expect(flow.holdCall(agent, true)).resolves.toEqual({
        ok: false,
        refusal: 'provider-error',
      });

      expect(events.callHeld).not.toHaveBeenCalled();
      const state = await telephony.getCallState('CAcall1');
      expect(state?.held).toBeUndefined();
    });

    test('answers what Twilio did even when it cannot be recorded', async () => {
      const { flow, events, twilio } = await answeredCall();
      events.callHeld.mockRejectedValueOnce(new Error('Redis is unavailable'));

      await expect(flow.holdCall(agent, true)).resolves.toEqual({
        ok: true,
        conversationUuid: 'CAcall1',
        held: true,
      });
      expect(twilio.holds()).toEqual([true]);
    });

    test('says the call is gone when the other party already left the conference', async () => {
      const { flow, twilio } = await answeredCall();
      twilio.failHoldWith(
        Object.assign(new Error('Participant not found'), { status: 404 }),
      );

      await expect(flow.holdCall(agent, true)).resolves.toEqual({
        ok: false,
        refusal: 'call-gone',
      });
    });

    test.each([
      [
        'a leg nobody knows',
        { userId: 'user-1', legUuid: 'CAunknown' },
        'leg-not-found',
      ],
      [
        'somebody who is not on the call',
        { userId: 'user-2', legUuid: 'CAleg1' },
        'not-on-call',
      ],
      [
        'the caller leg',
        { userId: 'user-1', legUuid: 'CAcall1' },
        'not-on-call',
      ],
    ] as const)('refuses %s', async (_name, request, refusal) => {
      const { flow, twilio } = await answeredCall();

      await expect(flow.holdCall(request, true)).resolves.toEqual({
        ok: false,
        refusal,
      });
      expect(twilio.holds()).toEqual([]);
    });

    test('refuses while the number dialed has not answered yet', async () => {
      const { flow, twilio } = buildFlow();
      await flow.startOutboundCall({
        callSid: 'CAagent1',
        agentUserId: 'user-1',
        targetNumber: customerNumber,
      });
      await settle();

      await expect(
        flow.holdCall({ userId: 'user-1', legUuid: 'CAagent1' }, true),
      ).resolves.toEqual({ ok: false, refusal: 'not-connected' });
      expect(twilio.holds()).toEqual([]);
    });

    test('a held call ends as any other when the held party hangs up', async () => {
      const { flow, events, twilio, telephony } = await answeredCall();
      await flow.holdCall(agent, true);

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAcall1',
        status: 'completed',
        duration: 40,
      });

      expect(twilio.hangups()).toEqual(['CAleg1']);
      expect(events.callEnded).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', duration: 40 }),
      );
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
    });

    test('a held call ends as any other when the agent hangs up', async () => {
      const { flow, events, twilio } = await answeredCall();
      await flow.holdCall(agent, true);

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'completed',
      });

      expect(twilio.hangups()).toEqual(['CAcall1']);
      expect(events.callEnded).toHaveBeenCalledTimes(1);
    });
  });

  describe('transferring a call', () => {
    const teammate = { userId: 'user-2', legUuid: 'CAleg2' };
    const teammateJoins = {
      conversationUuid: 'CAcall1',
      event: 'participant-join',
      legUuid: 'CAleg2',
      participantLabel: 'agent|user-2|nonce',
    } as const;

    test('holds the other party and rings the teammate, who sees the caller and who is transferring', async () => {
      const { events, realtime, twilio, telephony } = await transferringCall();

      expect(realtime.notifyIncomingCall).toHaveBeenLastCalledWith(['user-2'], {
        conversationUuid: 'CAcall1',
        from: caller,
        to: businessNumber,
        callerId: caller,
        routingType: 'DEPARTMENT',
        departmentId: 'dept-1',
        departmentName: 'Support',
        transferredBy: { userId: 'user-1' },
        metadata: { provider: 'twilio' },
      });
      expect(twilio.holds()).toEqual([true]);
      expect(events.callHeld).toHaveBeenCalledTimes(1);
      expect(twilio.created.at(-1)).toMatchObject({
        to: expect.stringMatching(/^client:user-2\?/),
        from: businessNumber,
        timeout: 20,
      });
      expect(realtime.notifyTransferOutcome).not.toHaveBeenCalled();
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        held: true,
        activeAgentUserId: 'user-1',
        pendingTransferToUserId: 'user-2',
        transferInitiatedBy: 'user-1',
        transferOriginLegUuid: 'CAleg1',
        agentLegs: { CAleg1: 'user-1', CAleg2: 'user-2' },
      });
    });

    test('hands the call over when the teammate answers, and tells the agent before releasing them', async () => {
      const { flow, events, realtime, twilio, telephony } =
        await transferringCall();
      let hangupsWhenTold: string[] | undefined;
      realtime.notifyTransferOutcome.mockImplementation(async () => {
        hangupsWhenTold = [...twilio.hangups()];
      });

      await flow.handleConferenceEvent(teammateJoins);

      expect(twilio.holds()).toEqual([true, false]);
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledWith(['user-1'], {
        conversationUuid: 'CAcall1',
        targetUserId: 'user-2',
        status: 'completed',
      });
      expect(hangupsWhenTold).toEqual([]);
      expect(twilio.hangups()).toEqual(['CAleg1']);
      expect(events.callResumed).toHaveBeenCalledTimes(1);
      expect(events.callTransferred).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        fromUserId: 'user-1',
        toUserId: 'user-2',
        agentLegUuid: 'CAleg2',
      });

      // The released leg ends a moment later; the call is not its to end.
      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'completed',
      });

      expect(events.callEnded).not.toHaveBeenCalled();
      await expect(telephony.getLegMetadata('CAleg1')).resolves.toBeNull();
      const state = await telephony.getCallState('CAcall1');
      expect(state).toMatchObject({
        held: false,
        activeAgentUserId: 'user-2',
        agentLegUuid: 'CAleg2',
        agentLegs: { CAleg2: 'user-2' },
      });
      expect(state?.pendingTransferToUserId).toBeUndefined();
      expect(state?.transferInitiatedBy).toBeUndefined();
    });

    test('the call is the teammate’s to control afterwards, not the agent’s', async () => {
      const { flow } = await transferringCall();
      await flow.handleConferenceEvent(teammateJoins);

      await expect(flow.holdCall(agent, true)).resolves.toEqual({
        ok: false,
        refusal: 'not-on-call',
      });
      await expect(flow.holdCall(teammate, true)).resolves.toMatchObject({
        ok: true,
        held: true,
      });
      // The agent's released leg is no longer the call's, so the call can be
      // handed straight back to them.
      await expect(flow.transferCall(teammate, 'user-1')).resolves.toEqual({
        ok: true,
        conversationUuid: 'CAcall1',
        targetUserId: 'user-1',
      });
    });

    test('completes once although Twilio reports the join twice', async () => {
      const { flow, events, realtime, twilio } = await transferringCall();

      await flow.handleConferenceEvent(teammateJoins);
      await flow.handleConferenceEvent(teammateJoins);

      expect(events.callTransferred).toHaveBeenCalledTimes(1);
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledTimes(1);
      expect(twilio.hangups()).toEqual(['CAleg1']);
    });

    test('a decline brings the other party back to the agent and tells both why', async () => {
      const { flow, events, realtime, twilio, telephony } =
        await transferringCall();

      await flow.declineOfferedCall('CAcall1', 'user-2');

      expect(twilio.hangups()).toEqual(['CAleg2']);
      expect(twilio.holds()).toEqual([true, false]);
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        {
          conversationUuid: 'CAcall1',
          targetUserId: 'user-2',
          status: 'failed',
          reason: 'declined',
        },
      );

      // Twilio then reports the leg that was hung up.
      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg2',
        status: 'canceled',
      });

      expect(realtime.notifyTransferOutcome).toHaveBeenCalledTimes(1);
      expect(events.callResumed).toHaveBeenCalledTimes(1);
      expect(events.callEnded).not.toHaveBeenCalled();
      expect(events.callTransferred).not.toHaveBeenCalled();
      const state = await telephony.getCallState('CAcall1');
      expect(state).toMatchObject({
        held: false,
        activeAgentUserId: 'user-1',
        agentLegUuid: 'CAleg1',
        agentLegs: { CAleg1: 'user-1' },
      });
      expect(state?.pendingTransferToUserId).toBeUndefined();
    });

    test.each([
      ['no-answer', 'no-answer'],
      ['busy', 'declined'],
      ['failed', 'unavailable'],
    ] as const)(
      'a teammate leg that ends with %s fails the transfer as %s',
      async (status, reason) => {
        const { flow, events, realtime, twilio, telephony } =
          await transferringCall();

        await flow.handleCallStatus({
          conversationUuid: 'CAcall1',
          legUuid: 'CAleg2',
          status,
        });

        expect(twilio.holds()).toEqual([true, false]);
        expect(realtime.notifyTransferOutcome).toHaveBeenCalledWith(
          ['user-1', 'user-2'],
          expect.objectContaining({ status: 'failed', reason }),
        );
        expect(events.callEnded).not.toHaveBeenCalled();
        const state = await telephony.getCallState('CAcall1');
        expect(state).toMatchObject({ held: false, agentLegUuid: 'CAleg1' });
        expect(state?.pendingTransferToUserId).toBeUndefined();
      },
    );

    test('settles once although Twilio reports the unanswered leg twice', async () => {
      const { flow, realtime, twilio } = await transferringCall();

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg2',
        status: 'no-answer',
      });
      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-leave',
        legUuid: 'CAleg2',
        participantLabel: 'agent|user-2|nonce',
      });

      expect(realtime.notifyTransferOutcome).toHaveBeenCalledTimes(1);
      expect(twilio.holds()).toEqual([true, false]);
    });

    test('refuses a teammate who is not online, without holding anybody', async () => {
      const { flow, events, realtime, twilio, telephony } =
        await answeredCall();

      await expect(flow.transferCall(agent, 'user-2')).resolves.toEqual({
        ok: false,
        refusal: 'target-offline',
      });

      expect(twilio.holds()).toEqual([]);
      expect(twilio.created).toHaveLength(1);
      expect(events.callHeld).not.toHaveBeenCalled();
      expect(realtime.notifyTransferOutcome).not.toHaveBeenCalled();
      const state = await telephony.getCallState('CAcall1');
      expect(state?.pendingTransferToUserId).toBeUndefined();
      expect(state?.transferInitiatedBy).toBeUndefined();
      expect(state?.transferOriginLegUuid).toBeUndefined();
    });

    test('the agent can cancel, and a teammate who picks up too late is released', async () => {
      const { flow, events, realtime, twilio, telephony } =
        await transferringCall();

      await expect(flow.cancelTransfer(agent)).resolves.toEqual({
        ok: true,
        conversationUuid: 'CAcall1',
      });

      expect(twilio.hangups()).toEqual(['CAleg2']);
      expect(twilio.holds()).toEqual([true, false]);
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        expect.objectContaining({ status: 'failed', reason: 'cancelled' }),
      );

      await flow.handleConferenceEvent(teammateJoins);

      expect(twilio.hangups()).toEqual(['CAleg2', 'CAleg2']);
      expect(events.callTransferred).not.toHaveBeenCalled();
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        activeAgentUserId: 'user-1',
        agentLegUuid: 'CAleg1',
        held: false,
      });
    });

    test('a cancel has nothing to act on once the transfer is settled', async () => {
      const { flow, realtime } = await transferringCall();
      await flow.declineOfferedCall('CAcall1', 'user-2');

      await expect(flow.cancelTransfer(agent)).resolves.toEqual({
        ok: false,
        refusal: 'no-transfer-pending',
      });
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledTimes(1);
    });

    test('only the agent who started it can cancel', async () => {
      const { flow, twilio } = await transferringCall();

      await expect(flow.cancelTransfer(teammate)).resolves.toEqual({
        ok: false,
        refusal: 'not-on-call',
      });
      expect(twilio.hangups()).toEqual([]);
    });

    test('refuses a second transfer, and a hold, while one is ringing', async () => {
      const { flow, online, twilio } = await transferringCall();
      online.add('user-3');

      await expect(flow.transferCall(agent, 'user-3')).resolves.toEqual({
        ok: false,
        refusal: 'transfer-pending',
      });
      await expect(flow.holdCall(agent, false)).resolves.toEqual({
        ok: false,
        refusal: 'transfer-pending',
      });
      expect(twilio.created).toHaveLength(2);
      expect(twilio.holds()).toEqual([true]);
    });

    test('refuses a transfer to yourself and from somebody else', async () => {
      const { flow, twilio } = buildFlow();
      await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });
      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-join',
        legUuid: 'CAleg1',
        participantLabel: 'agent|user-1|nonce',
      });

      await expect(flow.transferCall(agent, 'user-1')).resolves.toEqual({
        ok: false,
        refusal: 'transfer-to-self',
      });
      await expect(flow.transferCall(teammate, 'user-3')).resolves.toEqual({
        ok: false,
        refusal: 'not-on-call',
      });
      expect(twilio.holds()).toEqual([]);
    });

    test('a teammate can be handed the call before Twilio reports the ring they lost gone', async () => {
      const { flow, telephony, twilio, realtime } = buildFlow();
      await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });
      // user-1 answers on CAleg1; user-2's ring, CAleg2, is hung up but its
      // final status has not arrived.
      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        conferenceSid: 'CFconference1',
        event: 'participant-join',
        legUuid: 'CAleg1',
        participantLabel: 'agent|user-1|nonce',
      });

      await expect(flow.transferCall(agent, 'user-2')).resolves.toEqual({
        ok: true,
        conversationUuid: 'CAcall1',
        targetUserId: 'user-2',
      });
      expect(twilio.holds()).toEqual([true]);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        pendingTransferToUserId: 'user-2',
        agentLegs: { CAleg1: 'user-1', CAleg3: 'user-2' },
        pendingAgentLegUuids: ['CAleg3'],
      });

      // The lost ring ending is not the transfer's ring ending.
      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg2',
        status: 'canceled',
        participantLabel: 'agent|user-2|nonce',
      });

      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        pendingTransferToUserId: 'user-2',
        held: true,
      });
      expect(realtime.notifyTransferOutcome).not.toHaveBeenCalled();
      expect(twilio.holds()).toEqual([true]);
    });

    test('refuses a call that is not connected', async () => {
      const { flow } = buildFlow();
      await flow.startOutboundCall({
        callSid: 'CAagent1',
        agentUserId: 'user-1',
        targetNumber: customerNumber,
      });
      await settle();

      await expect(
        flow.transferCall({ userId: 'user-1', legUuid: 'CAagent1' }, 'user-2'),
      ).resolves.toEqual({ ok: false, refusal: 'not-connected' });
    });

    test('takes the other party off hold again when the teammate cannot be rung', async () => {
      const { flow, online, realtime, twilio, telephony } =
        await answeredCall();
      online.add('user-2');
      const target = new URLSearchParams({
        conversationUuid: 'CAcall1',
        participantType: 'agent',
        participantId: 'user-2',
      });
      twilio.failWith(
        `client:user-2?${target.toString()}`,
        new Error('Twilio rejected the dial'),
      );

      await expect(flow.transferCall(agent, 'user-2')).resolves.toEqual({
        ok: false,
        refusal: 'provider-error',
      });

      expect(twilio.holds()).toEqual([true, false]);
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        expect.objectContaining({ status: 'failed', reason: 'unavailable' }),
      );
      const state = await telephony.getCallState('CAcall1');
      expect(state).toMatchObject({ held: false, agentLegUuid: 'CAleg1' });
      expect(state?.pendingTransferToUserId).toBeUndefined();
    });

    test('takes the transfer back when the teammate cannot be offered the call', async () => {
      const { flow, online, realtime, twilio, telephony } =
        await answeredCall();
      online.add('user-2');
      realtime.notifyIncomingCall.mockRejectedValueOnce(
        new Error('Redis is unavailable'),
      );

      await expect(flow.transferCall(agent, 'user-2')).resolves.toEqual({
        ok: false,
        refusal: 'provider-error',
      });

      expect(twilio.created).toHaveLength(1);
      const state = await telephony.getCallState('CAcall1');
      expect(state?.pendingTransferToUserId).toBeUndefined();
      // The call is the agent's to control again.
      await expect(flow.transferCall(agent, 'user-2')).resolves.toMatchObject({
        ok: true,
      });
    });

    test('rings nobody when the other party cannot be held', async () => {
      const { flow, online, twilio, telephony } = await answeredCall();
      online.add('user-2');
      twilio.failHoldWith(new Error('Twilio is unavailable'));

      await expect(flow.transferCall(agent, 'user-2')).resolves.toEqual({
        ok: false,
        refusal: 'provider-error',
      });

      expect(twilio.created).toHaveLength(1);
      const state = await telephony.getCallState('CAcall1');
      expect(state?.pendingTransferToUserId).toBeUndefined();
    });

    test('rings nobody when Twilio answers that the other party is not held', async () => {
      const { flow, online, realtime, twilio, telephony } =
        await answeredCall();
      online.add('user-2');
      twilio.answerHoldsWith(false);

      await expect(flow.transferCall(agent, 'user-2')).resolves.toEqual({
        ok: false,
        refusal: 'provider-error',
      });

      expect(twilio.created).toHaveLength(1);
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        expect.objectContaining({ status: 'failed', reason: 'unavailable' }),
      );
      const state = await telephony.getCallState('CAcall1');
      expect(state?.pendingTransferToUserId).toBeUndefined();
      expect(Boolean(state?.held)).toBe(false);
    });

    test('a decline that arrives while the other party is being held leaves nobody on hold and rings nobody', async () => {
      const { flow, online, realtime, twilio, telephony } =
        await answeredCall();
      online.add('user-2');
      twilio.whileHolding(async () => {
        twilio.whileHolding(async () => undefined);
        await flow.declineOfferedCall('CAcall1', 'user-2');
      });

      await expect(flow.transferCall(agent, 'user-2')).resolves.toEqual({
        ok: false,
        refusal: 'no-transfer-pending',
      });

      expect(twilio.created).toHaveLength(1);
      expect(twilio.holds().at(-1)).toBe(false);
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledTimes(1);
      const state = await telephony.getCallState('CAcall1');
      expect(state).toMatchObject({ held: false, agentLegUuid: 'CAleg1' });
      expect(state?.pendingTransferToUserId).toBeUndefined();
    });

    test('a decline that arrives while the teammate is being rung stops the ring', async () => {
      const { flow, online, realtime, twilio, telephony } =
        await answeredCall();
      online.add('user-2');
      twilio.whileCreating(async () => {
        twilio.whileCreating(async () => undefined);
        await flow.declineOfferedCall('CAcall1', 'user-2');
      });

      await expect(flow.transferCall(agent, 'user-2')).resolves.toEqual({
        ok: false,
        refusal: 'no-transfer-pending',
      });

      expect(twilio.hangups()).toEqual(['CAleg2']);
      expect(twilio.holds().at(-1)).toBe(false);
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledTimes(1);
      const state = await telephony.getCallState('CAcall1');
      expect(state).toMatchObject({ held: false, agentLegUuid: 'CAleg1' });
      expect(state?.pendingTransferToUserId).toBeUndefined();
    });

    test('a teammate who answers before Twilio has named their leg keeps the call', async () => {
      const { flow, online, events, twilio, telephony } = await answeredCall();
      online.add('user-2');
      // The join webhook overtakes the response to the request that rang them.
      twilio.whileCreating(async () => {
        twilio.whileCreating(async () => undefined);
        await flow.handleConferenceEvent(teammateJoins);
      });

      await expect(flow.transferCall(agent, 'user-2')).resolves.toEqual({
        ok: true,
        conversationUuid: 'CAcall1',
        targetUserId: 'user-2',
      });

      expect(events.callTransferred).toHaveBeenCalledTimes(1);
      expect(twilio.hangups()).toEqual(['CAleg1']);
      expect(twilio.holds()).toEqual([true, false]);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        activeAgentUserId: 'user-2',
        agentLegUuid: 'CAleg2',
        held: false,
      });
    });

    test('keeps going when the agent hangs up while it rings, and hands over on answer', async () => {
      const { flow, events, realtime, twilio, telephony } =
        await transferringCall();

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'completed',
      });

      expect(events.callEnded).not.toHaveBeenCalled();
      expect(twilio.hangups()).toEqual([]);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        pendingTransferToUserId: 'user-2',
        held: true,
      });

      await flow.handleConferenceEvent(teammateJoins);

      expect(twilio.holds()).toEqual([true, false]);
      expect(events.callTransferred).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        fromUserId: 'user-1',
        toUserId: 'user-2',
        agentLegUuid: 'CAleg2',
      });
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledWith(
        ['user-1'],
        expect.objectContaining({ status: 'completed' }),
      );
      expect(events.callEnded).not.toHaveBeenCalled();
    });

    test('sends the caller to voicemail when the agent left and the teammate does not answer', async () => {
      const { flow, events, realtime, twilio, telephony } =
        await transferringCall();
      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'completed',
      });

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg2',
        status: 'no-answer',
      });

      expect(twilio.redirects()).toEqual([
        expect.objectContaining({
          legUuid: 'CAcall1',
          params: { twiml: expect.stringContaining('<Record') },
        }),
      ]);
      expect(twilio.hangups()).toEqual([]);
      expect(events.callEnded).not.toHaveBeenCalled();
      expect(realtime.notifyTransferOutcome).toHaveBeenCalledWith(
        ['user-1', 'user-2'],
        expect.objectContaining({ status: 'failed', reason: 'no-answer' }),
      );
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        voicemail: true,
        held: false,
        callerLegUuid: 'CAcall1',
      });
    });

    test('a call that was talked on is not reported missed when it ends up in voicemail', async () => {
      const { flow, events } = await transferringCall();
      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'completed',
      });

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg2',
        status: 'no-answer',
      });

      expect(events.callMissed).not.toHaveBeenCalled();
      // The hold the transfer began ends with the caller leaving for voicemail.
      expect(events.callHeld).toHaveBeenCalledOnce();
      expect(events.callResumed).toHaveBeenCalledExactlyOnceWith({
        conversationUuid: 'CAcall1',
        legUuid: 'CAcall1',
      });
    });

    test('ends the call when the caller hangs up while it rings', async () => {
      const { flow, events, twilio, telephony } = await transferringCall();

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAcall1',
        status: 'completed',
        duration: 75,
      });

      expect(twilio.hangups().sort()).toEqual(['CAleg1', 'CAleg2']);
      expect(events.callEnded).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', duration: 75 }),
      );
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
    });

    describe('of an outbound call', () => {
      const dialer = { userId: 'user-1', legUuid: 'CAagent1' };

      async function transferringOutboundCall() {
        const context = await answeredOutboundCall();
        await expect(
          context.flow.transferCall(dialer, 'user-2'),
        ).resolves.toEqual({
          ok: true,
          conversationUuid: 'CAagent1',
          targetUserId: 'user-2',
        });
        return context;
      }

      test('shows the teammate the number that was dialed, and holds it', async () => {
        const { realtime, twilio } = await transferringOutboundCall();

        expect(realtime.notifyIncomingCall).toHaveBeenLastCalledWith(
          ['user-2'],
          expect.objectContaining({
            conversationUuid: 'CAagent1',
            from: customerNumber,
            callerId: customerNumber,
            transferredBy: { userId: 'user-1' },
          }),
        );
        expect(twilio.participantUpdates).toEqual([
          expect.objectContaining({
            legUuid: 'CAleg1',
            params: expect.objectContaining({ hold: true }),
          }),
        ]);
        expect(twilio.created.at(-1)).toMatchObject({
          to: expect.stringMatching(/^client:user-2\?/),
        });
      });

      test('hands the call over when the teammate answers', async () => {
        const { flow, events, realtime, twilio, telephony } =
          await transferringOutboundCall();

        await flow.handleConferenceEvent({
          ...teammateJoins,
          conversationUuid: 'CAagent1',
        });

        expect(twilio.holds()).toEqual([true, false]);
        expect(twilio.hangups()).toEqual(['CAagent1']);
        expect(realtime.notifyTransferOutcome).toHaveBeenCalledWith(
          ['user-1'],
          expect.objectContaining({ status: 'completed' }),
        );
        expect(events.callTransferred).toHaveBeenCalledWith({
          conversationUuid: 'CAagent1',
          fromUserId: 'user-1',
          toUserId: 'user-2',
          agentLegUuid: 'CAleg2',
        });
        await expect(telephony.getCallState('CAagent1')).resolves.toMatchObject(
          {
            activeAgentUserId: 'user-2',
            agentLegUuid: 'CAleg2',
            externalLegUuid: 'CAleg1',
          },
        );
      });

      test('ends the call when the agent left and the teammate does not answer', async () => {
        const { flow, events, twilio, telephony } =
          await transferringOutboundCall();
        await flow.handleCallStatus({
          conversationUuid: 'CAagent1',
          legUuid: 'CAagent1',
          status: 'completed',
        });
        expect(events.callEnded).not.toHaveBeenCalled();

        await flow.handleCallStatus({
          conversationUuid: 'CAagent1',
          legUuid: 'CAleg2',
          status: 'no-answer',
        });

        expect(twilio.redirects()).toEqual([]);
        expect(twilio.hangups()).toEqual(['CAleg1']);

        await flow.handleCallStatus({
          conversationUuid: 'CAagent1',
          legUuid: 'CAleg1',
          status: 'completed',
          duration: 50,
        });

        expect(events.callEnded).toHaveBeenCalledWith(
          expect.objectContaining({ conversationUuid: 'CAagent1' }),
        );
        await expect(telephony.getCallState('CAagent1')).resolves.toBeNull();
      });
    });
  });

  describe('outbound calls', () => {
    test('dials the number while the agent waits in the conference', async () => {
      const { flow, events, realtime, twilio, telephony } = buildFlow();

      const twiml = await flow.startOutboundCall({
        callSid: 'CAagent1',
        agentUserId: 'user-1',
        targetNumber: '+15555550199',
      });
      await settle();

      expect(twiml).toContain('<Conference');
      expect(realtime.trackCallParticipants).toHaveBeenCalledWith('CAagent1', [
        'user-1',
      ]);
      expect(events.callIncoming).toHaveBeenCalledWith({
        conversationUuid: 'CAagent1',
        from: 'user-1',
        to: '+15555550199',
        direction: 'outbound',
        agentLegUuid: 'CAagent1',
        userId: 'user-1',
      });
      expect(twilio.created).toEqual([
        expect.objectContaining({ to: '+15555550199', from: '+15555550100' }),
      ]);
      await expect(telephony.getCallState('CAagent1')).resolves.toMatchObject({
        direction: 'outbound',
        externalLegUuid: 'CAleg1',
      });
    });

    test('starts when the number answers and ends when it hangs up', async () => {
      const { flow, events, twilio } = buildFlow();
      await flow.startOutboundCall({
        callSid: 'CAagent1',
        agentUserId: 'user-1',
        targetNumber: '+15555550199',
      });
      await settle();

      await flow.handleConferenceEvent({
        conversationUuid: 'CAagent1',
        event: 'participant-join',
        legUuid: 'CAleg1',
        participantLabel: 'external|%2B15555550199|nonce',
      });
      expect(events.callStarted).toHaveBeenCalledWith(
        expect.objectContaining({
          direction: 'outbound',
          userId: 'user-1',
          externalLegUuid: 'CAleg1',
        }),
      );

      await flow.handleCallStatus({
        conversationUuid: 'CAagent1',
        legUuid: 'CAleg1',
        status: 'completed',
        duration: 30,
      });
      expect(twilio.hangups()).toEqual(['CAagent1']);
      expect(events.callEnded).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', duration: 30 }),
      );
    });

    test('fails the call when the number cannot be dialed', async () => {
      const { flow, events, twilio } = buildFlow();
      twilio.failWith('+15555550199', new Error('Twilio rejected the dial'));

      await flow.startOutboundCall({
        callSid: 'CAagent1',
        agentUserId: 'user-1',
        targetNumber: '+15555550199',
      });
      await settle();

      expect(twilio.hangups()).toEqual(['CAagent1']);
      expect(events.callEnded).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'failed' }),
      );
    });
  });

  describe('recordings', () => {
    test('a voicemail recording ends the call and is handed to the API', async () => {
      const { flow, events, telephony } = buildFlow({ routing: null });
      await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });

      await flow.handleRecordingReady({
        conversationUuid: 'CAcall1',
        recordingUrl: 'https://api.twilio.example.com/recordings/RE1',
        duration: 18,
        context: 'missing-routing',
      });

      expect(events.callRecordingReady).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        recordingUrl: 'https://api.twilio.example.com/recordings/RE1',
        duration: 18,
        context: 'voicemail',
      });
      expect(events.callEnded).toHaveBeenCalledWith(
        expect.objectContaining({ conversationUuid: 'CAcall1' }),
      );
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
    });

    test('a transcription is handed to the API as is', async () => {
      const { flow, events } = buildFlow();

      await flow.handleTranscriptionReady({
        conversationUuid: 'CAcall1',
        transcript: '  Please call me back.  ',
        context: 'closed-hours',
      });

      expect(events.callTranscriptionReady).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        transcript: 'Please call me back.',
        recordingUrl: undefined,
        context: 'voicemail',
      });
    });

    test('a recording of the call itself is handed over without ending the call', async () => {
      const { flow, events, telephony } = buildFlow({ online: ['user-1'] });
      await flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });

      await flow.handleRecordingReady({
        conversationUuid: 'CAcall1',
        recordingUrl: 'https://api.twilio.example.com/recordings/RE2',
        duration: 240,
        context: 'conference',
      });

      expect(events.callRecordingReady).toHaveBeenCalledWith(
        expect.objectContaining({ context: 'conference' }),
      );
      expect(events.callEnded).not.toHaveBeenCalled();
      await expect(telephony.getCallState('CAcall1')).resolves.not.toBeNull();
    });

    test('ignores a recording callback without a context', async () => {
      const { flow, events } = buildFlow();

      await flow.handleRecordingReady({
        conversationUuid: 'CAcall1',
        recordingUrl: 'https://api.twilio.example.com/recordings/RE3',
        duration: 5,
        context: undefined,
      });

      expect(events.callRecordingReady).not.toHaveBeenCalled();
    });
  });

  test('ignores webhooks for calls it does not know', async () => {
    const { flow, events } = buildFlow();

    await flow.handleCallStatus({
      conversationUuid: 'CAunknown',
      legUuid: 'CAleg9',
      status: 'completed',
    });
    await flow.handleConferenceEvent({
      conversationUuid: 'CAunknown',
      event: 'participant-leave',
      legUuid: 'CAleg9',
    });

    expect(events.callParticipantStatus).not.toHaveBeenCalled();
    expect(events.callEnded).not.toHaveBeenCalled();
  });
});
