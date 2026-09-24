import { describe, expect, test } from 'vitest';
import {
  type CallState,
  conversationNameFor,
  hasActiveLegs,
  legUuidsOf,
  occupantsOf,
  parseConversationName,
  participantOfLeg,
  removeLeg,
  usersLetGo,
} from './call-state.js';

function buildState(overrides: Partial<CallState> = {}): CallState {
  return {
    version: 1,
    conversationUuid: 'CAcall1',
    conversationName: 'call-CAcall1',
    direction: 'inbound',
    routingType: 'DEPARTMENT',
    from: '+15555550101',
    to: '+15555550102',
    callerLegUuid: 'CAcall1',
    agentLegUuid: 'CAagent1',
    agentLegs: { CAagent1: 'user-1', CAagent2: 'user-2' },
    pendingAgentLegUuids: ['CAagent2'],
    answered: true,
    voicemail: false,
    ending: false,
    createdAt: '2026-09-08T12:00:00.000Z',
    ...overrides,
  };
}

describe('conversation names', () => {
  test('round-trip through the Twilio friendly name', () => {
    expect(conversationNameFor('CAcall1')).toBe('call-CAcall1');
    expect(parseConversationName('call-CAcall1')).toBe('CAcall1');
  });

  test('reject names that are not ours', () => {
    expect(parseConversationName('room-1')).toBeUndefined();
    expect(parseConversationName('call-')).toBeUndefined();
  });
});

describe('legUuidsOf', () => {
  test('lists every leg once', () => {
    expect(legUuidsOf(buildState()).sort()).toEqual([
      'CAagent1',
      'CAagent2',
      'CAcall1',
    ]);
  });
});

describe('removeLeg', () => {
  test('forgets the leg everywhere it is referenced', () => {
    const state = buildState({ transferOriginLegUuid: 'CAagent1' });

    removeLeg(state, 'CAagent1');

    expect(state.agentLegUuid).toBeUndefined();
    expect(state.transferOriginLegUuid).toBeUndefined();
    expect(state.agentLegs).toEqual({ CAagent2: 'user-2' });
    expect(hasActiveLegs(state)).toBe(true);
  });

  test('reports no active legs once everyone has left', () => {
    const state = buildState();

    for (const legUuid of legUuidsOf(state)) {
      removeLeg(state, legUuid);
    }

    expect(hasActiveLegs(state)).toBe(false);
  });
});

describe('participantOfLeg', () => {
  test('identifies the caller, agents and the external party', () => {
    const state = buildState({ externalLegUuid: 'CAexternal1' });

    expect(participantOfLeg(state, 'CAcall1')).toEqual({
      participantType: 'caller',
      participantId: '+15555550101',
    });
    expect(participantOfLeg(state, 'CAagent2')).toEqual({
      participantType: 'agent',
      participantId: 'user-2',
    });
    expect(participantOfLeg(state, 'CAexternal1')).toEqual({
      participantType: 'external',
      participantId: '+15555550102',
    });
    expect(participantOfLeg(state, 'CAunknown')).toBeNull();
  });
});

describe('occupantsOf', () => {
  test('a call still ringing occupies everybody it rings', () => {
    const ringing = buildState({
      answered: false,
      agentLegUuid: undefined,
      agentLegs: { CAagent1: 'user-1', CAagent2: 'user-2' },
      pendingAgentLegUuids: ['CAagent1', 'CAagent2'],
    });

    expect(occupantsOf(ringing)).toEqual(['user-1', 'user-2']);
  });

  test('an answered call occupies the agent talking, not the rings that lost', () => {
    const answered = buildState({ activeAgentUserId: 'user-1' });

    expect(occupantsOf(answered)).toEqual(['user-1']);
  });

  test('a held call still occupies its agent', () => {
    expect(
      occupantsOf(buildState({ activeAgentUserId: 'user-1', held: true })),
    ).toEqual(['user-1']);
  });

  test('a transfer occupies both the agent handing it over and the teammate', () => {
    const transferring = buildState({
      activeAgentUserId: 'user-1',
      pendingTransferToUserId: 'user-3',
    });

    expect(occupantsOf(transferring)).toEqual(['user-1', 'user-3']);
  });

  test('after a transfer the agent who handed it over stays occupied until their leg is gone', () => {
    const handedOver = buildState({
      agentLegUuid: 'CAagent3',
      activeAgentUserId: 'user-3',
      agentLegs: { CAagent1: 'user-1', CAagent3: 'user-3' },
      pendingAgentLegUuids: [],
    });

    expect(occupantsOf(handedOver)).toEqual(['user-3', 'user-1']);
    expect(
      occupantsOf({ ...handedOver, agentLegs: { CAagent3: 'user-3' } }),
    ).toEqual(['user-3']);
  });

  test('an outbound call occupies the agent from the moment they dial', () => {
    const dialing = buildState({
      direction: 'outbound',
      routingType: 'OUTBOUND',
      answered: false,
      callerLegUuid: undefined,
      agentLegUuid: 'CAagent1',
      activeAgentUserId: 'user-1',
      agentLegs: { CAagent1: 'user-1' },
      pendingAgentLegUuids: [],
    });

    expect(occupantsOf(dialing)).toEqual(['user-1']);
  });

  test('voicemail occupies nobody; an ending call keeps everybody whose leg is still up', () => {
    expect(occupantsOf(buildState({ voicemail: true }))).toEqual([]);
    expect(
      occupantsOf(
        buildState({ ending: true, pendingAgentLegUuids: [], held: true }),
      ),
    ).toEqual(['user-1', 'user-2']);
  });

  test('an ending call does not take back a ring that lost to the answer, though its leg is still up', () => {
    const ending = buildState({ ending: true, activeAgentUserId: 'user-1' });

    expect(occupantsOf(ending)).toEqual(['user-1']);
  });

  test('an ending call that nobody answered keeps everybody it was ringing', () => {
    const ending = buildState({
      ending: true,
      answered: false,
      agentLegUuid: undefined,
      pendingAgentLegUuids: ['CAagent1', 'CAagent2'],
    });

    expect(occupantsOf(ending)).toEqual(['user-1', 'user-2']);
  });
});

describe('usersLetGo', () => {
  test('an answer lets go of every ring that lost', () => {
    const ringing = buildState({
      answered: false,
      agentLegUuid: undefined,
      agentLegs: { CAagent1: 'user-1', CAagent2: 'user-2', CAagent3: 'user-3' },
      pendingAgentLegUuids: ['CAagent1', 'CAagent2', 'CAagent3'],
    });
    const answered: CallState = {
      ...ringing,
      answered: true,
      agentLegUuid: 'CAagent2',
      activeAgentUserId: 'user-2',
      pendingAgentLegUuids: ['CAagent1', 'CAagent3'],
    };

    expect(usersLetGo(ringing, answered)).toEqual(['user-1', 'user-3']);
  });

  test('a leg that drops lets its user go, unless the call still occupies them', () => {
    const ending = buildState({ ending: true, pendingAgentLegUuids: [] });
    const afterOne: CallState = {
      ...ending,
      agentLegs: { CAagent1: 'user-1' },
    };

    expect(usersLetGo(ending, afterOne)).toEqual(['user-2']);
  });

  test('the end of the call lets everybody go', () => {
    const answered = buildState({ activeAgentUserId: 'user-1' });

    expect(usersLetGo(answered, null)).toEqual(['user-1', 'user-2']);
  });

  test('a change that keeps everybody lets nobody go', () => {
    const answered = buildState({ activeAgentUserId: 'user-1' });

    expect(usersLetGo(answered, { ...answered, held: true })).toEqual([]);
  });
});
