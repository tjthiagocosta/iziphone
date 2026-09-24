import { OUTBOUND_GRANT, TELEPHONY } from '@repo/events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { VOICEMAIL_REASONS } from '../routing/index.js';
import { e164 } from '../test/e164.js';
import { createFakeLogger } from '../test/fake-logger.js';
import {
  createFakeRedis,
  createFakeTelephony,
} from '../test/fake-telephony.js';
import { type CallState, conversationNameFor } from './call-state.js';
import type { OutboundCallGrant } from './outbound-grant.js';
import {
  CALL_STATE_WRITE_ATTEMPTS,
  CallStateConflictError,
  LEG_STATUS_TIMEOUT_MS,
  TelephonyService,
} from './telephony.service.js';

/** The line the test calls are on: the number the inbound caller dialed. */
const line = '+15555550102';

function inboundState(overrides: Partial<CallState> = {}): CallState {
  return {
    version: 1,
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

/** The `<Record>` verb of a TwiML document, attributes and all. */
function recordElementOf(twiml: string): string {
  const match = /<Record\b[^>]*>/.exec(twiml);
  if (!match) {
    throw new Error('The TwiML has no <Record>');
  }
  return match[0];
}

describe('TelephonyService', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    // Playable by default: most tests here are not about the greeting probe,
    // and a voicemail greeting URL that the probe cannot confirm is spoken
    // instead of played (see the "voicemail greeting probe" tests below).
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );
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
      await telephony.createCallState(inboundState());
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        conversationUuid: 'CAcall1',
      });
      await telephony.updateCallState('CAcall1', () => ({
        result: undefined,
        remove: true,
      }));
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
    });
  });

  describe('changing a call state', () => {
    const hold = (draft: CallState) => {
      draft.held = true;
      return { result: 'held' };
    };

    test('writes the change as the next version', async () => {
      const { telephony } = createFakeTelephony();
      await telephony.createCallState(inboundState());

      const update = await telephony.updateCallState('CAcall1', hold);

      expect(update?.result).toBe('held');
      expect(update?.before).toMatchObject({ version: 1 });
      expect(update?.after).toMatchObject({ version: 2, held: true });
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        version: 2,
        held: true,
      });
    });

    test('writes nothing when the decision changes nothing', async () => {
      const { telephony } = createFakeTelephony();
      await telephony.createCallState(inboundState({ held: true }));

      const update = await telephony.updateCallState('CAcall1', hold);

      expect(update?.after).toBe(update?.before);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        version: 1,
      });
    });

    test('decides nothing for a call that has no state', async () => {
      const { telephony } = createFakeTelephony();
      const decide = vi.fn(hold);

      await expect(
        telephony.updateCallState('CAcall1', decide),
      ).resolves.toBeNull();
      expect(decide).not.toHaveBeenCalled();
    });

    test('decides again on what another write left, when one landed first', async () => {
      const { telephony, beforeNextCallStateWrite } = createFakeTelephony();
      await telephony.createCallState(inboundState({ answered: true }));
      beforeNextCallStateWrite(async () => {
        await telephony.updateCallState('CAcall1', (draft) => {
          draft.ending = true;
          return { result: undefined };
        });
      });

      const update = await telephony.updateCallState('CAcall1', (draft) => {
        if (draft.ending) {
          return { result: 'too late' };
        }
        draft.held = true;
        return { result: 'held' };
      });

      expect(update?.result).toBe('too late');
      const state = await telephony.getCallState('CAcall1');
      expect(state).toMatchObject({ version: 2, ending: true });
      expect(state?.held).toBeUndefined();
    });

    test('gives up, writing nothing, when the call changes under every attempt', async () => {
      const { telephony, beforeNextCallStateWrite } = createFakeTelephony();
      await telephony.createCallState(inboundState());
      const interfere = async () => {
        await telephony.updateCallState('CAcall1', (draft) => {
          draft.currentQueueIndex = (draft.currentQueueIndex ?? 0) + 1;
          return { result: undefined };
        });
        beforeNextCallStateWrite(interfere);
      };
      beforeNextCallStateWrite(interfere);
      const decide = vi.fn(hold);

      await expect(
        telephony.updateCallState('CAcall1', decide),
      ).rejects.toBeInstanceOf(CallStateConflictError);

      expect(decide).toHaveBeenCalledTimes(CALL_STATE_WRITE_ATTEMPTS);
      const state = await telephony.getCallState('CAcall1');
      expect(state?.held).toBeUndefined();
      expect(state?.currentQueueIndex).toBe(CALL_STATE_WRITE_ATTEMPTS);
    });

    test('every one of nine rings of a department reported gone at once lands', async () => {
      const { telephony } = createFakeTelephony();
      const legs = Array.from({ length: 9 }, (_, index) => `CAagent${index}`);
      await telephony.createCallState(
        inboundState({
          agentLegs: Object.fromEntries(
            legs.map((legUuid, index) => [legUuid, `user-${index}`]),
          ),
          pendingAgentLegUuids: legs,
        }),
      );

      const updates = await Promise.all(
        legs.map((legUuid) =>
          telephony.updateCallState('CAcall1', (draft) => {
            draft.pendingAgentLegUuids = draft.pendingAgentLegUuids.filter(
              (pending) => pending !== legUuid,
            );
            return { result: legUuid };
          }),
        ),
      );

      expect(updates.map((update) => update?.result)).toEqual(legs);
      await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
        version: 10,
        pendingAgentLegUuids: [],
      });
    });

    test('resolves to null when the call ended between the read and the write', async () => {
      const { telephony, beforeNextCallStateWrite } = createFakeTelephony();
      await telephony.createCallState(inboundState());
      beforeNextCallStateWrite(async () => {
        await telephony.updateCallState('CAcall1', () => ({
          result: undefined,
          remove: true,
        }));
      });

      await expect(
        telephony.updateCallState('CAcall1', hold),
      ).resolves.toBeNull();
      await expect(telephony.getCallState('CAcall1')).resolves.toBeNull();
    });

    test('keeps the calls that have a state in a set until they are removed', async () => {
      const { telephony } = createFakeTelephony();
      await telephony.createCallState(inboundState());
      await telephony.createCallState(
        inboundState({ conversationUuid: 'CAcall2', callerLegUuid: 'CAcall2' }),
      );

      await telephony.updateCallState('CAcall1', () => ({
        result: undefined,
        remove: true,
      }));
      await expect(telephony.liveCallIds()).resolves.toEqual(['CAcall2']);

      await telephony.forgetLiveCall('CAcall2');
      await expect(telephony.liveCallIds()).resolves.toEqual([]);
    });

    test('puts back in the set a call whose state is missing from it', async () => {
      const { telephony, store } = createFakeTelephony();
      await telephony.createCallState(inboundState());
      // Written before the set existed, by the controller this one replaced.
      store.set(
        `${TELEPHONY.CALL_KEY_PREFIX}CAcall2`,
        JSON.stringify(
          inboundState({
            conversationUuid: 'CAcall2',
            callerLegUuid: 'CAcall2',
          }),
        ),
      );

      await expect(telephony.restoreLiveCalls()).resolves.toBe(1);
      await expect(telephony.restoreLiveCalls()).resolves.toBe(0);

      expect((await telephony.liveCallIds()).sort()).toEqual([
        'CAcall1',
        'CAcall2',
      ]);
    });
  });

  describe('the reconcile lock', () => {
    test('has one holder at a time, for as long as it was taken', async () => {
      const { telephony, ttls } = createFakeTelephony();

      await expect(
        telephony.takeReconcileLock('instance-1', 270_000),
      ).resolves.toBe(true);
      await expect(
        telephony.takeReconcileLock('instance-2', 270_000),
      ).resolves.toBe(false);

      expect(ttls.get(TELEPHONY.RECONCILE_LOCK_KEY)).toBe(270);
    });

    test('is given up only by its holder', async () => {
      const { telephony } = createFakeTelephony();
      await telephony.takeReconcileLock('instance-1', 270_000);

      await telephony.releaseReconcileLock('instance-2');
      await expect(
        telephony.takeReconcileLock('instance-2', 270_000),
      ).resolves.toBe(false);

      await telephony.releaseReconcileLock('instance-1');
      await expect(
        telephony.takeReconcileLock('instance-2', 270_000),
      ).resolves.toBe(true);
    });
  });

  describe('asking Twilio about a leg', () => {
    test('gives up on a Twilio that does not answer in time', async () => {
      vi.useFakeTimers();
      try {
        const { telephony, twilio } = createFakeTelephony();
        twilio.stallLegFetches();

        const status = telephony.fetchLegStatus('CAleg1');
        const failure = expect(status).rejects.toThrow(/did not say within/);
        await vi.advanceTimersByTimeAsync(LEG_STATUS_TIMEOUT_MS);

        await failure;
      } finally {
        vi.useRealTimers();
      }
    });

    test('takes a leg Twilio does not know for one that is over', async () => {
      const { telephony, twilio } = createFakeTelephony();
      twilio.forgetLeg('CAleg1');

      await expect(telephony.fetchLegStatus('CAleg1')).resolves.toEqual({
        status: 'completed',
      });
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
    await telephony.createCallState(inboundState({ ringDuration: 25 }));

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

  test('hangs a freshly created leg up again when the call ended meanwhile, and says it rings nobody', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.createCallState(inboundState());
    twilio.whileCreating(async () => {
      await telephony.updateCallState('CAcall1', (draft) => {
        draft.ending = true;
        return { result: undefined };
      });
    });

    await expect(
      telephony.createAgentLeg('CAcall1', 'user-1', { fromNumber: line }),
    ).resolves.toBeNull();

    expect(twilio.hangups()).toContain('CAleg1');
    await expect(telephony.getCallState('CAcall1')).resolves.toMatchObject({
      agentLegs: {},
    });
  });

  test('reports no leg of a ring the call ended during, so that nobody counts on it', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.createCallState(inboundState());
    twilio.whileCreating(async () => {
      await telephony.updateCallState('CAcall1', () => ({
        result: undefined,
        remove: true,
      }));
    });

    await expect(
      telephony.ringAgents('CAcall1', ['user-1', 'user-2'], {
        fromNumber: line,
      }),
    ).resolves.toEqual([]);

    expect(twilio.hangups().sort()).toEqual(['CAleg1', 'CAleg2']);
  });

  test('rings several agents at once and records every leg', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.createCallState(inboundState());
    twilio.failWith(
      'client:user-3?conversationUuid=CAcall1&participantType=agent&participantId=user-3',
      new Error('busy'),
    );

    const legs = await telephony.ringAgents(
      'CAcall1',
      ['user-1', 'user-2', 'user-3'],
      { fromNumber: line },
    );

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
    await telephony.createCallState(inboundState({ ending: true }));

    await expect(
      telephony.ringAgents('CAcall1', ['user-1'], { fromNumber: line }),
    ).resolves.toEqual([]);
    expect(twilio.created).toHaveLength(0);
  });

  test('refuses to ring while the call is ending', async () => {
    const { telephony } = createFakeTelephony();
    await telephony.createCallState(inboundState({ ending: true }));

    await expect(
      telephony.createAgentLeg('CAcall1', 'user-1', { fromNumber: line }),
    ).rejects.toThrow(/is ending/);
  });

  test('dials an external number in E.164 and refuses anything else', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.createCallState(inboundState());

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
      telephony.createExternalLeg('CAcall1', 'not a number', {
        fromNumber: line,
      }),
    ).rejects.toThrow(/not E\.164/);
  });

  test('never dials a leg whose caller id is not a number: there is no deployment number to fall back to', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.createCallState(inboundState());

    await expect(
      telephony.createExternalLeg('CAcall1', '+15555550199', {
        fromNumber: 'user-1',
      }),
    ).rejects.toThrow(/without the line it is on as caller id/);
    await expect(
      telephony.createAgentLeg('CAcall1', 'user-2', { fromNumber: '' }),
    ).rejects.toThrow(/without the line it is on as caller id/);
    expect(twilio.created).toHaveLength(0);
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
    await telephony.createCallState(inboundState({ answered: true }));

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
    await telephony.createCallState(
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

    await telephony.createCallState(inboundState({ answered: true }));
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
    await telephony.createCallState(inboundState({ answered: true }));
    twilio.endConference();

    await expect(telephony.holdConversation('CAcall1', true)).resolves.toBe(
      null,
    );
    expect(twilio.participantUpdates).toEqual([]);
  });

  test('a transfer rings the teammate only while it is still pending for them', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.createCallState(
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

    await telephony.createCallState(
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

  test('a transfer of an outbound call rings the teammate from our line, not from the number that was dialed', async () => {
    const { telephony, twilio } = createFakeTelephony();
    await telephony.createCallState(
      inboundState({
        direction: 'outbound',
        routingType: 'OUTBOUND',
        from: line,
        to: '+15555550199',
        callerLegUuid: undefined,
        externalLegUuid: 'CAexternal1',
        answered: true,
        agentLegUuid: 'CAagent1',
        activeAgentUserId: 'user-1',
        agentLegs: { CAagent1: 'user-1' },
        pendingTransferToUserId: 'user-2',
        transferInitiatedBy: 'user-1',
        transferOriginLegUuid: 'CAagent1',
      }),
    );

    await telephony.transferConversation('CAcall1', 'user-2', 'user-1');

    expect(twilio.created).toEqual([
      expect.objectContaining({
        from: line,
        to: expect.stringMatching(/^client:user-2\?/),
      }),
    ]);
  });

  test('refusal TwiML tells the agent why the call was not placed and hangs up', () => {
    const { telephony } = createFakeTelephony();

    const twiml = telephony.buildOutboundRefusalTwiml('no-grant');

    expect(twiml).toContain('Your call was not placed.');
    expect(twiml).toContain('<Hangup/>');
    expect(twiml).not.toContain('<Conference');
    expect(twiml).not.toContain('<Dial');
  });

  describe('outbound grants', () => {
    const grant: OutboundCallGrant = {
      userId: 'user-1',
      to: e164('+15555550199'),
      fromNumber: e164(line),
      departmentId: 'dept-1',
      departmentName: 'Support',
      createdAt: '2026-09-17T12:00:00.000Z',
    };

    test('a grant is kept for one minute under a token that names nothing', async () => {
      const { telephony, store, ttls } = createFakeTelephony();

      const token = await telephony.issueOutboundGrant(grant);

      expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(token).not.toContain('user-1');
      const key = `${OUTBOUND_GRANT.KEY_PREFIX}${token}`;
      expect(JSON.parse(store.get(key) ?? 'null')).toEqual(grant);
      expect(ttls.get(key)).toBe(OUTBOUND_GRANT.TTL_SECONDS);
    });

    test('two grants never share a token', async () => {
      const { telephony } = createFakeTelephony();

      const first = await telephony.issueOutboundGrant(grant);
      const second = await telephony.issueOutboundGrant(grant);

      expect(first).not.toBe(second);
    });

    test('a grant can be taken once; the second taker gets nothing', async () => {
      const { telephony } = createFakeTelephony();
      const token = await telephony.issueOutboundGrant(grant);

      await expect(telephony.takeOutboundGrant(token)).resolves.toEqual(grant);
      await expect(telephony.takeOutboundGrant(token)).resolves.toBeNull();
    });

    test('a token that was never issued yields nothing', async () => {
      const { telephony } = createFakeTelephony();

      await expect(
        telephony.takeOutboundGrant('not-a-token'),
      ).resolves.toBeNull();
    });

    test('a stored value that is not a grant is taken and refused as none', async () => {
      const { telephony, store } = createFakeTelephony();
      const key = `${OUTBOUND_GRANT.KEY_PREFIX}broken`;
      store.set(key, JSON.stringify({ userId: 'user-1' }));

      await expect(telephony.takeOutboundGrant('broken')).resolves.toBeNull();
      expect(store.has(key)).toBe(false);
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

  test('voicemail TwiML greets, records and labels the recording with its reason', async () => {
    const { telephony } = createFakeTelephony();

    const twiml = await telephony.buildVoicemailTwiml(
      inboundState(),
      'closed-hours',
    );

    expect(twiml).toContain('We are currently closed');
    expect(twiml).not.toContain('<Play');
    expect(twiml).toContain(
      'action="https://calls.example.com/webhooks/twilio/voice/voicemail/completed?conversationUuid=CAcall1&amp;context=closed-hours"',
    );
    expect(twiml).toContain(
      'source=voicemail-recording&amp;context=closed-hours',
    );
    expect(twiml).toContain('transcribe="true"');
  });

  test('voicemail TwiML plays the custom greeting instead of speaking, then records as usual', async () => {
    const { telephony } = createFakeTelephony();
    const spoken = await telephony.buildVoicemailTwiml(
      inboundState(),
      'closed-hours',
    );

    const twiml = await telephony.buildVoicemailTwiml(
      inboundState({
        voicemailGreetingUrl: 'https://example.com/greeting.mp3?v=2&lang=en',
      }),
      'closed-hours',
    );

    expect(twiml).toContain(
      '<Play>https://example.com/greeting.mp3?v=2&amp;lang=en</Play>',
    );
    expect(twiml).not.toContain('<Say');
    expect(twiml).not.toContain('We are currently closed');
    // The greeting comes first, and swapping it changes nothing else: the
    // recording keeps its action, callbacks and reason.
    expect(twiml.indexOf('<Play>')).toBeLessThan(twiml.indexOf('<Record'));
    expect(recordElementOf(twiml)).toBe(recordElementOf(spoken));
    expect(recordElementOf(twiml)).toContain('context=closed-hours');
  });

  test('redirecting a leg to voicemail replaces its TwiML', async () => {
    const { telephony, twilio } = createFakeTelephony();

    await telephony.redirectLegToVoicemail(
      'CAcall1',
      inboundState(),
      'routing-timeout',
    );

    expect(twilio.redirects()).toHaveLength(1);
    expect(twilio.redirects()[0]?.params.twiml).toContain('<Record');
    expect(twilio.redirects()[0]?.params.twiml).toContain(
      'Nobody is available',
    );
  });

  test('redirecting a leg to voicemail plays the custom greeting', async () => {
    const { telephony, twilio, telephonyLog } = createFakeTelephony();

    await telephony.redirectLegToVoicemail(
      'CAcall1',
      inboundState({
        voicemailGreetingUrl: 'https://example.com/greeting.mp3',
      }),
      'routing-timeout',
    );

    const twiml = String(twilio.redirects()[0]?.params.twiml);
    expect(twiml).toContain('<Play>https://example.com/greeting.mp3</Play>');
    expect(twiml).not.toContain('<Say');
    expect(twiml).toContain('<Record');
    expect(telephonyLog.warn).not.toHaveBeenCalled();
  });

  test('the caller has already ended the call when the redirect lands', async () => {
    const { telephony, twilio, telephonyLog } = createFakeTelephony();
    twilio.failWith('CAcall1', { status: 404 });

    await expect(
      telephony.redirectLegToVoicemail(
        'CAcall1',
        inboundState(),
        'routing-timeout',
      ),
    ).resolves.toBeUndefined();

    expect(telephonyLog.info).toHaveBeenCalledWith(
      { conversationUuid: 'CAcall1', legUuid: 'CAcall1' },
      expect.stringContaining('ended'),
    );
    expect(telephonyLog.warn).not.toHaveBeenCalled();
  });

  test('a redirect still fails loudly for anything other than a leg that is already gone', async () => {
    const { telephony, twilio } = createFakeTelephony();
    twilio.failWith('CAcall1', { status: 500 });

    await expect(
      telephony.redirectLegToVoicemail(
        'CAcall1',
        inboundState(),
        'routing-timeout',
      ),
    ).rejects.toMatchObject({ status: 500 });
  });

  test('a greeting URL too long for an inline redirect costs the greeting, not the voicemail', async () => {
    const { telephony, twilio, telephonyLog } = createFakeTelephony();
    const voicemailGreetingUrl = `https://example.com/greeting.mp3?token=${'a'.repeat(4000)}`;

    await telephony.redirectLegToVoicemail(
      'CAcall1',
      inboundState({ voicemailGreetingUrl }),
      'routing-timeout',
    );

    const twiml = String(twilio.redirects()[0]?.params.twiml);
    expect(twiml.length).toBeLessThanOrEqual(4000);
    expect(twiml).not.toContain('<Play');
    expect(twiml).toContain('Nobody is available');
    expect(twiml).toContain('<Record');
    // Whoever is asked why the greeting did not play needs a trace, but the
    // URL may carry a signed token and must stay out of the log.
    expect(telephonyLog.warn).toHaveBeenCalledTimes(1);
    expect(telephonyLog.warn).toHaveBeenCalledWith(
      {
        conversationUuid: 'CAcall1',
        greetingUrlLength: voicemailGreetingUrl.length,
      },
      expect.stringContaining('too long'),
    );
    expect(
      JSON.stringify(vi.mocked(telephonyLog.warn).mock.calls),
    ).not.toContain('example.com');
    // A URL that cannot fit the TwiML could not be played either way: the
    // length guard runs first so it never costs a probe.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the greeting is measured as it is written into the TwiML, not as it is configured', async () => {
    const { telephony, twilio } = createFakeTelephony();
    // The same length, but every "&" takes five characters in the XML.
    const plain = `https://example.com/greeting.mp3?${'a=1a'.repeat(450)}`;
    const escaped = `https://example.com/greeting.mp3?${'a=1&'.repeat(450)}`;
    expect(escaped).toHaveLength(plain.length);

    expect(
      await telephony.buildVoicemailTwiml(
        inboundState({ voicemailGreetingUrl: plain }),
        'closed-hours',
      ),
    ).toContain(`<Play>${plain}</Play>`);

    // A caller answered with voicemail straight away and one pulled out of
    // the conference hear the same thing.
    const direct = await telephony.buildVoicemailTwiml(
      inboundState({ voicemailGreetingUrl: escaped }),
      'closed-hours',
    );
    await telephony.redirectLegToVoicemail(
      'CAcall1',
      inboundState({ voicemailGreetingUrl: escaped }),
      'routing-timeout',
    );
    const redirected = String(twilio.redirects()[0]?.params.twiml);

    expect(direct).not.toContain('<Play');
    expect(direct).toContain('We are currently closed');
    expect(redirected).not.toContain('<Play');
    expect(redirected).toContain('Nobody is available');
    expect(redirected.length).toBeLessThanOrEqual(4000);
  });

  describe('voicemail greeting probe', () => {
    const voicemailGreetingUrl = 'https://example.com/greetings/support.mp3';

    test('plays a greeting the probe confirms is reachable audio', async () => {
      const { telephony, telephonyLog } = createFakeTelephony();
      fetchMock.mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
      );

      const twiml = await telephony.buildVoicemailTwiml(
        inboundState({ voicemailGreetingUrl }),
        'closed-hours',
      );

      expect(twiml).toContain(`<Play>${voicemailGreetingUrl}</Play>`);
      expect(fetchMock).toHaveBeenCalledWith(
        voicemailGreetingUrl,
        expect.objectContaining({ method: 'HEAD' }),
      );
      expect(telephonyLog.warn).not.toHaveBeenCalled();
    });

    test('speaks the built-in greeting when the probe cannot reach the URL, and logs once', async () => {
      const { telephony, telephonyLog } = createFakeTelephony();
      fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

      const twiml = await telephony.buildVoicemailTwiml(
        inboundState({ voicemailGreetingUrl }),
        'closed-hours',
      );

      expect(twiml).not.toContain('<Play');
      expect(twiml).toContain('We are currently closed');
      expect(telephonyLog.warn).toHaveBeenCalledTimes(1);
      expect(telephonyLog.warn).toHaveBeenCalledWith(
        {
          conversationUuid: 'CAcall1',
          greetingPath: '/greetings/support.mp3',
          outcome: 'unreachable',
        },
        expect.stringContaining('not playable'),
      );
    });

    test('speaks the built-in greeting when the URL does not answer with audio', async () => {
      const { telephony, telephonyLog } = createFakeTelephony();
      fetchMock.mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );

      const twiml = await telephony.buildVoicemailTwiml(
        inboundState({ voicemailGreetingUrl }),
        'closed-hours',
      );

      expect(twiml).not.toContain('<Play');
      expect(telephonyLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'not-audio' }),
        expect.stringContaining('not playable'),
      );
    });

    test('speaks the built-in greeting when the probe times out', async () => {
      const { telephony, telephonyLog } = createFakeTelephony();
      fetchMock.mockRejectedValue(
        Object.assign(new Error('The operation was aborted'), {
          name: 'TimeoutError',
        }),
      );

      const twiml = await telephony.buildVoicemailTwiml(
        inboundState({ voicemailGreetingUrl }),
        'closed-hours',
      );

      expect(twiml).not.toContain('<Play');
      expect(telephonyLog.warn).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'timed-out' }),
        expect.stringContaining('not playable'),
      );
    });

    test('probes nothing and logs nothing when no greeting is configured', async () => {
      const { telephony, telephonyLog } = createFakeTelephony();

      const twiml = await telephony.buildVoicemailTwiml(
        inboundState(),
        'closed-hours',
      );

      expect(twiml).not.toContain('<Play');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(telephonyLog.warn).not.toHaveBeenCalled();
    });
  });

  test('a greeting plays for every reason or for none, up to exactly what a redirect can carry', async () => {
    const { telephony } = createFakeTelephony();
    const longestReason = VOICEMAIL_REASONS.reduce((longest, reason) =>
      reason.length > longest.length ? reason : longest,
    );
    const probe = 'https://example.com/greeting.mp3?token=';
    const room =
      4000 -
      (
        await telephony.buildVoicemailTwiml(
          inboundState({ voicemailGreetingUrl: probe }),
          longestReason,
        )
      ).length;
    const largestThatFits = probe + 'a'.repeat(room);

    expect(
      await telephony.buildVoicemailTwiml(
        inboundState({ voicemailGreetingUrl: largestThatFits }),
        longestReason,
      ),
    ).toHaveLength(4000);

    for (const reason of VOICEMAIL_REASONS) {
      const fits = await telephony.buildVoicemailTwiml(
        inboundState({ voicemailGreetingUrl: largestThatFits }),
        reason,
      );
      expect(fits).toContain(`<Play>${largestThatFits}</Play>`);
      expect(fits.length).toBeLessThanOrEqual(4000);

      // One character more fits the shorter reasons but not the longest, and
      // the number must not greet some of its callers and not others.
      const oneTooMany = await telephony.buildVoicemailTwiml(
        inboundState({ voicemailGreetingUrl: `${largestThatFits}a` }),
        reason,
      );
      expect(oneTooMany).not.toContain('<Play');
      expect(oneTooMany).toContain('<Say');
      expect(recordElementOf(oneTooMany)).toBe(recordElementOf(fits));
    }
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
