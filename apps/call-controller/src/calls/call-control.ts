import {
  type CallControlRefusal,
  type CallEndStatus,
  callLine,
  type IncomingCall,
  type TransferFailureReason,
} from '@repo/dto';
import type { CallState, LegMetadata } from './call-state.js';

/*
 * The rules behind an agent's controls over a live call: who may hold,
 * transfer or hang up, and what becomes of the call when a transfer falls
 * through. Pure: every answer comes from the state handed in, so the flow
 * that talks to Twilio has no conditions of its own worth getting wrong.
 */

/** Who is asking, and the leg of theirs the request is addressed by. */
export interface CallControlRequest {
  userId: string;
  legUuid: string;
}

export const REFUSAL_MESSAGES: Record<CallControlRefusal, string> = {
  'leg-not-found': 'That call is not known here',
  'not-on-call': 'Only the agent on the call can do that',
  'not-connected': 'The call is not connected',
  'transfer-pending': 'A transfer is already ringing for this call',
  'no-transfer-pending': 'No transfer is ringing for this call',
  'transfer-to-self': 'A call cannot be transferred to yourself',
  'target-on-call': 'That teammate is already on this call',
  'target-offline': 'That teammate is not online',
  'call-gone': 'The call has already ended',
  'provider-error': 'The phone provider did not accept the request',
};

/**
 * The party the agent is talking to, which is the one a hold silences: the
 * caller of an inbound call (or the number it was forwarded to), and the
 * number dialed on an outbound one.
 */
export function remoteLegOf(state: CallState): string | undefined {
  return state.direction === 'outbound'
    ? state.externalLegUuid
    : (state.callerLegUuid ?? state.externalLegUuid);
}

/**
 * Both checks every control shares: the request comes from the agent who is
 * talking on this call, through the leg they are talking on, and there is a
 * connected party on the other side. A leg that is only ringing, a leg of
 * another call and the leg of an agent who already handed the call over all
 * fail the first one.
 */
function refuseUnlessOnConnectedCall(
  state: CallState,
  leg: LegMetadata,
  request: CallControlRequest,
): CallControlRefusal | null {
  const ownsLeg =
    leg.participantType === 'agent' &&
    leg.participantId === request.userId &&
    leg.conversationUuid === state.conversationUuid;
  const isTalking =
    state.agentLegUuid === request.legUuid &&
    state.activeAgentUserId === request.userId;

  if (!ownsLeg || !isTalking) {
    return 'not-on-call';
  }

  if (
    !state.answered ||
    state.ending ||
    state.voicemail ||
    !remoteLegOf(state)
  ) {
    return 'not-connected';
  }

  return null;
}

export function refuseHold(
  state: CallState,
  leg: LegMetadata,
  request: CallControlRequest,
): CallControlRefusal | null {
  const refusal = refuseUnlessOnConnectedCall(state, leg, request);
  if (refusal) {
    return refusal;
  }

  // The transfer holds the other party itself and releases them when it
  // settles; a resume in between would let them hear the agent again while
  // the agent's screen still says they are waiting.
  return state.pendingTransferToUserId ? 'transfer-pending' : null;
}

export function refuseTransfer(
  state: CallState,
  leg: LegMetadata,
  request: CallControlRequest,
  targetUserId: string,
): CallControlRefusal | null {
  const refusal = refuseUnlessOnConnectedCall(state, leg, request);
  if (refusal) {
    return refusal;
  }

  if (state.pendingTransferToUserId) {
    return 'transfer-pending';
  }

  if (targetUserId === request.userId) {
    return 'transfer-to-self';
  }

  // A leg that only rang is not on the call. The ring an agent lost to
  // whoever answered stays in the state until Twilio reports it gone, and
  // must not keep that agent from being handed the call in the meantime.
  const hasJoined = Object.entries(state.agentLegs).some(
    ([legUuid, userId]) =>
      userId === targetUserId && !state.pendingAgentLegUuids.includes(legUuid),
  );
  const isOnCall = state.activeAgentUserId === targetUserId || hasJoined;

  return isOnCall ? 'target-on-call' : null;
}

export function refuseTransferCancel(
  state: CallState,
  leg: LegMetadata,
  request: CallControlRequest,
): CallControlRefusal | null {
  const refusal = refuseUnlessOnConnectedCall(state, leg, request);
  if (refusal) {
    return refusal;
  }

  return state.pendingTransferToUserId &&
    state.transferInitiatedBy === request.userId
    ? null
    : 'no-transfer-pending';
}

/**
 * What a hangup request from someone allowed to make it means. Normally it
 * ends the call for everyone. Around a transfer it must not:
 *
 * - while one rings, the agent handing the call over may leave and the
 *   teammate may turn it down, and the other party stays on the line;
 * - once it is answered, the agent who handed it over has a leg that is no
 *   longer the call's, and a hangup they sent a moment too late releases
 *   that leg instead of ending the call for the teammate.
 */
export type HangupPlan = 'end-call' | 'release-leg' | 'decline-transfer';

export function planHangup(
  state: CallState,
  request: CallControlRequest,
): HangupPlan {
  if (state.ending) {
    return 'end-call';
  }

  if (state.pendingTransferToUserId) {
    const isRingingTarget =
      state.pendingTransferToUserId === request.userId &&
      state.agentLegUuid !== request.legUuid;

    return isRingingTarget ? 'decline-transfer' : 'release-leg';
  }

  const isTalking =
    state.agentLegUuid === request.legUuid ||
    state.activeAgentUserId === request.userId;

  return state.answered && !isTalking ? 'release-leg' : 'end-call';
}

/**
 * Where the other party goes when the teammate cannot be reached. Back to
 * the agent who started the transfer if they are still there. If they left
 * in the meantime nobody is: a caller gets voicemail, and a number we dialed
 * has nothing to leave a message for, so that call ends.
 */
export type TransferFailurePlan = 'return-to-agent' | 'voicemail' | 'end-call';

export function planTransferFailure(state: CallState): TransferFailurePlan {
  // `removeLeg` forgets the origin leg when the transferring agent leaves.
  const originIsStillTalking =
    state.transferOriginLegUuid !== undefined &&
    state.agentLegUuid === state.transferOriginLegUuid;

  if (originIsStillTalking) {
    return 'return-to-agent';
  }

  return state.direction === 'inbound' && state.callerLegUuid
    ? 'voicemail'
    : 'end-call';
}

/**
 * Why a teammate's leg ended without an answer, from Twilio's final status.
 * Twilio reports a rejected call as busy or as no-answer, so only `busy` is
 * read as a decline here; a decline the softphone reports itself is exact.
 */
export function transferFailureReasonOf(
  status: CallEndStatus,
): TransferFailureReason {
  switch (status) {
    case 'busy':
      return 'declined';
    case 'no-answer':
      return 'no-answer';
    default:
      return 'unavailable';
  }
}

/**
 * What the teammate is shown while the transfer rings: the customer as the
 * caller, exactly as for a call routed to them, plus who is handing it over.
 */
export function transferOfferOf(
  state: CallState,
  initiatedBy: string,
): IncomingCall {
  const customer = state.direction === 'outbound' ? state.to : state.from;

  return {
    conversationUuid: state.conversationUuid,
    from: customer,
    to: callLine(state),
    callerId: customer,
    routingType:
      state.routingType === 'OUTBOUND' ? undefined : state.routingType,
    departmentId: state.departmentId,
    departmentName: state.departmentName,
    transferredBy: { userId: initiatedBy },
    metadata: { provider: 'twilio' },
  };
}
