import { describe, expect, test } from 'vitest';
import {
  type CallState,
  conversationNameFor,
  hasActiveLegs,
  legUuidsOf,
  parseConversationName,
  participantOfLeg,
  removeLeg,
} from './call-state.js';

function buildState(overrides: Partial<CallState> = {}): CallState {
  return {
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
