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
 * Every write is made from the version it read and refused if another write
 * landed in between; see `TelephonyService.updateCallState`.
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
  /**
   * Grows with every write. A change decided on an older version is refused
   * and decided again on the current one.
   */
  version: number;
  conversationUuid: string;
  /** The Twilio conference friendly name; see `conversationNameFor`. */
  conversationName: string;
  conferenceSid?: string;
  direction: CallDirection;
  routingType: RoutingTargetType | 'OUTBOUND';
  /**
   * The provider's caller and callee, so which is our line swaps with the
   * direction: on an inbound call the caller dialed `to`; on an outbound one
   * the agent called from `from`, the line it was granted on, never from a
   * user id. `callLine` in `@repo/dto` has the rule.
   */
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
  /**
   * The called number's own voicemail greeting, already checked to be an
   * http(s) URL. Kept here because the webhook that sends a ringing caller
   * to voicemail is not the one that looked the routing up.
   */
  voicemailGreetingUrl?: string;
  answered: boolean;
  /** The caller has been sent to voicemail; nobody will pick up. */
  voicemail: boolean;
  /** The other party is on hold, by the hold button or by a pending transfer. */
  held?: boolean;
  /** The teammate a transfer is ringing. Set for as long as it is undecided. */
  pendingTransferToUserId?: string;
  transferInitiatedBy?: string;
  /** The leg of the agent handing the call over, until they leave. */
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

/**
 * The users this call keeps from being offered another: the agent talking on
 * it (on hold or not, and from the moment they dial out), everybody whose leg
 * joined it and has not dropped yet (the agent who handed it to a teammate,
 * until their leg is gone), everybody it is still ringing before anyone
 * answers, and the teammate a transfer is ringing. Once nobody will pick up
 * (voicemail) it keeps nobody. Ending changes none of this: each keeps their
 * place until their leg drops, and a ring that lost to an answer stays let go
 * although its leg is not reported gone yet.
 */
export function occupantsOf(state: CallState): string[] {
  if (state.voicemail) {
    return [];
  }

  const talking = state.agentLegUuid ? state.activeAgentUserId : undefined;
  const joined = Object.entries(state.agentLegs)
    .filter(([legUuid]) => !state.pendingAgentLegUuids.includes(legUuid))
    .map(([, userId]) => userId);
  // After an answer the rings that lost are only waiting to be reported gone.
  const ringing = state.answered
    ? []
    : state.pendingAgentLegUuids.map((legUuid) => state.agentLegs[legUuid]);
  const users = new Set(
    [talking, ...joined, ...ringing, state.pendingTransferToUserId].filter(
      (userId): userId is string => Boolean(userId),
    ),
  );

  return [...users];
}

/**
 * Who a change to the call let go: everybody it occupied, or had a leg on,
 * before the change and no longer occupies after it. `after` is null when the
 * change ended the call.
 */
export function usersLetGo(
  before: CallState,
  after: CallState | null,
): string[] {
  const stillOccupied = new Set(after ? occupantsOf(after) : []);
  const legsAfter = after?.agentLegs ?? {};
  const candidates = new Set([
    ...occupantsOf(before),
    ...Object.entries(before.agentLegs)
      .filter(([legUuid]) => !(legUuid in legsAfter))
      .map(([, userId]) => userId),
  ]);

  return [...candidates].filter((userId) => !stillOccupied.has(userId));
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
