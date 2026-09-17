import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createFakeLogger } from '../test/fake-logger.js';
import {
  createFakeRedis,
  createFakeTelephony,
} from '../test/fake-telephony.js';
import { type CallState, conversationNameFor } from './call-state.js';
import { TelephonyService } from './telephony.service.js';

function inboundState(overrides: Partial<CallState> = {}): CallState {
  return {
    conversationUuid: 'CAcall1',
    conversationName: conversationNameFor('CAcall1'),
    direction: 'inbound',
    routingType: 'DEPARTMENT',
    from: '+15555550101',
    to: '+15555550102',
    callerLegUuid: 'CAcall1',
    agentLegs: {},
    pendingAgentLegUuids: [],
    answered: false,
    voicemail: false,
    ending: false,
    createdAt: '2026-09-08T12:00:00.000Z',
    ...overrides,
  };
}

describe('TelephonyService', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  describe('when Twilio is not configured', () => {
    const { redis } = createFakeRedis();
    const telephony = new TelephonyService({
      redis,
      voice: null,
      internalApi: {
        url: 'http://api.example.com',
        token: 'a-fictional-internal-token-value',
      },
      log: createFakeLogger(),
    });

    test('reports itself unconfigured and refuses to issue tokens', async () => {
      expect(telephony.isConfigured()).toBe(false);
      expect(() => telephony.generateClientJwt('user-1')).toThrow(
        'Twilio telephony is not configured',
      );
      await expect(telephony.testConnection()).rejects.toThrow(
        'Twilio telephony is not configured',
      );
    });

    test('still stores call state', async () => {
      await telephony.saveCallState(inboundState());
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        conversationUuid: 'CAcall1',
      });
      await telephony.deleteCallState('CAcall1');
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
    });
  });

  test('issues a Twilio access token for the softphone', () => {
    const { telephony } = createFakeTelephony();

    const jwt = telephony.generateClientJwt('user-1');

    expect(jwt.split('.')).toHaveLength(3);
  });

  test('records the telephony identity with the API', async () => {
    const { telephony } = createFakeTelephony();

    await telephony.ensureUser('user-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/internal/users/user-1/telephony',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer a-fictional-internal-token-value',
        }),
        body: JSON.stringify({ telephonyUserId: 'user-1' }),
      }),
    );
  });

  test('rings an agent into the conference and remembers the leg', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(inboundState({ ringDuration: 25 }));

    const legUuid = await telephony.createAgentLeg('CAcall1', 'user-1', {
      fromNumber: '+15555550102',
    });

    expect(legUuid).toBe('CAleg1');
    expect(twilio.created[0]).toMatchObject({
      conferenceSid: 'call-CAcall1',
      from: '+15555550102',
      to: 'client:user-1?conversationUuid=CAcall1&participantType=agent&participantId=user-1',
      timeout: 25,
      statusCallback:
        'https://calls.example.com/webhooks/twilio/voice/status?conversationUuid=CAcall1&source=participant',
    });
    expect(twilio.created[0]?.label).toMatch(/^agent\|user-1\|/);
    await expect(telephony.getLegMetadata('CAleg1')).resolves.toEqual({
      conversationUuid: 'CAcall1',
      participantType: 'agent',
      participantId: 'user-1',
    });
    await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
      agentLegs: { CAleg1: 'user-1' },
      pendingAgentLegUuids: ['CAleg1'],
    });
  });

  test('hangs a freshly created leg up again when the call ended meanwhile', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(inboundState());
    twilio.whileCreating(async () => {
      await telephony.requestConversationHangup('CAcall1', 'user-9');
    });

    await telephony.createAgentLeg('CAcall1', 'user-1');

    expect(twilio.hangups()).toContain('CAleg1');
    await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
      agentLegs: {},
    });
  });

  test('rings several agents at once and records every leg', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(inboundState());
    twilio.failWith(
      'client:user-3?conversationUuid=CAcall1&participantType=agent&participantId=user-3',
      new Error('busy'),
    );

    const legs = await telephony.ringAgents('CAcall1', [
      'user-1',
      'user-2',
      'user-3',
    ]);

    expect(legs).toEqual([
      { userId: 'user-1', legUuid: 'CAleg1' },
      { userId: 'user-2', legUuid: 'CAleg2' },
    ]);
    await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
      agentLegs: { CAleg1: 'user-1', CAleg2: 'user-2' },
      pendingAgentLegUuids: ['CAleg1', 'CAleg2'],
    });
  });

  test('does not ring anyone once the call is ending', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(inboundState({ ending: true }));

    await expect(telephony.ringAgents('CAcall1', ['user-1'])).resolves.toEqual(
      [],
    );
    expect(twilio.created).toHaveLength(0);
  });

  test('refuses to ring while the call is ending', async () => {
    const { telephony } = createFakeTelephony();
    await telephony.saveCallState(inboundState({ ending: true }));

    await expect(telephony.createAgentLeg('CAcall1', 'user-1')).rejects.toThrow(
      /is ending/,
    );
  });

  test('dials an external number in E.164 and refuses anything else', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(inboundState());

    await telephony.createExternalLeg('CAcall1', '(555) 555-0199', {
      fromNumber: '+15555550102',
    });

    expect(twilio.created[0]).toMatchObject({
      from: '+15555550102',
      to: '+15555550199',
    });
    await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
      externalLegUuid: 'CAleg1',
    });

    await expect(
      telephony.createExternalLeg('CAcall1', 'not a number'),
    ).rejects.toThrow(/not E\.164/);
  });

  test('uses the deployment number as caller id when none is given', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(inboundState());

    await telephony.createExternalLeg('CAcall1', '+15555550199');

    expect(twilio.created[0]).toMatchObject({ from: '+15555550100' });
  });

  test('requesting a hangup marks the call as ending and hangs up every leg', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(
      inboundState({
        agentLegUuid: 'CAagent1',
        agentLegs: { CAagent1: 'user-1', CAagent2: 'user-2' },
        pendingAgentLegUuids: ['CAagent2'],
        pendingTransferToUserId: 'user-3',
      }),
    );

    const state = await telephony.requestConversationHangup(
      'CAcall1',
      'user-1',
    );

    expect(state).toMatchObject({
      ending: true,
      endingRequestedBy: 'user-1',
      pendingAgentLegUuids: [],
      pendingTransferToUserId: undefined,
    });
    expect(twilio.hangups().sort()).toEqual([
      'CAagent1',
      'CAagent2',
      'CAcall1',
    ]);
  });

  test('a hangup tolerates legs Twilio no longer knows and retries throttling', async () => {
    const { telephony, twilio } = createFakeTelephony();
    twilio.failWith('CAgone', { status: 404 });
    twilio.failWith('CAbusy', { status: 429 });

    await expect(telephony.safeHangup('CAgone')).resolves.toBeUndefined();
    await expect(telephony.safeHangup('CAbusy')).resolves.toBeUndefined();
  });

  test('holds the caller of an inbound call in its conference', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(inboundState({ answered: true }));

    const held = await telephony.holdConversation('CAcall1', true);

    expect(held).toBe(true);
    expect(twilio.participantUpdates).toEqual([
      {
        conferenceSid: 'CFconference1',
        legUuid: 'CAcall1',
        params: {
          hold: true,
          holdUrl: expect.stringMatching(/^http/),
          holdMethod: 'GET',
        },
      },
    ]);
    await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
      conferenceSid: 'CFconference1',
    });
  });

  test('resumes without hold audio, and holds the number dialed on an outbound call', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(
      inboundState({
        direction: 'outbound',
        callerLegUuid: undefined,
        externalLegUuid: 'CAexternal1',
        answered: true,
      }),
    );

    const held = await telephony.holdConversation('CAcall1', false);

    expect(held).toBe(false);
    expect(twilio.participantUpdates).toEqual([
      {
        conferenceSid: 'CFconference1',
        legUuid: 'CAexternal1',
        params: { hold: false, holdUrl: undefined, holdMethod: undefined },
      },
    ]);
  });

  test('a hold answers null when the call or the party is gone, and throws what else Twilio refuses', async () => {
    const { telephony, twilio } = createFakeTelephony();

    await expect(telephony.holdConversation('CAcall1', true)).resolves.toBe(
      null,
    );

    await telephony.saveCallState(inboundState({ answered: true }));
    twilio.failHoldWith({ status: 404 });
    await expect(telephony.holdConversation('CAcall1', true)).resolves.toBe(
      null,
    );

    twilio.failHoldWith({ status: 500 });
    await expect(
      telephony.holdConversation('CAcall1', true),
    ).rejects.toMatchObject({ status: 500 });
  });

  test('a hold answers null when the conference of the call is already over', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(inboundState({ answered: true }));
    twilio.endConference();

    await expect(telephony.holdConversation('CAcall1', true)).resolves.toBe(
      null,
    );
    expect(twilio.participantUpdates).toEqual([]);
  });

  test('a transfer rings the teammate only while it is still pending for them', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.saveCallState(
      inboundState({
        answered: true,
        agentLegUuid: 'CAagent1',
        activeAgentUserId: 'user-1',
        agentLegs: { CAagent1: 'user-1' },
      }),
    );

    await expect(
      telephony.transferConversation('CAcall1', 'user-2', 'user-1'),
    ).resolves.toBeNull();
    expect(twilio.created).toEqual([]);

    await telephony.saveCallState(
      inboundState({
        answered: true,
        agentLegUuid: 'CAagent1',
        activeAgentUserId: 'user-1',
        agentLegs: { CAagent1: 'user-1' },
        pendingTransferToUserId: 'user-2',
        transferInitiatedBy: 'user-1',
        transferOriginLegUuid: 'CAagent1',
      }),
    );

    const targetLeg = await telephony.transferConversation(
      'CAcall1',
      'user-2',
      'user-1',
    );

    expect(targetLeg).toBe('CAleg1');
    expect(twilio.created).toEqual([
      expect.objectContaining({
        to: expect.stringMatching(/^client:user-2\?/),
        from: '+15555550102',
      }),
    ]);
    await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
      agentLegs: { CAagent1: 'user-1', CAleg1: 'user-2' },
      pendingAgentLegUuids: ['CAleg1'],
      pendingTransferToUserId: 'user-2',
    });
  });

  test('conference TwiML joins the caller and reports back to this service', () => {
    const { telephony } = createFakeTelephony();

    const twiml = telephony.buildConferenceTwiml(inboundState(), {
      participantType: 'caller',
      participantId: '+15555550101',
    });

    expect(twiml).toContain('<Conference');
    expect(twiml).toContain('>call-CAcall1</Conference>');
    expect(twiml).toContain('participantLabel="caller|%2B15555550101|');
    expect(twiml).toContain(
      'statusCallback="https://calls.example.com/webhooks/twilio/voice/status?conversationUuid=CAcall1&amp;source=conference"',
    );
    expect(twiml).toContain('record="record-from-start"');
  });

  test('voicemail TwiML greets, records and labels the recording with its reason', () => {
    const { telephony } = createFakeTelephony();

    const twiml = telephony.buildVoicemailTwiml('CAcall1', 'closed-hours');

    expect(twiml).toContain('We are currently closed');
    expect(twiml).toContain(
      'action="https://calls.example.com/webhooks/twilio/voice/voicemail/completed?conversationUuid=CAcall1&amp;context=closed-hours"',
    );
    expect(twiml).toContain(
      'source=voicemail-recording&amp;context=closed-hours',
    );
    expect(twiml).toContain('transcribe="true"');
  });

  test('redirecting a leg to voicemail replaces its TwiML', async () => {
    const { telephony, twilio } = createFakeTelephony();

    await telephony.redirectLegToVoicemail(
      'CAcall1',
      'CAcall1',
      'routing-timeout',
    );

    expect(twilio.redirects()).toHaveLength(1);
    expect(twilio.redirects()[0]?.params.twiml).toContain('<Record');
  });

  test('parses the participant label it produced', () => {
    const { telephony } = createFakeTelephony();

    expect(telephony.parseParticipantLabel('agent|user-1|abc123')).toEqual({
      participantType: 'agent',
      participantId: 'user-1',
    });
    expect(telephony.parseParticipantLabel('caller|%2B15555550101|x')).toEqual({
      participantType: 'caller',
      participantId: '+15555550101',
    });
    expect(telephony.parseParticipantLabel('guest|user-1|x')).toBeNull();
    expect(telephony.parseParticipantLabel(undefined)).toBeNull();
  });
});
