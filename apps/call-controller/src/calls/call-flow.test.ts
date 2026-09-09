import type { CachedRouting, CachedRoutingSettings } from '@repo/events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import { createFakeTelephony } from '../test/fake-telephony.js';
import type { CallEventPublisher } from './call-events.js';
import { CallFlow } from './call-flow.js';

const caller = '+15555550101';
const businessNumber = '+15555550102';

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
    callParticipantStatus: vi.fn(async () => undefined),
    callRecordingReady: vi.fn(async () => undefined),
    callTranscriptionReady: vi.fn(async () => undefined),
  } satisfies CallEventPublisher;
  const realtime = {
    notifyIncomingCall: vi.fn(async (userIds: string[]) =>
      userIds.filter((userId) => online.has(userId)),
    ),
    trackCallParticipants: vi.fn(async () => undefined),
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

  return { flow, events, realtime, routing, ...fake };
}

/** Let background work started by a webhook handler settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    async function answeredCall() {
      const context = buildFlow({ online: ['user-1'] });
      await context.flow.acceptInboundCall({
        callSid: 'CAcall1',
        from: caller,
        to: businessNumber,
      });
      await context.flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-join',
        legUuid: 'CAleg1',
        participantLabel: 'agent|user-1|nonce',
      });
      return context;
    }

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

    test('a transfer hands the call to the agent who answers it', async () => {
      const { flow, events, telephony, twilio } = await answeredCall();

      const targetLeg = await telephony.transferConversation(
        'CAcall1',
        'user-2',
        'user-1',
      );
      await flow.handleConferenceEvent({
        conversationUuid: 'CAcall1',
        event: 'participant-join',
        legUuid: targetLeg,
        participantLabel: 'agent|user-2|nonce',
      });

      expect(events.callTransferred).toHaveBeenCalledWith({
        conversationUuid: 'CAcall1',
        fromUserId: 'user-1',
        toUserId: 'user-2',
        agentLegUuid: targetLeg,
      });
      expect(twilio.hangups()).toEqual(['CAleg1']);

      await flow.handleCallStatus({
        conversationUuid: 'CAcall1',
        legUuid: 'CAleg1',
        status: 'completed',
      });

      expect(events.callEnded).not.toHaveBeenCalled();
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        activeAgentUserId: 'user-2',
        agentLegs: { [targetLeg]: 'user-2' },
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
