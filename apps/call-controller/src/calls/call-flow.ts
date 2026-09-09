import type { CallEndStatus, IncomingCall } from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import {
  type InboundCallPlan,
  maskPhoneNumber,
  planInboundCall,
  type RoutingLookupService,
  type VoicemailReason,
} from '../routing/index.js';
import type { CallEventPublisher } from './call-events.js';
import {
  type CallParticipant,
  type CallState,
  conversationNameFor,
  hasActiveLegs,
  legUuidsOf,
  participantOfLeg,
  removeLeg,
} from './call-state.js';
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
 * state, decides what happens next, and saves the state back.
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
  | 'hangupConversation'
  | 'completePendingTransfer'
  | 'safeHangup'
  | 'redirectLegToVoicemail'
  | 'buildConferenceTwiml'
  | 'buildVoicemailTwiml'
  | 'parseParticipantLabel'
>;

export interface CallFlowDependencies {
  telephony: CallFlowTelephony;
  routing: Pick<RoutingLookupService, 'lookupByPhone'>;
  events: CallEventPublisher;
  realtime: CallRealtime;
  log: FastifyBaseLogger;
}

export interface OutboundCallRequest {
  /** The agent's own Twilio client leg. */
  callSid: string;
  agentUserId: string;
  /** E.164. */
  targetNumber: string;
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

  /** An agent dialed a number from the softphone. Resolves to TwiML for the agent's leg. */
  async startOutboundCall(request: OutboundCallRequest): Promise<string> {
    const { callSid, agentUserId, targetNumber } = request;
    const { telephony, events, realtime } = this.deps;

    const state: CallState = {
      conversationUuid: callSid,
      conversationName: conversationNameFor(callSid),
      direction: 'outbound',
      routingType: 'OUTBOUND',
      from: agentUserId,
      to: targetNumber,
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
      from: agentUserId,
      to: targetNumber,
      direction: 'outbound',
      agentLegUuid: callSid,
      userId: agentUserId,
    });

    // The agent's leg must get its TwiML now; the outside number is dialed
    // while the agent waits in the conference.
    this.inBackground(
      telephony
        .createExternalLeg(callSid, targetNumber)
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
      return telephony.buildVoicemailTwiml(callSid, 'missing-routing');
    }

    const plan = planInboundCall(routed);
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
    // a leg the call no longer tracks has already been handled.
    if (isTerminalStatus(status) && !legUuidsOf(state).includes(legUuid)) {
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

    return this.deps.telephony.buildVoicemailTwiml(
      state.conversationUuid,
      reason,
    );
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

    await events.callMissed({
      conversationUuid: state.conversationUuid,
      from: state.from,
      to: state.to,
      departmentId: state.departmentId,
      userId: state.targetUserId,
    });

    await telephony.redirectLegToVoicemail(
      state.callerLegUuid,
      state.conversationUuid,
      reason,
    );
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
        const transferTargetUserId = state.pendingTransferToUserId;

        state.agentLegUuid = legUuid;
        state.activeAgentUserId = agentUserId;
        state.pendingAgentLegUuids = state.pendingAgentLegUuids.filter(
          (pending) => pending !== legUuid,
        );
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

        if (
          transferTargetUserId &&
          transferTargetUserId === agentUserId &&
          previousAgentUserId
        ) {
          await telephony.completePendingTransfer(
            state.conversationUuid,
            legUuid,
            agentUserId,
          );
          await events.callTransferred({
            conversationUuid: state.conversationUuid,
            fromUserId: previousAgentUserId,
            toUserId: agentUserId,
            agentLegUuid: legUuid,
          });
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

    if (state.pendingTransferToUserId === agentUserId) {
      state.pendingTransferToUserId = undefined;
      state.transferInitiatedBy = undefined;
      state.transferOriginLegUuid = undefined;
    }

    await telephony.saveCallState(state);
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
