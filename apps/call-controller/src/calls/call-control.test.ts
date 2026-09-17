import { CallControlRefusalSchema } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  planHangup,
  planTransferFailure,
  REFUSAL_MESSAGES,
  refuseHold,
  refuseTransfer,
  refuseTransferCancel,
  remoteLegOf,
  transferFailureReasonOf,
  transferOfferOf,
} from './call-control.js';
import type { CallState, LegMetadata } from './call-state.js';

const customer = '+15555550123';
const line = '+15555550100';

/** An inbound call user-1 is talking on through CAagent1. */
function connectedCall(overrides: Partial<CallState> = {}): CallState {
  return {
    conversationUuid: 'CAcall1',
    conversationName: 'call-CAcall1',
    direction: 'inbound',
    routingType: 'DEPARTMENT',
    from: customer,
    to: line,
    departmentId: 'dept-1',
    departmentName: 'Support',
    callerLegUuid: 'CAcall1',
    agentLegUuid: 'CAagent1',
    activeAgentUserId: 'user-1',
    agentLegs: { CAagent1: 'user-1' },
    pendingAgentLegUuids: [],
    answered: true,
    voicemail: false,
    ending: false,
    createdAt: '2026-09-08T12:00:00.000Z',
    ...overrides,
  };
}

function agentLeg(overrides: Partial<LegMetadata> = {}): LegMetadata {
  return {
    conversationUuid: 'CAcall1',
    participantType: 'agent',
    participantId: 'user-1',
    ...overrides,
  };
}

const request = { userId: 'user-1', legUuid: 'CAagent1' };

const transferring = {
  pendingTransferToUserId: 'user-2',
  transferInitiatedBy: 'user-1',
  transferOriginLegUuid: 'CAagent1',
  agentLegs: { CAagent1: 'user-1', CAleg2: 'user-2' },
  pendingAgentLegUuids: ['CAleg2'],
};

describe('remoteLegOf', () => {
  test('is the caller of an inbound call and the number dialed on an outbound one', () => {
    expect(remoteLegOf(connectedCall())).toBe('CAcall1');
    expect(
      remoteLegOf(
        connectedCall({
          direction: 'outbound',
          callerLegUuid: undefined,
          externalLegUuid: 'CAexternal1',
        }),
      ),
    ).toBe('CAexternal1');
    expect(
      remoteLegOf(
        connectedCall({ direction: 'outbound', callerLegUuid: undefined }),
      ),
    ).toBeUndefined();
  });
});

describe('who may control a call', () => {
  test('the agent talking on it, through the leg they are talking on', () => {
    expect(refuseHold(connectedCall(), agentLeg(), request)).toBeNull();
  });

  test.each([
    [
      'a leg that belongs to someone else',
      agentLeg({ participantId: 'user-9' }),
    ],
    ['a leg that is not an agent leg', agentLeg({ participantType: 'caller' })],
    ['a leg of another call', agentLeg({ conversationUuid: 'CAother' })],
  ])('not through %s', (_name, leg) => {
    expect(refuseHold(connectedCall(), leg, request)).toBe('not-on-call');
  });

  test('not an agent whose softphone is only ringing for the call', () => {
    const state = connectedCall({
      agentLegs: { CAagent1: 'user-1', CAleg2: 'user-2' },
    });

    expect(
      refuseHold(state, agentLeg({ participantId: 'user-2' }), {
        userId: 'user-2',
        legUuid: 'CAleg2',
      }),
    ).toBe('not-on-call');
  });

  test('not the agent who already handed the call over', () => {
    const state = connectedCall({
      agentLegUuid: 'CAleg2',
      activeAgentUserId: 'user-2',
      agentLegs: { CAleg2: 'user-2' },
    });

    expect(refuseHold(state, agentLeg(), request)).toBe('not-on-call');
  });

  test.each([
    ['nobody answered yet', { answered: false }],
    ['it is being hung up', { ending: true }],
    ['the caller is in voicemail', { voicemail: true }],
    ['the other party is gone', { callerLegUuid: undefined }],
  ])('not while %s', (_name, overrides) => {
    expect(refuseHold(connectedCall(overrides), agentLeg(), request)).toBe(
      'not-connected',
    );
  });
});

describe('refuseHold', () => {
  test('refuses while a transfer is ringing, which holds the call itself', () => {
    expect(refuseHold(connectedCall(transferring), agentLeg(), request)).toBe(
      'transfer-pending',
    );
  });
});

describe('refuseTransfer', () => {
  test('allows a teammate who is not on the call', () => {
    expect(
      refuseTransfer(connectedCall(), agentLeg(), request, 'user-2'),
    ).toBeNull();
  });

  test('refuses a second transfer while one is pending', () => {
    expect(
      refuseTransfer(
        connectedCall(transferring),
        agentLeg(),
        request,
        'user-3',
      ),
    ).toBe('transfer-pending');
  });

  test('refuses a transfer to yourself', () => {
    expect(refuseTransfer(connectedCall(), agentLeg(), request, 'user-1')).toBe(
      'transfer-to-self',
    );
  });

  test('refuses a teammate who has joined the call', () => {
    const state = connectedCall({
      agentLegs: { CAagent1: 'user-1', CAleg2: 'user-2' },
    });

    expect(refuseTransfer(state, agentLeg(), request, 'user-2')).toBe(
      'target-on-call',
    );
  });

  test('allows a teammate whose lost ring Twilio has not reported gone yet', () => {
    const state = connectedCall({
      agentLegs: { CAagent1: 'user-1', CAleg2: 'user-2' },
      pendingAgentLegUuids: ['CAleg2'],
    });

    expect(refuseTransfer(state, agentLeg(), request, 'user-2')).toBeNull();
  });

  test('checks who is asking before anything about the target', () => {
    expect(
      refuseTransfer(
        connectedCall(),
        agentLeg({ participantId: 'user-9' }),
        request,
        'user-1',
      ),
    ).toBe('not-on-call');
    expect(
      refuseTransfer(
        connectedCall({ answered: false }),
        agentLeg(),
        request,
        'user-2',
      ),
    ).toBe('not-connected');
  });
});

describe('refuseTransferCancel', () => {
  test('allows the agent who started the pending transfer', () => {
    expect(
      refuseTransferCancel(connectedCall(transferring), agentLeg(), request),
    ).toBeNull();
  });

  test('refuses when nothing is pending', () => {
    expect(refuseTransferCancel(connectedCall(), agentLeg(), request)).toBe(
      'no-transfer-pending',
    );
  });

  test('refuses the teammate it is ringing', () => {
    expect(
      refuseTransferCancel(
        connectedCall(transferring),
        agentLeg({ participantId: 'user-2' }),
        { userId: 'user-2', legUuid: 'CAleg2' },
      ),
    ).toBe('not-on-call');
  });
});

describe('planHangup', () => {
  test('ends the call for the agent talking on it', () => {
    expect(planHangup(connectedCall(), request)).toBe('end-call');
  });

  test('ends an outbound call the agent hangs up before it is answered', () => {
    const state = connectedCall({
      direction: 'outbound',
      answered: false,
      callerLegUuid: undefined,
    });

    expect(planHangup(state, request)).toBe('end-call');
  });

  test('releases only the agent who leaves while their transfer rings', () => {
    expect(planHangup(connectedCall(transferring), request)).toBe(
      'release-leg',
    );
  });

  test('is a decline when the teammate hangs up their ringing leg', () => {
    expect(
      planHangup(connectedCall(transferring), {
        userId: 'user-2',
        legUuid: 'CAleg2',
      }),
    ).toBe('decline-transfer');
  });

  test('releases only the leg of an agent who already handed the call over', () => {
    const state = connectedCall({
      agentLegUuid: 'CAleg2',
      activeAgentUserId: 'user-2',
      agentLegs: { CAleg2: 'user-2' },
    });

    expect(planHangup(state, request)).toBe('release-leg');
    expect(planHangup(state, { userId: 'user-2', legUuid: 'CAleg2' })).toBe(
      'end-call',
    );
  });

  test('keeps ending a call that is already ending', () => {
    expect(
      planHangup(connectedCall({ ...transferring, ending: true }), request),
    ).toBe('end-call');
  });
});

describe('planTransferFailure', () => {
  test('returns the other party to the agent who is still on the call', () => {
    expect(planTransferFailure(connectedCall(transferring))).toBe(
      'return-to-agent',
    );
  });

  test('sends a caller to voicemail when the transferring agent has left', () => {
    const state = connectedCall({
      ...transferring,
      agentLegUuid: undefined,
      transferOriginLegUuid: undefined,
      agentLegs: { CAleg2: 'user-2' },
    });

    expect(planTransferFailure(state)).toBe('voicemail');
  });

  test('ends an outbound call when the transferring agent has left', () => {
    const state = connectedCall({
      ...transferring,
      direction: 'outbound',
      callerLegUuid: undefined,
      externalLegUuid: 'CAexternal1',
      agentLegUuid: undefined,
      transferOriginLegUuid: undefined,
    });

    expect(planTransferFailure(state)).toBe('end-call');
  });
});

describe('transferFailureReasonOf', () => {
  test.each([
    ['busy', 'declined'],
    ['no-answer', 'no-answer'],
    ['canceled', 'unavailable'],
    ['failed', 'unavailable'],
    ['completed', 'unavailable'],
  ] as const)('%s reads as %s', (status, reason) => {
    expect(transferFailureReasonOf(status)).toBe(reason);
  });
});

describe('transferOfferOf', () => {
  test('shows the caller of an inbound call and who hands it over', () => {
    expect(transferOfferOf(connectedCall(), 'user-1')).toEqual({
      conversationUuid: 'CAcall1',
      from: customer,
      to: line,
      callerId: customer,
      routingType: 'DEPARTMENT',
      departmentId: 'dept-1',
      departmentName: 'Support',
      transferredBy: { userId: 'user-1' },
      metadata: { provider: 'twilio' },
    });
  });

  test('shows the number dialed as the caller of an outbound call', () => {
    const offer = transferOfferOf(
      connectedCall({
        direction: 'outbound',
        routingType: 'OUTBOUND',
        from: line,
        to: customer,
        departmentId: undefined,
        departmentName: undefined,
      }),
      'user-1',
    );

    expect(offer).toMatchObject({
      from: customer,
      callerId: customer,
      to: line,
      transferredBy: { userId: 'user-1' },
    });
    expect(offer.routingType).toBeUndefined();
  });

  test('never offers the user id an outbound call may name as its origin as a number', () => {
    const offer = transferOfferOf(
      connectedCall({
        direction: 'outbound',
        routingType: 'OUTBOUND',
        from: 'user-1',
        to: customer,
      }),
      'user-1',
    );

    expect(offer).toMatchObject({ from: customer, to: customer });
  });
});

describe('REFUSAL_MESSAGES', () => {
  test('has a sentence for every refusal the contract names', () => {
    expect(Object.keys(REFUSAL_MESSAGES).sort()).toEqual(
      [...CallControlRefusalSchema.options].sort(),
    );
  });
});
