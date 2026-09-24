import type {
  CallControlRefusal,
  CallEndStatus,
  CallTransferOutcome,
  IncomingCall,
  OutboundGrantRefusal,
  TransferFailureReason,
  UnavailableReason,
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
  transferRefusalOf,
} from './call-control.js';
import type { CallEventPublisher } from './call-events.js';
import {
  type CallParticipant,
  type CallState,
  conversationNameFor,
  hasActiveLegs,
  type LegMetadata,
  legUuidsOf,
  occupantsOf,
  participantOfLeg,
  removeLeg,
  usersLetGo,
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
import type {
  CallStateChange,
  CallStateUpdate,
  TelephonyService,
} from './telephony.service.js';

/*
 * The life of a call, from Twilio's first webhook to the `call:ended` event.
 * Twilio drives it: every method here answers one webhook, decides from the
 * call state what happens next, writes the state back, and only then acts on
 * what it decided. The agent on the call drives the rest: holding the other
 * party and handing the call to a teammate.
 *
 * A webhook, a softphone request and a socket message can all act on one
 * call at once. Every change is therefore written from the version of the
 * state it was decided on, and decided again from the current one when
 * another write landed in between (`TelephonyService.updateCallState`); a
 * pending transfer is settled by whoever clears its marker first, and the
 * ones that find it cleared step back.
 *
 * A call claims the users it occupies (`occupantsOf`), so that no other call
 * is offered to them meanwhile. The realtime layer keeps the claims; every
 * change here lets go of the users it stopped occupying.
 */

/** Who an offer reached, and why the others were left out. */
export interface CallOffer {
  /** Claimed for this call and shown the offer. */
  offered: string[];
  refused: Array<{ userId: string; reason: UnavailableReason }>;
}

/** What the flow needs from the realtime layer, without depending on it. */
export interface CallRealtime {
  /**
   * Offer the call to those of these users who can take it now, claiming
   * each one for this call before the offer goes out: until the claim is
   * released or runs out, no other call is offered to them. A user this call
   * already claims can be offered it again.
   */
  offerCall(userIds: string[], call: IncomingCall): Promise<CallOffer>;
  /**
   * Claim users for this call whatever their availability, for a call they
   * placed themselves: busy or on do not disturb, an agent may still dial.
   */
  occupy(conversationUuid: string, userIds: string[]): Promise<void>;
  /** Let go of users this call no longer occupies. */
  release(conversationUuid: string, userIds: string[]): Promise<void>;
  /** Keep the claims this call holds on these users from running out. */
  renew(conversationUuid: string, userIds: string[]): Promise<void>;
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
  | 'createCallState'
  | 'updateCallState'
  | 'liveCallIds'
  | 'forgetLiveCall'
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
  | 'fetchLegStatus'
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
    const agent: CallParticipant = {
      participantType: 'agent',
      participantId: agentUserId,
    };

    // Claimed without asking: an agent who is busy or on do not disturb may
    // still dial out, and nobody may offer them a call while they talk.
    await realtime.occupy(callSid, [agentUserId]);
    const state = await telephony.createCallState({
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
    });
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
          await this.finalize(callSid, 'failed');
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
    const base: Omit<CallState, 'version'> = {
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
      const state = await telephony.createCallState({
        ...base,
        voicemail: true,
      });
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

    const state = await telephony.createCallState({
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
    });
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
        // Busy and do-not-disturb members are left out like offline ones,
        // so a line whose people are all taken answers with its fallback
        // at once rather than ringing anybody.
        const ringing =
          plan.strategy === 'FIXED_ORDER'
            ? await this.ringNextInOrder(callSid)
            : (await this.ringAllAtOnce(state, plan.userIds)).length > 0;

        return ringing
          ? telephony.buildConferenceTwiml(state, caller)
          : this.voicemailInsteadOfRinging(state, plan.whenNobodyIsAvailable);
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

    await this.finalize(notice.conversationUuid, 'completed');
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
      await this.onParticipantJoined(conversationUuid, participant, legUuid);
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
      conversationUuid,
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
    // stops tracking a ring its teammate lost earlier before it is gone, so
    // what is still known about such a leg is forgotten here.
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
        conversationUuid,
        participant,
        legUuid,
        status,
        notice.duration,
      );
    }
  }

  /**
   * Keep the claims of every call still going from running out: each call's
   * current occupants are renewed, and claimed again if their claim already
   * ran out. A call whose state is gone leaves the live set, and whatever it
   * still claimed runs out on its own. One call that fails does not keep the
   * others from being renewed.
   *
   * With `reconcile`, Twilio is then asked about every leg of each call, and
   * a leg it says is over is handled as its lost status callback would have
   * been: a call nobody is left on ends, and lets its users go. Every call is
   * renewed before Twilio is asked about any, so a Twilio that is slow or
   * failing never leaves a user on a call unclaimed, least of all on the
   * round at start, which claims back what ran out while this service was
   * down.
   */
  async renewClaims({ reconcile = false } = {}): Promise<void> {
    const { telephony, log } = this.deps;
    const conversationUuids = await telephony.liveCallIds();

    for (const conversationUuid of conversationUuids) {
      try {
        await this.renewCall(conversationUuid);
      } catch (error) {
        log.warn(
          { err: error, conversationUuid },
          'Failed to renew the claims of a call',
        );
      }
    }

    if (!reconcile) {
      return;
    }

    for (const conversationUuid of conversationUuids) {
      try {
        await this.reconcileWithTwilio(conversationUuid);
      } catch (error) {
        log.warn(
          { err: error, conversationUuid },
          'Failed to reconcile a call with Twilio',
        );
      }
    }
  }

  private async reconcileWithTwilio(conversationUuid: string): Promise<void> {
    const { telephony } = this.deps;

    const state = await telephony.getCallState(conversationUuid);
    if (!state) {
      return;
    }

    const legs = await Promise.all(
      legUuidsOf(state).map(async (legUuid) => ({
        legUuid,
        ...(await telephony.fetchLegStatus(legUuid)),
      })),
    );
    // One leg at a time: each is decided on what the one before it left.
    for (const { legUuid, status, duration } of legs) {
      const normalized = normalizeCallStatus(status);
      if (normalized && isTerminalStatus(normalized)) {
        await this.handleCallStatus({
          conversationUuid,
          legUuid,
          status,
          duration,
        });
      }
    }
  }

  private async renewCall(conversationUuid: string): Promise<void> {
    const { telephony, realtime } = this.deps;

    const state = await telephony.getCallState(conversationUuid);
    if (!state) {
      await telephony.forgetLiveCall(conversationUuid);
      return;
    }

    const occupants = occupantsOf(state);
    if (occupants.length === 0) {
      return;
    }
    await realtime.renew(conversationUuid, occupants);

    // A renewal claims its users whether or not they still hold a claim, so
    // one that crossed a change letting somebody go has claimed them back.
    // The change released them before or after; if before, its version is
    // already here.
    const now = await telephony.getCallState(conversationUuid);
    if (now?.version !== state.version) {
      await this.letGo(conversationUuid, usersLetGo(state, now));
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
   * A teammate who is offline, busy or on do not disturb is refused here,
   * whatever the softphone showed when the agent picked them.
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

    // Checked and marked in one write, so that of two requests at once only
    // one finds the call free to hand over, and a decline that comes straight
    // back from the offer finds the transfer it belongs to.
    const { conversationUuid } = call.state;
    const marked = await this.changeCall<{
      refusal: CallControlRefusal | null;
      lostRingLegUuids: string[];
    }>(conversationUuid, (draft) => {
      const refusal = refuseTransfer(draft, call.leg, request, targetUserId);
      if (refusal) {
        return { result: { refusal, lostRingLegUuids: [] } };
      }

      // A ring the teammate lost when this call was answered may not have
      // been reported gone yet. It is forgotten first, so that its end is
      // not taken for the end of the ring this transfer is about to start.
      const lostRingLegUuids = Object.entries(draft.agentLegs)
        .filter(([, userId]) => userId === targetUserId)
        .map(([legUuid]) => legUuid);
      for (const legUuid of lostRingLegUuids) {
        removeLeg(draft, legUuid);
      }

      draft.pendingTransferToUserId = targetUserId;
      draft.transferInitiatedBy = request.userId;
      draft.transferOriginLegUuid = request.legUuid;
      return { result: { refusal: null, lostRingLegUuids } };
    });
    if (!marked?.after) {
      return { ok: false, refusal: 'call-gone' };
    }
    if (marked.result.refusal) {
      return { ok: false, refusal: marked.result.refusal };
    }

    await Promise.all(
      marked.result.lostRingLegUuids.map((legUuid) =>
        telephony.safeHangup(legUuid),
      ),
    );

    // The call is marked from here on, and a marked call refuses holds and
    // further transfers and lets its agent leave without ending it. Whatever
    // throws below therefore takes the mark back before it answers.
    try {
      const offer = await realtime.offerCall(
        [targetUserId],
        transferOfferOf(marked.after, request.userId),
      );
      if (offer.offered.length === 0) {
        // Nothing was held and nobody was told, so nobody needs to hear of
        // it; the caller is still rescued if the agent left in the meantime.
        await this.failPendingTransfer(conversationUuid, targetUserId, null);
        return {
          ok: false,
          refusal: transferRefusalOf(offer.refused[0]?.reason ?? 'offline'),
        };
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
    // voicemail once nobody is left. Their claim goes at once, though: a
    // user who turned a call down is free for the next one now, not when
    // Twilio gets round to reporting the leg.
    await Promise.all(
      ringingLegUuids.map((legUuid) => telephony.safeHangup(legUuid)),
    );
    await this.letGo(conversationUuid, [userId]);

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

  /** Only the write that changes the flag tells the timeline. */
  private async recordHold(
    conversationUuid: string,
    held: boolean,
    userId?: string,
  ): Promise<void> {
    const update = await this.changeCall(conversationUuid, (draft) => {
      if (draft.ending || Boolean(draft.held) === held) {
        return { result: false };
      }
      draft.held = held;
      return { result: true };
    });
    if (!update?.result || !update.after) {
      return;
    }

    const event = {
      conversationUuid,
      userId,
      legUuid: remoteLegOf(update.after),
    };
    const { events } = this.deps;
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
    const { telephony } = this.deps;

    const update = await this.changeCall(conversationUuid, (draft) => {
      if (draft.ending || draft.pendingTransferToUserId !== targetUserId) {
        return { result: null };
      }

      const settled = {
        plan: planTransferFailure(draft),
        initiatedBy: draft.transferInitiatedBy,
        ringingLegUuids: Object.entries(draft.agentLegs)
          .filter(
            ([legUuid, userId]) =>
              userId === targetUserId && legUuid !== draft.agentLegUuid,
          )
          .map(([legUuid]) => legUuid),
      };
      draft.pendingTransferToUserId = undefined;
      draft.transferInitiatedBy = undefined;
      draft.transferOriginLegUuid = undefined;
      return { result: settled };
    });
    const settled = update?.result;
    if (!settled) {
      return false;
    }

    switch (settled.plan) {
      case 'return-to-agent':
        await Promise.all(
          settled.ringingLegUuids.map((legUuid) =>
            telephony.safeHangup(legUuid),
          ),
        );
        if (reason) {
          await this.resumeAfterTransfer(conversationUuid);
        }
        break;
      // Both of these hang up the teammate's legs with every other agent leg.
      case 'voicemail':
        await this.routeCallerToVoicemail(conversationUuid, 'routing-timeout');
        break;
      case 'end-call':
        await telephony.requestConversationHangup(conversationUuid);
        break;
    }

    if (reason) {
      await this.tellTransferOutcome([settled.initiatedBy, targetUserId], {
        conversationUuid,
        targetUserId,
        status: 'failed',
        reason,
      });
    }

    this.deps.log.info(
      { conversationUuid, targetUserId, reason, plan: settled.plan },
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
    transfer: TransferHandover,
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

  /** A leg is gone: forget it, then act on what that means for the call. */
  private async onLegEnded(
    conversationUuid: string,
    participant: CallParticipant,
    legUuid: string,
    status: CallEndStatus,
    duration: number | undefined,
  ): Promise<void> {
    const { telephony } = this.deps;
    await telephony.deleteLegMetadata([legUuid]);

    const update = await this.changeCall(conversationUuid, (draft) =>
      decideLegEnded(draft, participant, legUuid, status),
    );
    const plan = update?.result;
    if (!plan) {
      return;
    }

    switch (plan.kind) {
      case 'ignored':
      case 'forgotten':
        return;
      case 'ended':
        await Promise.all(
          plan.hangUpLegUuids.map((other) => telephony.safeHangup(other)),
        );
        await this.reportEnded(plan.final, status, duration ?? 0);
        return;
      case 'ring-next':
        if (await this.ringNextInOrder(conversationUuid)) {
          return;
        }
        await this.routeCallerToVoicemail(conversationUuid, 'routing-timeout');
        return;
      case 'voicemail':
        await this.routeCallerToVoicemail(conversationUuid, plan.reason);
        return;
      case 'transfer-fell-through':
        await this.failPendingTransfer(
          conversationUuid,
          plan.targetUserId,
          plan.reason,
        );
        return;
    }
  }

  // Ringing ------------------------------------------------------------------

  /** Ring everybody who can take the call. Resolves to the users rung. */
  private async ringAllAtOnce(
    state: CallState,
    userIds: string[],
  ): Promise<string[]> {
    const { realtime, telephony } = this.deps;
    const { conversationUuid } = state;

    const offer = await realtime.offerCall(userIds, incomingCallOf(state));
    const legs = await telephony.ringAgents(conversationUuid, offer.offered, {
      fromNumber: state.to,
      ringingTimer: state.ringDuration,
    });

    const rung = legs.map((leg) => leg.userId);
    await this.letGo(
      conversationUuid,
      offer.offered.filter((userId) => !rung.includes(userId)),
    );
    return rung;
  }

  /**
   * Ring the next user in the queue who can take the call. Resolves to false
   * when nobody is left, or when the call no longer needs anybody rung.
   */
  private async ringNextInOrder(conversationUuid: string): Promise<boolean> {
    const { telephony, realtime } = this.deps;

    const start = await telephony.getCallState(conversationUuid);
    const queue = start?.routingQueue ?? [];

    for (
      let index = start?.currentQueueIndex ?? 0;
      index < queue.length;
      index += 1
    ) {
      const userId = queue[index];
      if (!userId) {
        continue;
      }

      const turn = await this.changeCall(conversationUuid, (draft) => {
        if (draft.ending || draft.answered || draft.voicemail) {
          return { result: false };
        }
        draft.currentQueueIndex = index;
        return { result: true };
      });
      if (!turn?.result || !turn.after) {
        return false;
      }

      const offer = await realtime.offerCall(
        [userId],
        incomingCallOf(turn.after),
      );
      if (offer.offered.length === 0) {
        continue;
      }

      try {
        await this.ringAgent(turn.after, userId);
        return true;
      } catch {
        // Already logged by ringAgent; move on to the next user.
        await this.letGo(conversationUuid, [userId]);
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
          await this.routeCallerToVoicemail(
            conversationUuid,
            'closed-hours-external',
          );
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
    const update = await this.changeCall(state.conversationUuid, (draft) => {
      draft.voicemail = true;
      return { result: undefined };
    });
    await this.deps.events.callMissed({
      conversationUuid: state.conversationUuid,
      from: state.from,
      to: state.to,
      departmentId: state.departmentId,
      userId: state.targetUserId,
    });

    return this.deps.telephony.buildVoicemailTwiml(
      update?.after ?? state,
      reason,
    );
  }

  /**
   * The caller is already in the conference: pull them out into voicemail.
   * Written first and acted on after, so the legs it hangs up find nothing
   * left to decide when Twilio reports them gone. An unanswered call still
   * ringing somebody waits for them instead.
   */
  private async routeCallerToVoicemail(
    conversationUuid: string,
    reason: VoicemailReason,
  ): Promise<void> {
    const { telephony, events } = this.deps;

    const update = await this.changeCall(conversationUuid, (draft) => {
      const stillRinging =
        !draft.answered && draft.pendingAgentLegUuids.length > 0;
      if (
        !draft.callerLegUuid ||
        draft.ending ||
        draft.voicemail ||
        stillRinging
      ) {
        return { result: null };
      }

      const moved = {
        hangUpLegUuids: [
          ...Object.keys(draft.agentLegs),
          ...(draft.externalLegUuid ? [draft.externalLegUuid] : []),
        ],
        wasHeld: Boolean(draft.held),
      };
      draft.voicemail = true;
      draft.pendingAgentLegUuids = [];
      draft.agentLegs = {};
      draft.agentLegUuid = undefined;
      draft.externalLegUuid = undefined;
      // Leaving the conference for voicemail is what ends a hold, so there
      // is no participant to resume; the timeline still hears of it below.
      draft.held = false;
      return { result: moved };
    });
    const moved = update?.result;
    const state = update?.after;
    if (!moved || !state?.callerLegUuid) {
      return;
    }

    await Promise.all(
      moved.hangUpLegUuids.map((legUuid) => telephony.safeHangup(legUuid)),
    );

    // A call an agent talked on was not missed, even when the transfer that
    // followed fell through and voicemail is where the caller ends up.
    if (!state.answered) {
      await events.callMissed({
        conversationUuid,
        from: state.from,
        to: state.to,
        departmentId: state.departmentId,
        userId: state.targetUserId,
      });
    }
    if (moved.wasHeld) {
      await events.callResumed({
        conversationUuid,
        legUuid: state.callerLegUuid,
      });
    }

    await telephony.redirectLegToVoicemail(state.callerLegUuid, state, reason);
  }

  /**
   * End the call from outside a leg's own report: a voicemail was left, or
   * the number an agent dialed could not be. Only the one who removes the
   * state reports the end, so it is reported once.
   */
  private async finalize(
    conversationUuid: string,
    status: CallEndStatus,
  ): Promise<void> {
    const update = await this.changeCall(conversationUuid, () => ({
      result: undefined,
      remove: true,
    }));
    if (update) {
      await this.reportEnded(update.before, status, 0);
    }
  }

  /** The call is over and its state is gone: tell the API, forget the legs. */
  private async reportEnded(
    state: CallState,
    status: CallEndStatus,
    duration: number,
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
  }

  // Participants -------------------------------------------------------------

  private async onParticipantJoined(
    conversationUuid: string,
    participant: CallParticipant,
    legUuid: string,
  ): Promise<void> {
    const { telephony, events } = this.deps;

    switch (participant.participantType) {
      case 'caller': {
        await this.changeCall(conversationUuid, (draft) => {
          draft.callerLegUuid = legUuid;
          return { result: undefined };
        });
        return;
      }

      case 'agent': {
        const agentUserId = participant.participantId;
        const update = await this.changeCall(conversationUuid, (draft) =>
          decideAgentJoined(draft, agentUserId, legUuid),
        );
        const joined = update?.result;
        const state = update?.after;
        if (!joined || !state) {
          return;
        }

        if (joined.kind === 'intruder') {
          this.deps.log.info(
            { conversationUuid, legUuid, agentUserId },
            'Released an agent who joined a call that was not theirs to take',
          );
          await telephony.safeHangup(legUuid);
          return;
        }

        if (joined.firstAnswer) {
          await events.callStarted({
            conversationUuid,
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
            joined.losingLegUuids.map((other) => telephony.safeHangup(other)),
          );
        }

        if (joined.transfer) {
          await this.completeTransfer(conversationUuid, joined.transfer);
        }
        return;
      }

      case 'external': {
        const update = await this.changeCall(conversationUuid, (draft) => {
          const firstAnswer = !draft.answered && draft.direction === 'outbound';
          draft.answered = true;
          draft.externalLegUuid = legUuid;
          return { result: firstAnswer };
        });
        const state = update?.after;
        if (!update?.result || !state) {
          return;
        }

        await events.callStarted({
          conversationUuid,
          from: state.from,
          to: state.to,
          userId: state.activeAgentUserId ?? state.targetUserId ?? 'unknown',
          departmentId: state.departmentId,
          direction: 'outbound',
          agentLegUuid: state.agentLegUuid,
          externalLegUuid: legUuid,
        });
        return;
      }
    }
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

  // Claims -------------------------------------------------------------------

  /**
   * Change the call's state, then let go of whoever the change stopped
   * occupying, so a user is free for another call the moment this one no
   * longer needs them rather than when the claim runs out.
   */
  private async changeCall<R>(
    conversationUuid: string,
    decide: (draft: CallState) => CallStateChange<R>,
  ): Promise<CallStateUpdate<R> | null> {
    const update = await this.deps.telephony.updateCallState(
      conversationUuid,
      decide,
    );
    if (update && update.after !== update.before) {
      await this.letGo(
        conversationUuid,
        usersLetGo(update.before, update.after),
      );
    }
    return update;
  }

  private async letGo(
    conversationUuid: string,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) {
      return;
    }

    try {
      await this.deps.realtime.release(conversationUuid, userIds);
    } catch (error) {
      // Not retried: the call no longer renews these claims, so they run
      // out on their own and the users are free again within their lifetime.
      this.deps.log.warn(
        { err: error, conversationUuid, userIds },
        'Failed to release users from a call',
      );
    }
  }

  /** Work that outlives the webhook response; a failure must not go unnoticed. */
  private inBackground(work: Promise<unknown>, description: string): void {
    work.catch((error: unknown) => {
      this.deps.log.error({ err: error }, `Background ${description} failed`);
    });
  }
}

/** The teammate who answered a transfer, and what is left of the agent handing it over. */
interface TransferHandover {
  fromUserId: string;
  toUserId: string;
  answeredLegUuid: string;
  initiatedBy: string | undefined;
  /** The leg handing the call over, and any second ring of the teammate. */
  releasedLegUuids: string[];
}

type AgentJoin =
  | { kind: 'intruder' }
  | {
      kind: 'joined';
      /** The first answer of an inbound call, which stops everybody else's ring. */
      firstAnswer: boolean;
      losingLegUuids: string[];
      transfer: TransferHandover | null;
    };

/**
 * An agent's leg joined the conference: they take the call, or finish a
 * transfer, or are turned away. Changes `draft` to match.
 */
function decideAgentJoined(
  draft: CallState,
  agentUserId: string,
  legUuid: string,
): CallStateChange<AgentJoin> {
  const wasAnswered = draft.answered;
  const previousAgentUserId = draft.activeAgentUserId;
  const isTransferTarget = draft.pendingTransferToUserId === agentUserId;

  // Someone already has this call and it is not being handed to this agent:
  // they answered a ring that lost the race, or a transfer that was
  // cancelled as they picked up. Taking the call over would leave two agents
  // on it and end it for everyone when this one hangs up.
  if (
    wasAnswered &&
    !isTransferTarget &&
    previousAgentUserId !== undefined &&
    previousAgentUserId !== agentUserId
  ) {
    return { result: { kind: 'intruder' } };
  }

  const transfer =
    isTransferTarget && previousAgentUserId
      ? {
          fromUserId: draft.transferInitiatedBy ?? previousAgentUserId,
          toUserId: agentUserId,
          answeredLegUuid: legUuid,
          initiatedBy: draft.transferInitiatedBy,
          releasedLegUuids: Object.keys(draft.agentLegs).filter(
            (other) => other !== legUuid,
          ),
        }
      : null;

  draft.agentLegUuid = legUuid;
  draft.activeAgentUserId = agentUserId;
  draft.pendingAgentLegUuids = draft.pendingAgentLegUuids.filter(
    (pending) => pending !== legUuid,
  );
  if (transfer) {
    // Cleared in the same write that makes the teammate the agent, so a
    // webhook delivered twice completes the transfer once, and a decline or
    // a cancel arriving now finds nothing left to undo. The released legs
    // stay until Twilio reports them gone: the agent handing over is on the
    // call, and not to be offered another, until theirs has left.
    draft.pendingTransferToUserId = undefined;
    draft.transferInitiatedBy = undefined;
    draft.transferOriginLegUuid = undefined;
  }

  const firstAnswer = !wasAnswered && draft.direction === 'inbound';
  if (firstAnswer) {
    draft.answered = true;
  }

  return {
    result: {
      kind: 'joined',
      firstAnswer,
      losingLegUuids: firstAnswer
        ? Object.keys(draft.agentLegs).filter((other) => other !== legUuid)
        : [],
      transfer,
    },
  };
}

type LegEndPlan =
  /** The call no longer tracks the leg: its end was handled already. */
  | { kind: 'ignored' }
  /** The leg is forgotten and the call goes on as it was. */
  | { kind: 'forgotten' }
  /** The call is over. `final` is what it was left as, for the report. */
  | { kind: 'ended'; final: CallState; hangUpLegUuids: string[] }
  /** A fixed-order ring moves on to whoever is next. */
  | { kind: 'ring-next' }
  /** Nobody is left to answer. */
  | { kind: 'voicemail'; reason: VoicemailReason }
  /** The teammate a transfer rang is gone without answering. */
  | {
      kind: 'transfer-fell-through';
      targetUserId: string;
      reason: TransferFailureReason;
    };

/**
 * A leg is gone: forget it, and decide what becomes of the call. Changes
 * `draft` to match; an `ended` plan removes the state.
 */
function decideLegEnded(
  draft: CallState,
  participant: CallParticipant,
  legUuid: string,
  status: CallEndStatus,
): CallStateChange<LegEndPlan> {
  if (!legUuidsOf(draft).includes(legUuid)) {
    return { result: { kind: 'ignored' } };
  }

  // While a hangup is in progress, legs drop one by one; the last one ends it.
  if (draft.ending) {
    removeLeg(draft, legUuid);
    return hasActiveLegs(draft)
      ? { result: { kind: 'forgotten' } }
      : {
          result: { kind: 'ended', final: draft, hangUpLegUuids: [] },
          remove: true,
        };
  }

  // The caller hanging up ends the call as it stood, their leg included.
  if (participant.participantType === 'caller') {
    return {
      result: {
        kind: 'ended',
        final: draft,
        hangUpLegUuids: legUuidsOf(draft).filter((other) => other !== legUuid),
      },
      remove: true,
    };
  }

  const wasActiveAgent = draft.agentLegUuid === legUuid;
  removeLeg(draft, legUuid);
  const everyOtherLeg = legUuidsOf(draft);

  switch (participant.participantType) {
    case 'external':
      if (draft.direction === 'outbound') {
        return {
          result: {
            kind: 'ended',
            final: draft,
            hangUpLegUuids: everyOtherLeg,
          },
          remove: true,
        };
      }
      if (!draft.answered && draft.callerLegUuid) {
        return {
          result: { kind: 'voicemail', reason: 'closed-hours-external' },
        };
      }
      return {
        result: { kind: 'ended', final: draft, hangUpLegUuids: [] },
        remove: true,
      };

    case 'agent': {
      if (!draft.answered) {
        // The agent who dialed out is gone before the number answered, and
        // nobody else is on an outbound call: the ring is stopped rather
        // than answered into an empty conference.
        if (draft.direction === 'outbound') {
          return {
            result: {
              kind: 'ended',
              final: draft,
              hangUpLegUuids: everyOtherLeg,
            },
            remove: true,
          };
        }
        if (draft.ringStrategy === 'FIXED_ORDER') {
          draft.currentQueueIndex = (draft.currentQueueIndex ?? 0) + 1;
          return { result: { kind: 'ring-next' } };
        }
        return draft.pendingAgentLegUuids.length > 0
          ? { result: { kind: 'forgotten' } }
          : { result: { kind: 'voicemail', reason: 'routing-timeout' } };
      }

      if (wasActiveAgent && !draft.pendingTransferToUserId) {
        return {
          result: {
            kind: 'ended',
            final: draft,
            hangUpLegUuids: everyOtherLeg,
          },
          remove: true,
        };
      }

      // The teammate's leg ended without an answer. A second ring of theirs
      // that is still out (the same transfer asked for twice) keeps it alive.
      const agentUserId = participant.participantId;
      const transferFellThrough =
        draft.pendingTransferToUserId === agentUserId &&
        !Object.values(draft.agentLegs).includes(agentUserId);
      return transferFellThrough
        ? {
            result: {
              kind: 'transfer-fell-through',
              targetUserId: agentUserId,
              reason: transferFailureReasonOf(status),
            },
          }
        : { result: { kind: 'forgotten' } };
    }
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
