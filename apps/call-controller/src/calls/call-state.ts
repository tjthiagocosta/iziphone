import type {
  CallDirection,
  OpenHoursRoutingType,
  RoutingTargetType,
} from '@repo/dto';
import type { CallParticipantType } from '@repo/events';

/*
 * Everything the controller remembers about a live call. A call is a Twilio
 * conference; each person in it is a leg (a Twilio call SID). The state lives
 * in Redis for the duration of the call and is deleted when it is finalized.
 */

export interface CallParticipant {
  participantType: CallParticipantType;
  participantId: string;
}

/** Which conversation a leg belongs to and who is on it, keyed by leg id. */
export interface LegMetadata extends CallParticipant {
  conversationUuid: string;
}

export interface CallState {
  conversationUuid: string;
  /** The Twilio conference friendly name; see `conversationNameFor`. */
  conversationName: string;
  conferenceSid?: string;
  direction: CallDirection;
  routingType: RoutingTargetType | 'OUTBOUND';
  from: string;
  to: string;
  departmentId?: string;
  departmentName?: string;
  targetUserId?: string;
  targetUserName?: string;
  /** The agent currently talking to the remote party. */
  activeAgentUserId?: string;
  callerLegUuid?: string;
  agentLegUuid?: string;
  externalLegUuid?: string;
  /** Every agent leg dialed for this call, leg id to user id. */
  agentLegs: Record<string, string>;
  /** Agent legs still ringing. */
  pendingAgentLegUuids: string[];
  /** Users to ring in order, for FIXED_ORDER departments. */
  routingQueue?: string[];
  currentQueueIndex?: number;
  ringStrategy?: OpenHoursRoutingType;
  /** Seconds each agent leg rings before Twilio gives up on it. */
  ringDuration?: number;
  answered: boolean;
  /** The caller has been sent to voicemail; nobody will pick up. */
  voicemail: boolean;
  pendingTransferToUserId?: string;
  transferInitiatedBy?: string;
  transferOriginLegUuid?: string;
  /** A hangup was requested; remaining legs are being torn down. */
  ending: boolean;
  endingRequestedAt?: string;
  endingRequestedBy?: string;
  createdAt: string;
}

const CONFERENCE_NAME_PREFIX = 'call-';

export function conversationNameFor(conversationUuid: string): string {
  return `${CONFERENCE_NAME_PREFIX}${conversationUuid}`;
}

/** The inverse of `conversationNameFor`, for Twilio's `FriendlyName` field. */
export function parseConversationName(
  conversationName: string,
): string | undefined {
  if (!conversationName.startsWith(CONFERENCE_NAME_PREFIX)) {
    return undefined;
  }

  return conversationName.slice(CONFERENCE_NAME_PREFIX.length) || undefined;
}

/** Every leg id the state refers to, without duplicates or blanks. */
export function legUuidsOf(state: CallState): string[] {
  const legs = new Set([
    state.callerLegUuid,
    state.agentLegUuid,
    state.externalLegUuid,
    ...Object.keys(state.agentLegs),
    ...state.pendingAgentLegUuids,
  ]);

  return [...legs].filter((legUuid): legUuid is string => Boolean(legUuid));
}

export function hasActiveLegs(state: CallState): boolean {
  return legUuidsOf(state).length > 0;
}

/** Forget a leg that has left the call. Mutates `state`; callers save it. */
export function removeLeg(state: CallState, legUuid: string): void {
  delete state.agentLegs[legUuid];
  state.pendingAgentLegUuids = state.pendingAgentLegUuids.filter(
    (pending) => pending !== legUuid,
  );

  if (state.callerLegUuid === legUuid) state.callerLegUuid = undefined;
  if (state.agentLegUuid === legUuid) state.agentLegUuid = undefined;
  if (state.externalLegUuid === legUuid) state.externalLegUuid = undefined;
  if (state.transferOriginLegUuid === legUuid) {
    state.transferOriginLegUuid = undefined;
  }
}

/** Find who a leg belongs to from the state alone. */
export function participantOfLeg(
  state: CallState,
  legUuid: string,
): CallParticipant | null {
  if (state.callerLegUuid === legUuid) {
    return { participantType: 'caller', participantId: state.from };
  }

  if (state.externalLegUuid === legUuid) {
    return { participantType: 'external', participantId: state.to };
  }

  const agentUserId = state.agentLegs[legUuid];
  return agentUserId
    ? { participantType: 'agent', participantId: agentUserId }
    : null;
}
