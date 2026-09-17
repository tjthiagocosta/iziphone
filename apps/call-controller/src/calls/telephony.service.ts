import { randomBytes } from 'node:crypto';
import { callLine, normalizePhoneNumber } from '@repo/dto';
import { OUTBOUND_GRANT } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import twilio from 'twilio';
import type { TwilioVoiceConfig } from '../config.js';
import {
  maskPhoneNumber,
  type VoicemailReason,
  voicemailGreeting,
} from '../routing/index.js';
import { remoteLegOf } from './call-control.js';
import {
  type CallParticipant,
  type CallState,
  type LegMetadata,
  legUuidsOf,
} from './call-state.js';
import {
  type OutboundCallGrant,
  type OutboundCallRefusal,
  outboundCallRefusalMessage,
  parseStoredGrant,
} from './outbound-grant.js';

/*
 * Twilio and Redis for one call. Twilio is the phone network: legs are
 * created, joined into a conference, put on hold and hung up here. Redis
 * holds the call state and leg metadata while the call lasts, and the grant
 * an outbound call is placed on until the call starts.
 *
 *   telephony:call:{conversationUuid}  -> CallState
 *   telephony:leg:{legUuid}            -> LegMetadata
 *   voice:outbound-grant:{token}       -> OutboundCallGrant
 */

const CALL_STATE_PREFIX = 'telephony:call:';
const LEG_STATE_PREFIX = 'telephony:leg:';
const STATE_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_RING_SECONDS = 30;
const INTERNAL_API_TIMEOUT_MS = 3000;

const CONFERENCE_STATUS_EVENTS = [
  'start',
  'end',
  'join',
  'leave',
  'mute',
  'hold',
  'modify',
] as const;
const PARTICIPANT_STATUS_EVENTS = [
  'initiated',
  'ringing',
  'answered',
  'completed',
] as const;
const RECORDING_STATUS_EVENTS = ['completed', 'absent'] as const;

export type TwilioClient = Pick<
  ReturnType<typeof twilio>,
  'api' | 'calls' | 'conferences'
>;

export type TelephonyRedis = Pick<Redis, 'get' | 'set' | 'del' | 'getdel'>;

export interface TelephonyDependencies {
  redis: TelephonyRedis;
  /** Null when the deployment has no Twilio credentials yet. */
  voice: { config: TwilioVoiceConfig; client: TwilioClient } | null;
  internalApi: { url: string; token: string };
  log: FastifyBaseLogger;
}

export interface RingOptions {
  /**
   * Caller id of the new leg: the line of ours the call is on. There is no
   * default, because Twilio accepts only a number of the account here and a
   * call must not leave from a line nobody chose.
   */
  fromNumber: string;
  /** Seconds to ring before Twilio gives up on the leg. */
  ringingTimer?: number;
}

/** A leg dialed to a user's softphone. */
export interface AgentLeg {
  userId: string;
  legUuid: string;
}

export function createTelephonyService(deps: {
  redis: TelephonyRedis;
  twilio: TwilioVoiceConfig | null;
  internalApi: { url: string; token: string };
  log: FastifyBaseLogger;
}): TelephonyService {
  return new TelephonyService({
    redis: deps.redis,
    voice: deps.twilio
      ? {
          config: deps.twilio,
          client: twilio(deps.twilio.accountSid, deps.twilio.authToken),
        }
      : null,
    internalApi: deps.internalApi,
    log: deps.log,
  });
}

export class TelephonyService {
  constructor(private readonly deps: TelephonyDependencies) {}

  isConfigured(): boolean {
    return this.deps.voice !== null;
  }

  /** Rejects when Twilio is unconfigured or the credentials do not work. */
  async testConnection(): Promise<void> {
    const { config, client } = this.requireVoice();
    await client.api.accounts(config.accountSid).fetch();
  }

  /** Access token for the browser softphone; lets it place and receive calls. */
  generateClientJwt(identity: string): string {
    const { config } = this.requireVoice();
    const { AccessToken } = twilio.jwt;

    const token = new AccessToken(
      config.accountSid,
      config.apiKeySid,
      config.apiKeySecret,
      { identity, ttl: 60 * 60 },
    );
    token.addGrant(
      new AccessToken.VoiceGrant({
        outgoingApplicationSid: config.twimlAppSid,
        incomingAllow: true,
      }),
    );

    return token.toJwt();
  }

  /**
   * Tell the API which Twilio client identity a user answers to. The identity
   * is the user id, so this is idempotent; failure only costs the API a
   * stale column, never the call.
   */
  async ensureUser(userId: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.deps.internalApi.url}/internal/users/${encodeURIComponent(userId)}/telephony`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.deps.internalApi.token}`,
          },
          body: JSON.stringify({ telephonyUserId: userId }),
          signal: AbortSignal.timeout(INTERNAL_API_TIMEOUT_MS),
        },
      );
      if (!response.ok) {
        throw new Error(`API answered ${response.status}`);
      }
    } catch (error) {
      this.deps.log.warn(
        { err: error, userId },
        'Failed to record the telephony identity with the API',
      );
    }
  }

  // Call state ---------------------------------------------------------------

  async getCallState(conversationUuid: string): Promise<CallState | null> {
    const payload = await this.deps.redis.get(
      `${CALL_STATE_PREFIX}${conversationUuid}`,
    );
    // This service is the only writer, so the shape is trusted.
    return payload ? (JSON.parse(payload) as CallState) : null;
  }

  async saveCallState(state: CallState): Promise<void> {
    await this.deps.redis.set(
      `${CALL_STATE_PREFIX}${state.conversationUuid}`,
      JSON.stringify(state),
      'EX',
      STATE_TTL_SECONDS,
    );
  }

  async deleteCallState(conversationUuid: string): Promise<void> {
    await this.deps.redis.del(`${CALL_STATE_PREFIX}${conversationUuid}`);
  }

  async setLegMetadata(legUuid: string, metadata: LegMetadata): Promise<void> {
    await this.deps.redis.set(
      `${LEG_STATE_PREFIX}${legUuid}`,
      JSON.stringify(metadata),
      'EX',
      STATE_TTL_SECONDS,
    );
  }

  async getLegMetadata(legUuid: string): Promise<LegMetadata | null> {
    const payload = await this.deps.redis.get(`${LEG_STATE_PREFIX}${legUuid}`);
    return payload ? (JSON.parse(payload) as LegMetadata) : null;
  }

  async deleteLegMetadata(legUuids: string[]): Promise<void> {
    if (legUuids.length > 0) {
      await this.deps.redis.del(
        ...legUuids.map((legUuid) => `${LEG_STATE_PREFIX}${legUuid}`),
      );
    }
  }

  /**
   * Keeps a grant for the seconds it is good for, under a token that cannot
   * be guessed. Resolves to the token, which is all the softphone gets.
   */
  async issueOutboundGrant(grant: OutboundCallGrant): Promise<string> {
    const token = randomBytes(16).toString('base64url');
    await this.deps.redis.set(
      `${OUTBOUND_GRANT.KEY_PREFIX}${token}`,
      JSON.stringify(grant),
      'EX',
      OUTBOUND_GRANT.TTL_SECONDS,
    );
    return token;
  }

  /**
   * The grant behind a token, taken from the store in the same step so that
   * it serves one call. Null once used, expired, or never issued.
   */
  async takeOutboundGrant(token: string): Promise<OutboundCallGrant | null> {
    const payload = await this.deps.redis.getdel(
      `${OUTBOUND_GRANT.KEY_PREFIX}${token}`,
    );
    if (payload === null) {
      return null;
    }
    const grant = parseStoredGrant(JSON.parse(payload));
    if (!grant) {
      // Only this service writes the key, so this is a bug, not an attack;
      // the call is refused as if it had no grant.
      this.deps.log.error('An outbound grant in the store was not readable');
    }
    return grant;
  }

  async ensureConferenceReference(
    conversationUuid: string,
    conferenceSid: string,
  ): Promise<void> {
    const state = await this.getCallState(conversationUuid);
    if (!state || state.conferenceSid === conferenceSid) {
      return;
    }

    state.conferenceSid = conferenceSid;
    await this.saveCallState(state);
  }

  // Legs ---------------------------------------------------------------------

  /** Ring a user's softphone into the conference. Resolves to the new leg id. */
  async createAgentLeg(
    conversationUuid: string,
    userId: string,
    options: RingOptions,
  ): Promise<string> {
    const state = await this.requireCallState(conversationUuid);
    if (state.ending) {
      throw new Error(
        `Cannot create an agent leg while call ${conversationUuid} is ending`,
      );
    }

    const leg = await this.dialAgent(state, userId, options);
    await this.registerAgentLegs(conversationUuid, [leg]);

    return leg.legUuid;
  }

  /**
   * Ring several users at once. The legs are recorded in one state write, so
   * simultaneous rings cannot overwrite each other. Users whose leg could not
   * be created are logged and left out of the result.
   */
  async ringAgents(
    conversationUuid: string,
    userIds: readonly string[],
    options: RingOptions,
  ): Promise<AgentLeg[]> {
    const state = await this.requireCallState(conversationUuid);
    if (state.ending || userIds.length === 0) {
      return [];
    }

    const results = await Promise.allSettled(
      userIds.map((userId) => this.dialAgent(state, userId, options)),
    );
    const legs: AgentLeg[] = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        legs.push(result.value);
      } else {
        this.deps.log.warn(
          { err: result.reason, conversationUuid, userId: userIds[index] },
          'Failed to ring agent',
        );
      }
    });

    await this.registerAgentLegs(conversationUuid, legs);

    return legs;
  }

  private async dialAgent(
    state: CallState,
    userId: string,
    options: RingOptions,
  ): Promise<AgentLeg> {
    const { conversationUuid } = state;
    await this.ensureUser(userId);

    const participant: CallParticipant = {
      participantType: 'agent',
      participantId: userId,
    };
    const target = new URLSearchParams({
      conversationUuid,
      participantType: 'agent',
      participantId: userId,
    });
    const legUuid = await this.createConferenceParticipant(state, {
      fromNumber: options.fromNumber,
      participant,
      to: `client:${userId}?${target.toString()}`,
      timeout:
        options.ringingTimer ?? state.ringDuration ?? DEFAULT_RING_SECONDS,
    });

    await this.setLegMetadata(legUuid, { conversationUuid, ...participant });

    return { userId, legUuid };
  }

  /** Record dialed legs as ringing, or hang them up if the call ended meanwhile. */
  private async registerAgentLegs(
    conversationUuid: string,
    legs: readonly AgentLeg[],
  ): Promise<void> {
    if (legs.length === 0) {
      return;
    }

    const latest = await this.getCallState(conversationUuid);
    if (!latest || latest.ending) {
      await Promise.all(legs.map((leg) => this.safeHangup(leg.legUuid)));
      return;
    }

    for (const leg of legs) {
      latest.agentLegs[leg.legUuid] = leg.userId;
    }
    latest.pendingAgentLegUuids = [
      ...new Set([
        ...latest.pendingAgentLegUuids,
        ...legs.map((leg) => leg.legUuid),
      ]),
    ];
    await this.saveCallState(latest);
  }

  /** Dial an outside number into the conference. Resolves to the new leg id. */
  async createExternalLeg(
    conversationUuid: string,
    phoneNumber: string,
    options: RingOptions,
  ): Promise<string> {
    const state = await this.requireCallState(conversationUuid);
    if (state.ending) {
      throw new Error(
        `Cannot create an external leg while call ${conversationUuid} is ending`,
      );
    }

    const to = normalizePhoneNumber(phoneNumber);
    if (!to) {
      throw new Error(
        `Cannot dial a number that is not E.164 (ends in ${maskPhoneNumber(phoneNumber)})`,
      );
    }

    const participant: CallParticipant = {
      participantType: 'external',
      participantId: to,
    };
    const legUuid = await this.createConferenceParticipant(state, {
      fromNumber: options.fromNumber,
      participant,
      to,
      timeout:
        options.ringingTimer ?? state.ringDuration ?? DEFAULT_RING_SECONDS,
    });

    await this.setLegMetadata(legUuid, { conversationUuid, ...participant });

    const latest = await this.getCallState(conversationUuid);
    if (!latest || latest.ending) {
      await this.safeHangup(legUuid);
      return legUuid;
    }

    latest.externalLegUuid = legUuid;
    await this.saveCallState(latest);

    return legUuid;
  }

  /** Hang up every leg. Twilio's webhooks then finalize the call. */
  async hangupConversation(conversationUuid: string): Promise<void> {
    const state = await this.getCallState(conversationUuid);
    if (!state) {
      return;
    }

    await Promise.all(
      legUuidsOf(state).map((legUuid) => this.safeHangup(legUuid)),
    );
  }

  /**
   * Mark the call as ending before hanging up, so the webhooks that follow
   * tear the call down instead of trying to re-route it.
   */
  async requestConversationHangup(
    conversationUuid: string,
    initiatedBy?: string,
  ): Promise<CallState | null> {
    const state = await this.getCallState(conversationUuid);
    if (!state) {
      return null;
    }

    if (!state.ending) {
      state.ending = true;
      state.endingRequestedAt = new Date().toISOString();
      state.endingRequestedBy = initiatedBy;
      state.pendingAgentLegUuids = [];
      state.pendingTransferToUserId = undefined;
      state.transferInitiatedBy = undefined;
      state.transferOriginLegUuid = undefined;
      await this.saveCallState(state);
    }

    await this.hangupConversation(conversationUuid);

    return state;
  }

  /**
   * Hold or resume the remote party (the caller, or the number we dialed).
   * Resolves to whether they are on hold now, as Twilio answered, or to null
   * when the call or the party is no longer there to be held.
   */
  async holdConversation(
    conversationUuid: string,
    hold: boolean,
  ): Promise<boolean | null> {
    const { config, client } = this.requireVoice();
    const state = await this.getCallState(conversationUuid);
    const heldLegUuid = state ? remoteLegOf(state) : undefined;

    if (!state || !heldLegUuid) {
      return null;
    }

    const conferenceSid = await this.findConferenceSid(state);
    if (!conferenceSid) {
      return null;
    }

    try {
      const participant = await client
        .conferences(conferenceSid)
        .participants(heldLegUuid)
        .update({
          hold,
          holdUrl: hold ? config.holdAudioUrl : undefined,
          holdMethod: hold ? 'GET' : undefined,
        });

      return typeof participant.hold === 'boolean' ? participant.hold : hold;
    } catch (error) {
      // Twilio only manages participants who are still in the conference.
      if (responseStatus(error) === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Ring the teammate a transfer is pending for; it completes when they join.
   * The call flow marks the transfer before it asks for the ring, and the
   * teammate can turn it down from the offer alone, so the marker is read
   * again here. Resolves to null, without ringing, when it is no longer set.
   */
  async transferConversation(
    conversationUuid: string,
    targetUserId: string,
    initiatedBy: string,
  ): Promise<string | null> {
    const state = await this.requireCallState(conversationUuid);

    if (
      state.pendingTransferToUserId !== targetUserId ||
      state.transferInitiatedBy !== initiatedBy
    ) {
      return null;
    }

    return this.createAgentLeg(conversationUuid, targetUserId, {
      // The line the call is on, whichever way the call went: on an outbound
      // call `to` is the other party, whose number is not ours to present.
      fromNumber: callLine(state),
      ringingTimer: state.ringDuration,
    });
  }

  /** Hang up one leg. Tolerates legs that are already gone; retries throttling. */
  async safeHangup(legUuid: string): Promise<void> {
    const { client } = this.requireVoice();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await client.calls(legUuid).update({ status: 'completed' });
        return;
      } catch (error) {
        const status = responseStatus(error);
        if (status === 404) {
          return;
        }

        const retryable =
          status === 429 || (typeof status === 'number' && status >= 500);
        if (retryable && attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 150));
          continue;
        }

        this.deps.log.warn(
          { err: error, legUuid, attempt, status },
          'Failed to hang up call leg',
        );
        return;
      }
    }
  }

  /** Replace what a leg is doing with the voicemail prompt. */
  async redirectLegToVoicemail(
    legUuid: string,
    conversationUuid: string,
    reason: VoicemailReason,
  ): Promise<void> {
    const { client } = this.requireVoice();
    await client.calls(legUuid).update({
      twiml: this.buildVoicemailTwiml(conversationUuid, reason),
    });
  }

  // TwiML --------------------------------------------------------------------

  /** Put the leg answering this TwiML into the call's conference. */
  buildConferenceTwiml(
    state: Pick<CallState, 'conversationUuid' | 'conversationName'>,
    participant: CallParticipant,
  ): string {
    const { config } = this.requireVoice();
    const response = new twilio.twiml.VoiceResponse();

    response.dial().conference(
      {
        participantLabel: participantLabel(participant),
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        beep: 'false',
        waitUrl: config.holdAudioUrl,
        waitMethod: 'GET',
        statusCallback: this.statusWebhookUrl(state.conversationUuid, {
          source: 'conference',
        }),
        statusCallbackMethod: 'POST',
        statusCallbackEvent: [...CONFERENCE_STATUS_EVENTS],
        record: 'record-from-start',
        recordingStatusCallback: this.statusWebhookUrl(state.conversationUuid, {
          source: 'conference-recording',
          context: 'conference',
        }),
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: [...RECORDING_STATUS_EVENTS],
      },
      state.conversationName,
    );

    return response.toString();
  }

  buildVoicemailTwiml(
    conversationUuid: string,
    reason: VoicemailReason,
  ): string {
    const response = new twilio.twiml.VoiceResponse();
    response.say({ voice: 'alice' }, voicemailGreeting(reason));
    response.record({
      action: this.webhookUrl('/webhooks/twilio/voice/voicemail/completed', {
        conversationUuid,
        context: reason,
      }),
      method: 'POST',
      timeout: 5,
      maxLength: 120,
      playBeep: true,
      trim: 'trim-silence',
      transcribe: true,
      transcribeCallback: this.statusWebhookUrl(conversationUuid, {
        source: 'voicemail-transcription',
        context: reason,
      }),
      recordingStatusCallback: this.statusWebhookUrl(conversationUuid, {
        source: 'voicemail-recording',
        context: reason,
      }),
      recordingStatusCallbackMethod: 'POST',
      recordingStatusCallbackEvent: [...RECORDING_STATUS_EVENTS],
    });

    return response.toString();
  }

  buildVoicemailCompletionTwiml(): string {
    const response = new twilio.twiml.VoiceResponse();
    response.say({ voice: 'alice' }, 'Thank you for your message. Goodbye.');
    response.hangup();
    return response.toString();
  }

  /** Tells the agent why their outbound call was not placed, then ends it. */
  buildOutboundRefusalTwiml(reason: OutboundCallRefusal): string {
    const response = new twilio.twiml.VoiceResponse();
    response.say({ voice: 'alice' }, outboundCallRefusalMessage(reason));
    response.hangup();
    return response.toString();
  }

  buildFallbackTwiml(): string {
    const response = new twilio.twiml.VoiceResponse();
    response.say(
      { voice: 'alice' },
      'We could not complete your call. Please try again later.',
    );
    response.hangup();
    return response.toString();
  }

  /** The inverse of the label given to every conference participant. */
  parseParticipantLabel(label: string | undefined): CallParticipant | null {
    if (!label) {
      return null;
    }

    const [type, encodedId] = label.split('|', 3);
    if (
      !encodedId ||
      (type !== 'caller' && type !== 'agent' && type !== 'external')
    ) {
      return null;
    }

    return {
      participantType: type,
      participantId: decodeURIComponent(encodedId),
    };
  }

  // Internals ----------------------------------------------------------------

  private requireVoice(): NonNullable<TelephonyDependencies['voice']> {
    if (!this.deps.voice) {
      throw new Error('Twilio telephony is not configured');
    }
    return this.deps.voice;
  }

  private async requireCallState(conversationUuid: string): Promise<CallState> {
    const state = await this.getCallState(conversationUuid);
    if (!state) {
      throw new Error(`Call state not found for ${conversationUuid}`);
    }
    return state;
  }

  private async createConferenceParticipant(
    state: CallState,
    options: {
      fromNumber: string;
      participant: CallParticipant;
      to: string;
      timeout: number;
    },
  ): Promise<string> {
    const { config, client } = this.requireVoice();
    const from = normalizePhoneNumber(options.fromNumber);
    if (!from) {
      throw new Error(
        `Cannot add a leg to call ${state.conversationUuid} without the line it is on as caller id`,
      );
    }

    const participant = await client
      .conferences(state.conferenceSid ?? state.conversationName)
      .participants.create({
        from,
        to: options.to,
        label: participantLabel(options.participant),
        timeout: options.timeout,
        statusCallback: this.statusWebhookUrl(state.conversationUuid, {
          source: 'participant',
        }),
        statusCallbackMethod: 'POST',
        statusCallbackEvent: [...PARTICIPANT_STATUS_EVENTS],
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        beep: 'false',
        waitUrl: config.holdAudioUrl,
        waitMethod: 'GET',
        earlyMedia: true,
        conferenceRecord: 'record-from-start',
        conferenceTrim: 'trim-silence',
        conferenceStatusCallback: this.statusWebhookUrl(
          state.conversationUuid,
          { source: 'conference' },
        ),
        conferenceStatusCallbackMethod: 'POST',
        conferenceStatusCallbackEvent: [...CONFERENCE_STATUS_EVENTS],
        conferenceRecordingStatusCallback: this.statusWebhookUrl(
          state.conversationUuid,
          { source: 'conference-recording', context: 'conference' },
        ),
        conferenceRecordingStatusCallbackMethod: 'POST',
        conferenceRecordingStatusCallbackEvent: [...RECORDING_STATUS_EVENTS],
      });

    if (typeof participant.callSid !== 'string' || !participant.callSid) {
      throw new Error(
        `Twilio created a participant without a call SID for ${state.conversationUuid}`,
      );
    }

    return participant.callSid;
  }

  /** The call's conference, or null when Twilio has none in progress for it. */
  private async findConferenceSid(state: CallState): Promise<string | null> {
    if (state.conferenceSid) {
      return state.conferenceSid;
    }

    const { client } = this.requireVoice();
    const conferences = await client.conferences.list({
      friendlyName: state.conversationName,
      status: 'in-progress',
      limit: 1,
    });
    const conferenceSid = conferences[0]?.sid;
    if (!conferenceSid) {
      return null;
    }

    state.conferenceSid = conferenceSid;
    await this.saveCallState(state);

    return conferenceSid;
  }

  private statusWebhookUrl(
    conversationUuid: string,
    params: { source: string; context?: string },
  ): string {
    return this.webhookUrl('/webhooks/twilio/voice/status', {
      conversationUuid,
      ...params,
    });
  }

  private webhookUrl(path: string, params: Record<string, string>): string {
    const { config } = this.requireVoice();
    const url = new URL(path, `${config.webhookBaseUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}

/**
 * Twilio echoes the label back in conference webhooks, which is how a leg
 * is matched to a participant. The nonce keeps labels unique per conference.
 */
function participantLabel(participant: CallParticipant): string {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `${participant.participantType}|${encodeURIComponent(participant.participantId)}|${nonce}`;
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  if ('status' in error && typeof error.status === 'number') {
    return error.status;
  }

  return undefined;
}
