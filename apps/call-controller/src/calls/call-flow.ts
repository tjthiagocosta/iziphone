import type {
  CallControlRefusal,
  CallEndStatus,
  CallTransferOutcome,
  IncomingCall,
  OutboundGrantRefusal,
  TransferFailureReason,
} from '@repo/dto';
import { OUTBOUND_GRANT } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import {
  type InboundCallPlan,
  maskPhoneNumber,
  planInboundCall,
  type RoutingLookupService,
  usableGreetingUrl,
  type VoicemailReason,
} from '../routing/index.js';
import {
  type CallControlRequest,
  planTransferFailure,
  refuseHold,
  refuseTransfer,
  refuseTransferCancel,
  remoteLegOf,
  transferFailureReasonOf,
  transferOfferOf,
} from './call-control.js';
import type { CallEventPublisher } from './call-events.js';
import {
  type CallParticipant,
  type CallState,
  conversationNameFor,
  hasActiveLegs,
  type LegMetadata,
  legUuidsOf,
  participantOfLeg,
  removeLeg,
} from './call-state.js';
import {
  admitOutboundCall,
  decideOutboundGrant,
  type OutboundGrantRequest,
} from './outbound-grant.js';
import {
  isTerminalStatus,
  normalizeCallStatus,
  type ParticipantStatus,
  participantDescription,
  participantEventType,
} from './participant-status.js';
import type { TelephonyService } from './telephony.service.js';

/*
 * The life of a call, from Twilio's first webhook to the `call:ended` event.
 * Twilio drives it: every method here answers one webhook, loads the call
 * state, decides what happens next, and saves the state back. The agent on
 * the call drives the rest: holding the other party and handing the call to
 * a teammate.
 *
 * Nothing locks the state, and a webhook, a softphone request and a socket
 * message can all act on one call at once. So whatever waited on Twilio reads
 * the state again before writing, and a pending transfer is settled by
 * whoever clears its marker first; the ones that find it cleared step back.
 */

/** What the flow needs from the realtime layer, without depending on it. */
export interface CallRealtime {
  /** Offer the call to the users who are online; resolves to those reached. */
  notifyIncomingCall(userIds: string[], call: IncomingCall): Promise<string[]>;
  /** Remember who should hear that the call ended. */
  trackCallParticipants(
    conversationUuid: string,
    userIds: string[],
  ): Promise<void>;
  /** Tell these users' softphones how a transfer ended. */
  notifyTransferOutcome(
    userIds: string[],
    outcome: CallTransferOutcome,
  ): Promise<void>;
}

export type CallFlowTelephony = Pick<
  TelephonyService,
  | 'getCallState'
  | 'saveCallState'
  | 'deleteCallState'
  | 'setLegMetadata'
  | 'getLegMetadata'
  | 'deleteLegMetadata'
  | 'ensureConferenceReference'
  | 'createAgentLeg'
  | 'ringAgents'
  | 'createExternalLeg'
  | 'issueOutboundGrant'
  | 'takeOutboundGrant'
  | 'hangupConversation'
  | 'requestConversationHangup'
  | 'holdConversation'
  | 'transferConversation'
  | 'safeHangup'
  | 'redirectLegToVoicemail'
  | 'buildConferenceTwiml'
  | 'buildVoicemailTwiml'
  | 'buildOutboundRefusalTwiml'
  | 'parseParticipantLabel'
>;

export interface CallFlowDependencies {
  telephony: CallFlowTelephony;
  routing: Pick<RoutingLookupService, 'lookupByPhone'>;
  events: CallEventPublisher;
  realtime: CallRealtime;
  log: FastifyBaseLogger;
}

/** What a hold, a transfer or a cancel came to. */
export type CallControlResult<T = unknown> =
  | ({ ok: true; conversationUuid: string } & T)
  | { ok: false; refusal: CallControlRefusal };

/** What a grant request came to: the token to dial with, or why not. */
export type OutboundGrantResult =
  | { ok: true; grant: string; expiresInSeconds: number }
  | { ok: false; refusal: OutboundGrantRefusal };

export interface OutboundCallRequest {
  /** The agent's own Twilio client leg. */
  callSid: string;
  /** Twilio's caller, `client:<identity>` for a softphone; the browser can set it. */
  from: string | undefined;
  /** The grant token the softphone passed with the call, if it passed one. */
  grant: string | undefined;
}

export interface InboundCallRequest {
  /** The caller's leg. */
  callSid: string;
  from: string;
  to: string;
}

export interface RecordingReadyNotice {
  conversationUuid: string;
  recordingUrl: string;
  duration?: number;
  /** `conference` for the call itself, otherwise the voicemail reason. */
  context?: string;
}

export interface TranscriptionReadyNotice {
  conversationUuid: string;
  transcript: string;
  recordingUrl?: string;
  context?: string;
}

export interface ConferenceNotice {
  conversationUuid: string;
  conferenceSid?: string;
  /** Twilio's `StatusCallbackEvent`, e.g. `participant-join`. */
  event: string;
  legUuid?: string;
  participantLabel?: string;
  duration?: number;
}

export interface CallStatusNotice {
  conversationUuid: string;
  legUuid: string;
  participantLabel?: string;
  /** Twilio's `CallStatus`. */
  status: string;
  duration?: number;
}

export class CallFlow {
  constructor(private readonly deps: CallFlowDependencies) {}

  /**
   * An agent is about to dial a number from the softphone and asks whether
   * they may, from that line. Resolves to a grant the call is then placed on,
   * or to why not. The line's routing entry decides, without the database.
   */
  async grantOutboundCall(
    request: OutboundGrantRequest,
  ): Promise<OutboundGrantResult> {
    const { telephony, routing } = this.deps;

    const decision = decideOutboundGrant(
      request,
      await routing.lookupByPhone(request.fromNumber),
      new Date(),
    );
    if (decision.action === 'refuse') {
      this.deps.log.warn(
        {
          userId: request.userId,
          refusal: decision.reason,
          phoneNumberLast4: maskPhoneNumber(request.fromNumber),
        },
        'Refused an outbound call grant',
      );
      return { ok: false, refusal: decision.reason };
    }

    const grant = await telephony.issueOutboundGrant(decision.grant);
    return { ok: true, grant, expiresInSeconds: OUTBOUND_GRANT.TTL_SECONDS };
  }

  /**
   * An agent dialed a number from the softphone, and Twilio asks what to do
   * with their leg. Resolves to TwiML for it: the conference the other party
   * is dialed into, or the reason the call was refused. Who is calling, whom
   * and from where come from the grant the call carries; a call without a
   * usable one dials nobody and leaves no record.
   */
  async startOutboundCall(request: OutboundCallRequest): Promise<string> {
    const { callSid, from } = request;
    const { telephony, events, realtime } = this.deps;

    const admission = admitOutboundCall(
      request.grant ? await telephony.takeOutboundGrant(request.grant) : null,
      from,
      new Date(),
    );
    if (admission.action === 'refuse') {
      this.deps.log.warn(
        {
          conversationUuid: callSid,
          // A softphone's caller is `client:<user id>`; anything else is the
          // browser's doing and may be a number, so only its end is logged.
          caller: from?.startsWith('client:')
            ? from
            : maskPhoneNumber(from ?? ''),
          reason: admission.reason,
        },
        'Refused an outbound call',
      );
      return telephony.buildOutboundRefusalTwiml(admission.reason);
    }

    const { grant } = admission;
    const agentUserId = grant.userId;
    const state: CallState = {
      conversationUuid: callSid,
      conversationName: conversationNameFor(callSid),
      direction: 'outbound',
      routingType: 'OUTBOUND',
      from: grant.fromNumber,
      to: grant.to,
      departmentId: grant.departmentId,
      departmentName: grant.departmentName,
      targetUserId: agentUserId,
      activeAgentUserId: agentUserId,
      agentLegUuid: callSid,
      agentLegs: { [callSid]: agentUserId },
      pendingAgentLegUuids: [],
      answered: false,
      voicemail: false,
      ending: false,
      createdAt: new Date().toISOString(),
    };
    const agent: CallParticipant = {
      participantType: 'agent',
      participantId: agentUserId,
    };

    await telephony.saveCallState(state);
    await telephony.setLegMetadata(callSid, {
      conversationUuid: callSid,
      ...agent,
    });
    await realtime.trackCallParticipants(callSid, [agentUserId]);
    await events.callIncoming({
      conversationUuid: callSid,
      from: grant.fromNumber,
      to: grant.to,
      direction: 'outbound',
      agentLegUuid: callSid,
      departmentId: grant.departmentId,
      userId: agentUserId,
    });

    // The agent's leg must get its TwiML now; the outside number is dialed
    // while the agent waits in the conference.
    this.inBackground(
      telephony
        .createExternalLeg(callSid, grant.to, { fromNumber: grant.fromNumber })
        .catch(async (error) => {
          const latest = await telephony.getCallState(callSid);
          if (!latest || latest.ending) {
            return;
          }

          this.deps.log.error(
            { err: error, conversationUuid: callSid },
            'Failed to dial the outbound number',
          );
          await telephony.hangupConversation(callSid);
          await this.finalize(latest, 'failed');
        }),
      'outbound dial',
    );

    return telephony.buildConferenceTwiml(state, agent);
  }

  /** Someone called one of our numbers. Resolves to TwiML for the caller's leg. */
  async acceptInboundCall(request: InboundCallRequest): Promise<string> {
    const { callSid, from, to } = request;
    const { telephony, events, routing } = this.deps;

    const caller: CallParticipant = {
      participantType: 'caller',
      participantId: from,
    };
    const base: CallState = {
      conversationUuid: callSid,
      conversationName: conversationNameFor(callSid),
      direction: 'inbound',
      routingType: 'DEPARTMENT',
      from,
      to,
      callerLegUuid: callSid,
      agentLegs: {},
      pendingAgentLegUuids: [],
      answered: false,
      voicemail: false,
      ending: false,
      createdAt: new Date().toISOString(),
    };

    const routed = await routing.lookupByPhone(to);
    if (!routed) {
      const state: CallState = { ...base, voicemail: true };
      await telephony.saveCallState(state);
      await telephony.setLegMetadata(callSid, {
        conversationUuid: callSid,
        ...caller,
      });
      await events.callIncoming({
        conversationUuid: callSid,
        from,
        to,
        direction: 'inbound',
        callerLegUuid: callSid,
      });
      this.deps.log.warn(
        { conversationUuid: callSid, phoneNumberLast4: maskPhoneNumber(to) },
        'Inbound call to a number with no routing',
      );
      return telephony.buildVoicemailTwiml(state, 'missing-routing');
    }

    const plan = planInboundCall(routed);
    const configuredGreeting = routed.settings?.voicemailGreetingUrl;
    const voicemailGreetingUrl = usableGreetingUrl(configuredGreeting);
    if (configuredGreeting && !voicemailGreetingUrl) {
      // Otherwise a greeting the admin can see configured would go unplayed
      // with nothing to say why. The value is whatever the cache held, not
      // necessarily a URL, so only its length is logged.
      this.deps.log.warn(
        {
          conversationUuid: callSid,
          departmentId: routed.departmentId,
          greetingUrlLength: configuredGreeting.length,
        },
        'Ignoring a voicemail greeting that is not an http(s) URL',
      );
    }

    const state: CallState = {
      ...base,
      routingType: routed.type,
      departmentId: routed.departmentId,
      departmentName: routed.departmentName,
      targetUserId: routed.userId,
      targetUserName: routed.userName,
      routingQueue: plan.action === 'ring' ? plan.userIds : undefined,
      currentQueueIndex: 0,
      ringStrategy: plan.action === 'ring' ? plan.strategy : undefined,
      ringDuration: routed.settings?.ringDuration,
      voicemailGreetingUrl,
    };

    await telephony.saveCallState(state);
    await telephony.setLegMetadata(callSid, {
      conversationUuid: callSid,
      ...caller,
    });
    await events.callIncoming({
      conversationUuid: callSid,
      from,
      to,
      direction: 'inbound',
      callerLegUuid: callSid,
      departmentId: routed.departmentId,
      userId: routed.userId,
    });

    switch (plan.action) {
      case 'voicemail':
        return this.voicemailInsteadOfRinging(state, plan.reason);
      case 'forward':
        this.forwardToExternalNumber(state, plan);
        return telephony.buildConferenceTwiml(state, caller);
      case 'ring': {
        const ringing =
          plan.strategy === 'FIXED_ORDER'
            ? await this.ringNextInOrder(state)
            : (await this.ringAllAtOnce(state, plan.userIds)).length > 0;

        return ringing
          ? telephony.buildConferenceTwiml(state, caller)
          : this.voicemailInsteadOfRinging(state, plan.whenNobodyIsOnline);
      }
    }
  }

  /** Twilio finished a recording; only voicemail recordings end the call. */
  async handleRecordingReady(notice: RecordingReadyNotice): Promise<void> {
    if (!notice.context) {
      return;
    }

    const context = recordingContextOf(notice.context);
    await this.deps.events.callRecordingReady({
      conversationUuid: notice.conversationUuid,
      recordingUrl: notice.recordingUrl,
      duration: notice.duration,
      context,
    });

    if (context !== 'voicemail') {
      return;
    }

    const state = await this.deps.telephony.getCallState(
      notice.conversationUuid,
    );
    if (state) {
      await this.finalize(state, 'completed');
    }
  }

  async handleTranscriptionReady(
    notice: TranscriptionReadyNotice,
  ): Promise<void> {
    await this.deps.events.callTranscriptionReady({
      conversationUuid: notice.conversationUuid,
      transcript: notice.transcript.trim(),
      recordingUrl: notice.recordingUrl,
      context: notice.context ? recordingContextOf(notice.context) : undefined,
    });
  }

  /** A conference status callback: someone joined or left the call. */
  async handleConferenceEvent(notice: ConferenceNotice): Promise<void> {
    const { telephony } = this.deps;
    const { conversationUuid, legUuid } = notice;

    if (notice.conferenceSid) {
      await telephony.ensureConferenceReference(
        conversationUuid,
        notice.conferenceSid,
      );
    }

    const joined = notice.event === 'participant-join';
    const left = notice.event === 'participant-leave';
    if ((!joined && !left) || !legUuid) {
      return;
    }

    const state = await telephony.getCallState(conversationUuid);
    if (!state) {
      return;
    }

    const participant = await this.resolveParticipant(
      state,
      legUuid,
      notice.participantLabel,
    );
    if (!participant) {
      return;
    }

    if (joined) {
      await telephony.setLegMetadata(legUuid, {
        conversationUuid,
        ...participant,
      });
      await this.publishParticipantStatus(
        state,
        legUuid,
        participant,
        'answered',
      );
      await this.onParticipantJoined(state, participant, legUuid);
      return;
    }

    if (!legUuidsOf(state).includes(legUuid)) {
      return;
    }

    // Leaving the conference for voicemail is not hanging up: the caller is
    // still on the line recording. Their own status callback ends the call.
    if (
      participant.participantType === 'caller' &&
      state.voicemail &&
      !state.ending
    ) {
      return;
    }

    await this.publishParticipantStatus(
      state,
      legUuid,
      participant,
      'completed',
    );
    await this.onLegEnded(
      state,
      participant,
      legUuid,
      'completed',
      notice.duration,
    );
  }

  /** A call status callback for one leg (initiated, ringing, answered, ended). */
  async handleCallStatus(notice: CallStatusNotice): Promise<void> {
    const { telephony } = this.deps;
    const { conversationUuid, legUuid } = notice;

    const status = normalizeCallStatus(notice.status);
    if (!status) {
      return;
    }

    const state = await telephony.getCallState(conversationUuid);
    if (!state) {
      return;
    }

    const participant = await this.resolveParticipant(
      state,
      legUuid,
      notice.participantLabel,
    );
    if (!participant) {
      return;
    }

    // Twilio reports a leg's end twice (conference leave and call status);
    // a leg the call no longer tracks has already been handled. A transfer
    // stops tracking the legs it releases before they are gone, so what is
    // still known about such a leg is forgotten here.
    if (isTerminalStatus(status) && !legUuidsOf(state).includes(legUuid)) {
      await telephony.deleteLegMetadata([legUuid]);
      return;
    }

    await this.publishParticipantStatus(
      state,
      legUuid,
      participant,
      status,
      notice.duration,
    );

    if (isTerminalStatus(status)) {
      await this.onLegEnded(
        state,
        participant,
        legUuid,
        status,
        notice.duration,
      );
    }
  }

  // Call control -------------------------------------------------------------

  /** The agent on the call holds the other party, or brings them back. */
  async holdCall(
    request: CallControlRequest,
    hold: boolean,
  ): Promise<CallControlResult<{ held: boolean }>> {
    const call = await this.loadControlledCall(request);
    if (!call.ok) {
      return call;
    }

    const refusal = refuseHold(call.state, call.leg, request);
    if (refusal) {
      return { ok: false, refusal };
    }

    const { conversationUuid } = call.state;
    try {
      const held = await this.setHold(conversationUuid, hold, request.userId);
      return held === null
        ? { ok: false, refusal: 'call-gone' }
        : { ok: true, conversationUuid, held };
    } catch (error) {
      this.deps.log.warn(
        { err: error, conversationUuid, hold },
        'Failed to change the hold on a call',
      );
      return { ok: false, refusal: 'provider-error' };
    }
  }

  /**
   * The agent on the call hands it to a teammate: the other party waits on
   * hold while the teammate's softphone rings. Resolves once it rings; how it
   * ends is told to both softphones when the teammate's leg joins or is gone.
   */
  async transferCall(
    request: CallControlRequest,
    targetUserId: string,
  ): Promise<CallControlResult<{ targetUserId: string }>> {
    const { telephony, realtime, log } = this.deps;

    const call = await this.loadControlledCall(request);
    if (!call.ok) {
      return call;
    }

    const { state } = call;
    const refusal = refuseTransfer(state, call.leg, request, targetUserId);
    if (refusal) {
      return { ok: false, refusal };
    }

    // A ring the teammate lost when this call was answered may not have been
    // reported gone yet. It is forgotten first, so that its end is not taken
    // for the end of the ring this transfer is about to start.
    const lostRingLegUuids = Object.entries(state.agentLegs)
      .filter(([, userId]) => userId === targetUserId)
      .map(([legUuid]) => legUuid);
    for (const legUuid of lostRingLegUuids) {
      removeLeg(state, legUuid);
    }

    // Marked before anything is awaited on, so that a second request is
    // refused and a decline that comes straight back from the offer finds
    // the transfer it belongs to.
    const { conversationUuid } = state;
    state.pendingTransferToUserId = targetUserId;
    state.transferInitiatedBy = request.userId;
    state.transferOriginLegUuid = request.legUuid;
    await telephony.saveCallState(state);
    await Promise.all(
      lostRingLegUuids.map((legUuid) => telephony.safeHangup(legUuid)),
    );

    // The call is marked from here on, and a marked call refuses holds and
    // further transfers and lets its agent leave without ending it. Whatever
    // throws below therefore takes the mark back before it answers.
    try {
      const reached = await realtime.notifyIncomingCall(
        [targetUserId],
        transferOfferOf(state, request.userId),
      );
      if (reached.length === 0) {
        // Nothing was held and nobody was told, so nobody needs to hear of
        // it; the caller is still rescued if the agent left in the meantime.
        await this.failPendingTransfer(conversationUuid, targetUserId, null);
        return { ok: false, refusal: 'target-offline' };
      }

      // Nobody is rung for a party who is not waiting: a teammate who
      // answered would walk into the conversation the agent is still having.
      const held = await this.setHold(conversationUuid, true, request.userId);
      if (held !== true) {
        await this.failPendingTransfer(
          conversationUuid,
          targetUserId,
          'unavailable',
        );
        return {
          ok: false,
          refusal: held === null ? 'call-gone' : 'provider-error',
        };
      }

      const ringingLegUuid = await telephony.transferConversation(
        conversationUuid,
        targetUserId,
        request.userId,
      );

      // The teammate may have declined, or the agent cancelled, while Twilio
      // was holding and ringing. Whoever did has already settled the
      // transfer; what is left is the ring and the hold that landed after
      // they did. A teammate who answered at once settled it too, and their
      // leg stays.
      const latest = await telephony.getCallState(conversationUuid);
      const alreadyAnswered =
        ringingLegUuid !== null && latest?.agentLegUuid === ringingLegUuid;
      const stillPending =
        latest?.pendingTransferToUserId === targetUserId &&
        latest.transferInitiatedBy === request.userId;
      if (!alreadyAnswered && !stillPending) {
        if (ringingLegUuid) {
          await telephony.safeHangup(ringingLegUuid);
        }
        if (latest && !latest.ending && !latest.pendingTransferToUserId) {
          await this.resumeAfterTransfer(conversationUuid);
        }
        return { ok: false, refusal: 'no-transfer-pending' };
      }
    } catch (error) {
      log.warn(
        { err: error, conversationUuid, targetUserId },
        'Failed to ring the teammate a call is being transferred to',
      );
      await this.failPendingTransfer(
        conversationUuid,
        targetUserId,
        'unavailable',
      );
      return { ok: false, refusal: 'provider-error' };
    }

    log.info(
      { conversationUuid, targetUserId, initiatedBy: request.userId },
      'Transfer is ringing',
    );
    return { ok: true, conversationUuid, targetUserId };
  }

  /** The agent who started a transfer takes the call back while it rings. */
  async cancelTransfer(
    request: CallControlRequest,
  ): Promise<CallControlResult> {
    const call = await this.loadControlledCall(request);
    if (!call.ok) {
      return call;
    }

    const { state } = call;
    const refusal = refuseTransferCancel(state, call.leg, request);
    if (refusal || !state.pendingTransferToUserId) {
      return { ok: false, refusal: refusal ?? 'no-transfer-pending' };
    }

    const { conversationUuid } = state;
    const cancelled = await this.failPendingTransfer(
      conversationUuid,
      state.pendingTransferToUserId,
      'cancelled',
    );

    // The teammate answered, or their leg ended, a moment before this.
    return cancelled
      ? { ok: true, conversationUuid }
      : { ok: false, refusal: 'no-transfer-pending' };
  }

  /**
   * A softphone turned down a call it was offered. Turning down a transfer
   * sends the other party back to the agent who is handing them over. Any
   * other offer means "stop ringing me" and nothing more: only the legs
   * ringing this user end, and the ring goes on as the department's routing
   * says, so one member cannot hang up on a caller everybody else is still
   * being offered. Once somebody has answered, the offer is stale.
   *
   * Only a user this call is actually ringing may decline it: the conversation
   * id alone is no claim to the call.
   */
  async declineOfferedCall(
    conversationUuid: string,
    userId: string,
  ): Promise<void> {
    const { telephony, log } = this.deps;

    const state = await telephony.getCallState(conversationUuid);
    if (!state) {
      return;
    }

    if (state.pendingTransferToUserId === userId) {
      await this.failPendingTransfer(conversationUuid, userId, 'declined');
      return;
    }

    if (state.answered) {
      return;
    }

    const ringingLegUuids = state.pendingAgentLegUuids.filter(
      (legUuid) => state.agentLegs[legUuid] === userId,
    );
    if (ringingLegUuids.length === 0) {
      this.refuseDecline(state, userId);
      return;
    }

    // Their legs, and nothing else. Each leg's own status callback then
    // removes it and decides what follows, which is the same path a ring that
    // timed out takes: the next member of a fixed order, or the caller to
    // voicemail once nobody is left. Writing the state here as well would put
    // a second writer against that callback, and `CallState` has no version
    // to settle who wins.
    await Promise.all(
      ringingLegUuids.map((legUuid) => telephony.safeHangup(legUuid)),
    );

    log.info(
      { conversationUuid, userId, legs: ringingLegUuids.length },
      'Agent declined an offered call; their ring ends and the call goes on',
    );
  }

  /**
   * A decline with no ring of this user's to end: their leg is already gone,
   * or has not been dialed yet, or they are nothing to do with the call.
   * Nothing changes either way; what differs is whether it deserves attention,
   * so somebody this call could have rung is not reported as an outsider. No
   * phone number is logged: the numbers here are the caller's, and the sender
   * may be a stranger to them.
   */
  private refuseDecline(state: CallState, userId: string): void {
    const inTheRing =
      state.targetUserId === userId ||
      (state.routingQueue ?? []).includes(userId) ||
      Object.values(state.agentLegs).includes(userId);
    const context = { conversationUuid: state.conversationUuid, userId };

    if (inTheRing) {
      this.deps.log.info(
        context,
        'Ignored a decline from a member with no ringing leg on this call',
      );
      return;
    }

    this.deps.log.warn(
      context,
      'Refused a decline from a user this call never rang',
    );
  }

  private async loadControlledCall(
    request: CallControlRequest,
  ): Promise<
    | { ok: true; state: CallState; leg: LegMetadata }
    | { ok: false; refusal: CallControlRefusal }
  > {
    const { telephony } = this.deps;

    const leg = await telephony.getLegMetadata(request.legUuid);
    if (!leg) {
      return { ok: false, refusal: 'leg-not-found' };
    }

    const state = await telephony.getCallState(leg.conversationUuid);
    return state
      ? { ok: true, state, leg }
      : { ok: false, refusal: 'call-gone' };
  }

  /**
   * Hold or resume the other party and record it. Twilio is asked even when
   * the state already says so: the flag can trail a request that is still in
   * flight, and an agent must never be told the other party is waiting while
   * they can in fact hear. Resolves to what Twilio answered, or to null when
   * the party is gone.
   */
  private async setHold(
    conversationUuid: string,
    hold: boolean,
    userId?: string,
  ): Promise<boolean | null> {
    const held = await this.deps.telephony.holdConversation(
      conversationUuid,
      hold,
    );
    if (held === null) {
      return null;
    }

    // The line has changed by now, so that is the answer even when writing
    // it down fails: an agent told the hold did not happen would talk to
    // someone who hears music. The timeline misses the entry, and the flag
    // is put right by the next hold or resume.
    try {
      await this.recordHold(conversationUuid, held, userId);
    } catch (error) {
      this.deps.log.error(
        { err: error, conversationUuid, held },
        'Failed to record a hold that Twilio has applied',
      );
    }

    return held;
  }

  private async recordHold(
    conversationUuid: string,
    held: boolean,
    userId?: string,
  ): Promise<void> {
    const { telephony, events } = this.deps;

    const latest = await telephony.getCallState(conversationUuid);
    if (!latest || latest.ending || Boolean(latest.held) === held) {
      return;
    }

    latest.held = held;
    await telephony.saveCallState(latest);

    const event = { conversationUuid, userId, legUuid: remoteLegOf(latest) };
    await (held ? events.callHeld(event) : events.callResumed(event));
  }

  /**
   * A transfer settled with the other party still on hold: let them talk
   * again. It must not throw, because what follows it (telling the agents,
   * releasing a leg) still has to happen when Twilio refuses.
   */
  private async resumeAfterTransfer(conversationUuid: string): Promise<void> {
    try {
      await this.setHold(conversationUuid, false);
    } catch (error) {
      this.deps.log.error(
        { err: error, conversationUuid },
        'Failed to take the other party off hold after a transfer',
      );
    }
  }

  /** A softphone that misses this still has its call; it only lacks the reason. */
  private async tellTransferOutcome(
    userIds: Array<string | undefined>,
    outcome: CallTransferOutcome,
  ): Promise<void> {
    const recipients = userIds.filter((userId): userId is string =>
      Boolean(userId),
    );

    try {
      await this.deps.realtime.notifyTransferOutcome(recipients, outcome);
    } catch (error) {
      this.deps.log.warn(
        { err: error, conversationUuid: outcome.conversationUuid },
        'Failed to tell the softphones how a transfer ended',
      );
    }
  }

  /**
   * The transfer to this teammate is off: they declined, did not answer,
   * could not be rung, or the agent cancelled. Their ringing legs are hung
   * up and the other party goes where `planTransferFailure` says. Resolves to
   * false when the transfer had already been settled by someone else. A
   * `null` reason is for a transfer that fell through before the other party
   * was held or the teammate was offered it: no hold to end, nobody to tell.
   */
  private async failPendingTransfer(
    conversationUuid: string,
    targetUserId: string,
    reason: TransferFailureReason | null,
  ): Promise<boolean> {
    const { telephony, events } = this.deps;

    const state = await telephony.getCallState(conversationUuid);
    if (
      !state ||
      state.ending ||
      state.pendingTransferToUserId !== targetUserId
    ) {
      return false;
    }

    const plan = planTransferFailure(state);
    const wasHeld = Boolean(state.held);
    const initiatedBy = state.transferInitiatedBy;
    const ringingLegUuids = Object.entries(state.agentLegs)
      .filter(
        ([legUuid, userId]) =>
          userId === targetUserId && legUuid !== state.agentLegUuid,
      )
      .map(([legUuid]) => legUuid);

    state.pendingTransferToUserId = undefined;
    state.transferInitiatedBy = undefined;
    state.transferOriginLegUuid = undefined;
    await telephony.saveCallState(state);

    switch (plan) {
      case 'return-to-agent':
        await Promise.all(
          ringingLegUuids.map((legUuid) => telephony.safeHangup(legUuid)),
        );
        if (reason) {
          await this.resumeAfterTransfer(conversationUuid);
        }
        break;
      // Both of these hang up the teammate's legs with every other agent leg.
      case 'voicemail':
        // Leaving the conference for voicemail is what ends the hold, so
        // there is no participant to resume; the timeline still hears of it.
        state.held = false;
        await this.routeCallerToVoicemail(state, 'routing-timeout');
        if (wasHeld && state.voicemail) {
          await events.callResumed({
            conversationUuid,
            legUuid: state.callerLegUuid,
          });
        }
        break;
      case 'end-call':
        await telephony.requestConversationHangup(conversationUuid);
        break;
    }

    if (reason) {
      await this.tellTransferOutcome([initiatedBy, targetUserId], {
        conversationUuid,
        targetUserId,
        status: 'failed',
        reason,
      });
    }

    this.deps.log.info(
      { conversationUuid, targetUserId, reason, plan },
      'Transfer did not go through',
    );
    return true;
  }

  /**
   * The teammate answered. The other party comes off hold to talk to them,
   * and only then is the agent who handed the call over released: told first,
   * because their softphone sees a released leg as any other hangup.
   */
  private async completeTransfer(
    conversationUuid: string,
    transfer: {
      fromUserId: string;
      toUserId: string;
      answeredLegUuid: string;
      initiatedBy: string | undefined;
      /** The leg handing the call over, and any second ring of the teammate. */
      releasedLegUuids: string[];
    },
  ): Promise<void> {
    const { telephony, events } = this.deps;

    await this.resumeAfterTransfer(conversationUuid);
    await this.tellTransferOutcome([transfer.initiatedBy], {
      conversationUuid,
      targetUserId: transfer.toUserId,
      status: 'completed',
    });

    await Promise.all(
      transfer.releasedLegUuids.map((legUuid) => telephony.safeHangup(legUuid)),
    );

    await events.callTransferred({
      conversationUuid,
      fromUserId: transfer.fromUserId,
      toUserId: transfer.toUserId,
      agentLegUuid: transfer.answeredLegUuid,
    });
  }

  /** A leg is gone: forget it, then decide what happens to the rest of the call. */
  private async onLegEnded(
    state: CallState,
    participant: CallParticipant,
    legUuid: string,
    status: CallEndStatus,
    duration: number | undefined,
  ): Promise<void> {
    await this.deps.telephony.deleteLegMetadata([legUuid]);

    if (state.ending) {
      await this.tearDownLeg(state, legUuid, status, duration);
      return;
    }

    await this.onParticipantLeft(
      state,
      participant,
      legUuid,
      status,
      duration ?? 0,
    );
  }

  // Ringing ------------------------------------------------------------------

  private async ringAllAtOnce(
    state: CallState,
    userIds: string[],
  ): Promise<string[]> {
    if (state.ending) {
      return [];
    }

    const online = await this.deps.realtime.notifyIncomingCall(
      userIds,
      incomingCallOf(state),
    );

    const legs = await this.deps.telephony.ringAgents(
      state.conversationUuid,
      online,
      { fromNumber: state.to, ringingTimer: state.ringDuration },
    );

    return legs.map((leg) => leg.userId);
  }

  /** Ring the next user in the queue who is online. Resolves to false when nobody is. */
  private async ringNextInOrder(state: CallState): Promise<boolean> {
    if (state.ending) {
      return false;
    }

    const queue = state.routingQueue ?? [];

    for (
      let index = state.currentQueueIndex ?? 0;
      index < queue.length;
      index += 1
    ) {
      const userId = queue[index];
      if (!userId) {
        continue;
      }

      state.currentQueueIndex = index;
      await this.deps.telephony.saveCallState(state);

      const online = await this.deps.realtime.notifyIncomingCall(
        [userId],
        incomingCallOf(state),
      );
      if (online.length === 0) {
        continue;
      }

      try {
        await this.ringAgent(state, userId);
        return true;
      } catch {
        // Already logged by ringAgent; move on to the next user.
      }
    }

    return false;
  }

  private async ringAgent(state: CallState, userId: string): Promise<string> {
    try {
      return await this.deps.telephony.createAgentLeg(
        state.conversationUuid,
        userId,
        { fromNumber: state.to, ringingTimer: state.ringDuration },
      );
    } catch (error) {
      this.deps.log.warn(
        { err: error, conversationUuid: state.conversationUuid, userId },
        'Failed to ring agent',
      );
      throw error;
    }
  }

  private forwardToExternalNumber(
    state: CallState,
    plan: Extract<InboundCallPlan, { action: 'forward' }>,
  ): void {
    const { telephony } = this.deps;
    const { conversationUuid } = state;

    this.inBackground(
      telephony
        .createExternalLeg(conversationUuid, plan.phoneNumber, {
          fromNumber: state.to,
          ringingTimer: plan.ringDuration,
        })
        .catch(async (error) => {
          const latest = await telephony.getCallState(conversationUuid);
          if (!latest || latest.ending) {
            return;
          }

          this.deps.log.error(
            { err: error, conversationUuid },
            'Failed to forward the call to the external number',
          );
          await this.routeCallerToVoicemail(latest, 'closed-hours-external');
        }),
      'forward to external number',
    );
  }

  // Voicemail and teardown ---------------------------------------------------

  /** Nobody can take the call before it was even offered: answer with voicemail. */
  private async voicemailInsteadOfRinging(
    state: CallState,
    reason: VoicemailReason,
  ): Promise<string> {
    state.voicemail = true;
    await this.deps.telephony.saveCallState(state);
    await this.deps.events.callMissed({
      conversationUuid: state.conversationUuid,
      from: state.from,
      to: state.to,
      departmentId: state.departmentId,
      userId: state.targetUserId,
    });

    return this.deps.telephony.buildVoicemailTwiml(state, reason);
  }

  /** The caller is already in the conference: pull them out into voicemail. */
  private async routeCallerToVoicemail(
    state: CallState,
    reason: VoicemailReason,
  ): Promise<void> {
    const { telephony, events } = this.deps;

    if (!state.callerLegUuid || state.ending || state.voicemail) {
      return;
    }

    await Promise.all(
      Object.keys(state.agentLegs).map((legUuid) =>
        telephony.safeHangup(legUuid),
      ),
    );
    if (state.externalLegUuid) {
      await telephony.safeHangup(state.externalLegUuid);
    }

    state.voicemail = true;
    state.pendingAgentLegUuids = [];
    state.agentLegs = {};
    state.agentLegUuid = undefined;
    state.externalLegUuid = undefined;
    await telephony.saveCallState(state);

    // A call an agent talked on was not missed, even when the transfer that
    // followed fell through and voicemail is where the caller ends up.
    if (!state.answered) {
      await events.callMissed({
        conversationUuid: state.conversationUuid,
        from: state.from,
        to: state.to,
        departmentId: state.departmentId,
        userId: state.targetUserId,
      });
    }

    await telephony.redirectLegToVoicemail(state.callerLegUuid, state, reason);
  }

  /** The call is over: tell the API and forget the state. */
  private async finalize(
    state: CallState,
    status: CallEndStatus,
    duration = 0,
  ): Promise<void> {
    const { telephony, events } = this.deps;

    await events.callEnded({
      conversationUuid: state.conversationUuid,
      duration,
      status,
      callerLegUuid: state.callerLegUuid,
      agentLegUuid: state.agentLegUuid,
      externalLegUuid: state.externalLegUuid,
    });

    await telephony.deleteLegMetadata(legUuidsOf(state));
    await telephony.deleteCallState(state.conversationUuid);
  }

  /** Hang up everyone except the leg that just left. */
  private async hangUpOtherLegs(
    state: CallState,
    leftLegUuid: string,
  ): Promise<void> {
    await Promise.all(
      legUuidsOf(state)
        .filter((legUuid) => legUuid !== leftLegUuid)
        .map((legUuid) => this.deps.telephony.safeHangup(legUuid)),
    );
  }

  /** While a hangup is in progress, legs drop one by one; the last one finalizes. */
  private async tearDownLeg(
    state: CallState,
    legUuid: string,
    status: CallEndStatus,
    duration: number | undefined,
  ): Promise<void> {
    removeLeg(state, legUuid);

    if (hasActiveLegs(state)) {
      await this.deps.telephony.saveCallState(state);
    } else {
      await this.finalize(state, status, duration);
    }
  }

  // Participants -------------------------------------------------------------

  private async onParticipantJoined(
    state: CallState,
    participant: CallParticipant,
    legUuid: string,
  ): Promise<void> {
    const { telephony, events } = this.deps;

    switch (participant.participantType) {
      case 'caller': {
        if (state.callerLegUuid !== legUuid) {
          state.callerLegUuid = legUuid;
          await telephony.saveCallState(state);
        }
        return;
      }

      case 'agent': {
        const agentUserId = participant.participantId;
        const wasAnswered = state.answered;
        const previousAgentUserId = state.activeAgentUserId;
        const isTransferTarget = state.pendingTransferToUserId === agentUserId;

        // Someone already has this call and it is not being handed to this
        // agent: they answered a ring that lost the race, or a transfer that
        // was cancelled as they picked up. Taking the call over would leave
        // two agents on it and end it for everyone when this one hangs up.
        if (
          wasAnswered &&
          !isTransferTarget &&
          previousAgentUserId !== undefined &&
          previousAgentUserId !== agentUserId
        ) {
          this.deps.log.info(
            { conversationUuid: state.conversationUuid, legUuid, agentUserId },
            'Released an agent who joined a call that was not theirs to take',
          );
          await telephony.safeHangup(legUuid);
          return;
        }

        const transfer =
          isTransferTarget && previousAgentUserId
            ? {
                fromUserId: state.transferInitiatedBy ?? previousAgentUserId,
                toUserId: agentUserId,
                answeredLegUuid: legUuid,
                initiatedBy: state.transferInitiatedBy,
                releasedLegUuids: Object.keys(state.agentLegs).filter(
                  (other) => other !== legUuid,
                ),
              }
            : null;

        state.agentLegUuid = legUuid;
        state.activeAgentUserId = agentUserId;
        state.pendingAgentLegUuids = state.pendingAgentLegUuids.filter(
          (pending) => pending !== legUuid,
        );
        if (transfer) {
          // Cleared in the same write that makes the teammate the agent, so
          // a webhook delivered twice completes the transfer once, and a
          // decline or a cancel arriving now finds nothing left to undo.
          state.pendingTransferToUserId = undefined;
          state.transferInitiatedBy = undefined;
          state.transferOriginLegUuid = undefined;
          for (const released of transfer.releasedLegUuids) {
            delete state.agentLegs[released];
          }
        }
        await telephony.saveCallState(state);

        if (!wasAnswered && state.direction === 'inbound') {
          state.answered = true;
          await telephony.saveCallState(state);
          await events.callStarted({
            conversationUuid: state.conversationUuid,
            from: state.from,
            to: state.to,
            userId: agentUserId,
            departmentId: state.departmentId,
            direction: state.direction,
            agentLegUuid: legUuid,
            externalLegUuid: state.externalLegUuid,
          });

          // First to answer wins; stop ringing everyone else.
          await Promise.all(
            Object.keys(state.agentLegs)
              .filter((other) => other !== legUuid)
              .map((other) => telephony.safeHangup(other)),
          );
        }

        if (transfer) {
          await this.completeTransfer(state.conversationUuid, transfer);
        }
        return;
      }

      case 'external': {
        const wasAnswered = state.answered;
        state.answered = true;
        state.externalLegUuid = legUuid;
        await telephony.saveCallState(state);

        if (!wasAnswered && state.direction === 'outbound') {
          await events.callStarted({
            conversationUuid: state.conversationUuid,
            from: state.from,
            to: state.to,
            userId: state.activeAgentUserId ?? state.targetUserId ?? 'unknown',
            departmentId: state.departmentId,
            direction: 'outbound',
            agentLegUuid: state.agentLegUuid,
            externalLegUuid: legUuid,
          });
        }
        return;
      }
    }
  }

  private async onParticipantLeft(
    state: CallState,
    participant: CallParticipant,
    legUuid: string,
    status: CallEndStatus,
    duration: number,
  ): Promise<void> {
    switch (participant.participantType) {
      case 'agent':
        await this.onAgentLeft(
          state,
          participant.participantId,
          legUuid,
          status,
          duration,
        );
        return;
      case 'external':
        await this.onExternalLeft(state, legUuid, status, duration);
        return;
      case 'caller':
        await this.hangUpOtherLegs(state, legUuid);
        await this.finalize(state, status, duration);
        return;
    }
  }

  private async onAgentLeft(
    state: CallState,
    agentUserId: string,
    legUuid: string,
    status: CallEndStatus,
    duration: number,
  ): Promise<void> {
    const { telephony } = this.deps;
    const wasActiveAgent = state.agentLegUuid === legUuid;

    removeLeg(state, legUuid);

    if (!state.answered) {
      await telephony.saveCallState(state);

      if (state.ringStrategy === 'FIXED_ORDER') {
        state.currentQueueIndex = (state.currentQueueIndex ?? 0) + 1;
        await telephony.saveCallState(state);

        if (await this.ringNextInOrder(state)) {
          return;
        }
      }

      if (state.pendingAgentLegUuids.length > 0) {
        return;
      }

      await this.routeCallerToVoicemail(state, 'routing-timeout');
      return;
    }

    if (wasActiveAgent && !state.pendingTransferToUserId) {
      await this.hangUpOtherLegs(state, legUuid);
      await this.finalize(state, status, duration);
      return;
    }

    await telephony.saveCallState(state);

    // The teammate's leg ended without an answer. A second ring of theirs
    // that is still out (the same transfer asked for twice) keeps it alive.
    const transferFellThrough =
      state.pendingTransferToUserId === agentUserId &&
      !Object.values(state.agentLegs).includes(agentUserId);
    if (transferFellThrough) {
      await this.failPendingTransfer(
        state.conversationUuid,
        agentUserId,
        transferFailureReasonOf(status),
      );
    }
  }

  private async onExternalLeft(
    state: CallState,
    legUuid: string,
    status: CallEndStatus,
    duration: number,
  ): Promise<void> {
    const { telephony } = this.deps;

    removeLeg(state, legUuid);

    if (state.direction === 'outbound') {
      await this.hangUpOtherLegs(state, legUuid);
      await this.finalize(state, status, duration);
      return;
    }

    if (!state.answered && state.callerLegUuid) {
      await this.routeCallerToVoicemail(state, 'closed-hours-external');
      return;
    }

    await this.finalize(state, status, duration);
  }

  private async resolveParticipant(
    state: CallState,
    legUuid: string,
    participantLabel: string | undefined,
  ): Promise<CallParticipant | null> {
    const labeled = this.deps.telephony.parseParticipantLabel(participantLabel);
    if (labeled) {
      return labeled;
    }

    const metadata = await this.deps.telephony.getLegMetadata(legUuid);
    if (metadata) {
      return {
        participantType: metadata.participantType,
        participantId: metadata.participantId,
      };
    }

    return participantOfLeg(state, legUuid);
  }

  private async publishParticipantStatus(
    state: CallState,
    legUuid: string,
    participant: CallParticipant,
    status: ParticipantStatus,
    duration?: number,
  ): Promise<void> {
    await this.deps.events.callParticipantStatus({
      conversationUuid: state.conversationUuid,
      legUuid,
      participantType: participant.participantType,
      participantId: participant.participantId,
      status,
      eventType: participantEventType(participant.participantType, status),
      description: participantDescription(
        participant.participantType,
        participant.participantId,
        status,
      ),
      duration,
    });
  }

  /** Work that outlives the webhook response; a failure must not go unnoticed. */
  private inBackground(work: Promise<unknown>, description: string): void {
    work.catch((error: unknown) => {
      this.deps.log.error({ err: error }, `Background ${description} failed`);
    });
  }
}

/**
 * Recording callbacks carry the voicemail reason or `conference`. The API
 * only distinguishes voicemails from recordings of the call itself.
 */
function recordingContextOf(context: string): 'voicemail' | 'conference' {
  return context === 'conference' ? 'conference' : 'voicemail';
}

function incomingCallOf(state: CallState): IncomingCall {
  return {
    conversationUuid: state.conversationUuid,
    from: state.from,
    to: state.to,
    callerId: state.from,
    routingType:
      state.routingType === 'OUTBOUND' ? undefined : state.routingType,
    departmentId: state.departmentId,
    departmentName: state.departmentName,
    userId: state.targetUserId,
    userName: state.targetUserName,
    metadata: { provider: 'twilio' },
  };
}
