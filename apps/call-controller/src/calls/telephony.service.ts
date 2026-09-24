import { randomBytes } from 'node:crypto';
import { callLine, normalizePhoneNumber } from '@repo/dto';
import { OUTBOUND_GRANT, TELEPHONY } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import twilio from 'twilio';
import type { TwilioVoiceConfig } from '../config.js';
import {
  chooseVoicemailGreeting,
  maskPhoneNumber,
  probeGreetingUrl,
  VOICEMAIL_REASONS,
  type VoicemailGreeting,
  type VoicemailReason,
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
 * an outbound call is placed on until the call starts, under the `TELEPHONY`
 * and `OUTBOUND_GRANT` keys of `@repo/events`.
 */

const STATE_TTL_SECONDS = 4 * 60 * 60;
const DEFAULT_RING_SECONDS = 30;
const INTERNAL_API_TIMEOUT_MS = 3000;
/** Twilio refuses longer TwiML passed inline on a call update (error 32018). */
const INLINE_TWIML_MAX_LENGTH = 4000;

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

export type TelephonyRedis = Pick<
  Redis,
  'get' | 'set' | 'del' | 'getdel' | 'eval' | 'sadd' | 'srem' | 'smembers'
>;

/**
 * How many times a change to a call is decided before it gives up. Each
 * attempt that loses was beaten by a write that did land, so running out
 * takes ten writes to one call landing during one change. The most that
 * arrive together come from a department ring: when one member answers,
 * everybody else's leg is hung up at once and each reports its end. The
 * pause between attempts spreads those out, so that each settles in a few.
 */
export const CALL_STATE_WRITE_ATTEMPTS = 10;

/**
 * The pause before a change that lost is decided again, in ms, grown by the
 * attempt: writers that collided would otherwise read and collide again in
 * step. A random part of it sets them apart.
 */
const CALL_STATE_RETRY_PAUSE_MS = 5;

/**
 * Writes a call's state only if it is still at the version the change was
 * decided on, or forgets the call. Answers 1 when it wrote, 0 when another
 * write got there first, and -1 when the call is gone. A state stored before
 * versions existed counts as version 0.
 *
 * KEYS: the call's state, the set of live calls.
 * ARGV: the version read, the new state (empty to forget the call), its
 * expiry in seconds, the conversation id.
 */
export const WRITE_CALL_STATE_SCRIPT = `
local stored = redis.call('GET', KEYS[1])
if not stored then return -1 end
if (cjson.decode(stored).version or 0) ~= tonumber(ARGV[1]) then return 0 end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[4])
else
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
end
return 1
`;

/**
 * A call kept changing under a write that tried `CALL_STATE_WRITE_ATTEMPTS`
 * times, and nothing of the change was written. A webhook that meets it
 * answers 500, and Twilio does not send a status callback again, so what it
 * reported is lost until the claim renewal next asks Twilio about the call's
 * legs (`CallFlow.renewClaims`). A softphone request that meets it fails and
 * can be made again.
 */
export class CallStateConflictError extends Error {
  constructor(readonly conversationUuid: string) {
    super(
      `Call ${conversationUuid} changed under every one of ${CALL_STATE_WRITE_ATTEMPTS} attempts to update it`,
    );
    this.name = 'CallStateConflictError';
  }
}

/** What a change to a call decided, handed back by its decision function. */
export interface CallStateChange<R> {
  /** What the caller acts on once the change has been written. */
  result: R;
  /** Forget the call instead of saving the draft. */
  remove?: boolean;
}

export interface CallStateUpdate<R> {
  result: R;
  /** The state the change was decided on. */
  before: CallState;
  /** The state stored now: `before` when nothing changed, null once removed. */
  after: CallState | null;
}

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
      `${TELEPHONY.CALL_KEY_PREFIX}${conversationUuid}`,
    );
    if (!payload) {
      return null;
    }
    // This service is the only writer, so the shape is trusted. A call that
    // was already going when versions were introduced has none yet.
    const state = JSON.parse(payload) as CallState;
    return { ...state, version: state.version ?? 0 };
  }

  /** Store the first state of a new call. Resolves to it, at version 1. */
  async createCallState(state: Omit<CallState, 'version'>): Promise<CallState> {
    const created: CallState = { ...state, version: 1 };
    await this.deps.redis.set(
      `${TELEPHONY.CALL_KEY_PREFIX}${created.conversationUuid}`,
      JSON.stringify(created),
      'EX',
      STATE_TTL_SECONDS,
    );
    await this.deps.redis.sadd(
      TELEPHONY.LIVE_CALLS_KEY,
      created.conversationUuid,
    );
    return created;
  }

  /**
   * Change a call's state from what it is now. `decide` gets a copy of the
   * current state to change in place and says what it decided; the draft is
   * written only if it differs, and only if no other write landed since it
   * was read. When one did, the state is read again and `decide` runs again
   * on it, so it must do nothing but decide: effects belong after this
   * resolves, on its result. Resolves to null when there is no such call.
   * Throws `CallStateConflictError` once the attempts run out.
   */
  async updateCallState<R>(
    conversationUuid: string,
    decide: (draft: CallState) => CallStateChange<R>,
  ): Promise<CallStateUpdate<R> | null> {
    for (let attempt = 1; attempt <= CALL_STATE_WRITE_ATTEMPTS; attempt += 1) {
      const before = await this.getCallState(conversationUuid);
      if (!before) {
        return null;
      }

      const draft = structuredClone(before);
      const { result, remove = false } = decide(draft);
      const unchanged =
        !remove &&
        JSON.stringify({ ...draft, version: before.version }) ===
          JSON.stringify(before);
      if (unchanged) {
        return { result, before, after: before };
      }

      const after: CallState | null = remove
        ? null
        : { ...draft, version: before.version + 1 };
      const written = await this.deps.redis.eval(
        WRITE_CALL_STATE_SCRIPT,
        2,
        `${TELEPHONY.CALL_KEY_PREFIX}${conversationUuid}`,
        TELEPHONY.LIVE_CALLS_KEY,
        before.version,
        after ? JSON.stringify(after) : '',
        STATE_TTL_SECONDS,
        conversationUuid,
      );
      if (written === 1) {
        return { result, before, after };
      }
      if (written === -1) {
        return null;
      }
      if (attempt < CALL_STATE_WRITE_ATTEMPTS) {
        const pause =
          CALL_STATE_RETRY_PAUSE_MS * attempt * (0.5 + Math.random());
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }

    throw new CallStateConflictError(conversationUuid);
  }

  /** Every call that has a state, for the claim renewal. */
  async liveCallIds(): Promise<string[]> {
    return this.deps.redis.smembers(TELEPHONY.LIVE_CALLS_KEY);
  }

  /** Take a call whose state has expired out of the live set. */
  async forgetLiveCall(conversationUuid: string): Promise<void> {
    await this.deps.redis.srem(TELEPHONY.LIVE_CALLS_KEY, conversationUuid);
  }

  async setLegMetadata(legUuid: string, metadata: LegMetadata): Promise<void> {
    await this.deps.redis.set(
      `${TELEPHONY.LEG_KEY_PREFIX}${legUuid}`,
      JSON.stringify(metadata),
      'EX',
      STATE_TTL_SECONDS,
    );
  }

  async getLegMetadata(legUuid: string): Promise<LegMetadata | null> {
    const payload = await this.deps.redis.get(
      `${TELEPHONY.LEG_KEY_PREFIX}${legUuid}`,
    );
    return payload ? (JSON.parse(payload) as LegMetadata) : null;
  }

  async deleteLegMetadata(legUuids: string[]): Promise<void> {
    if (legUuids.length > 0) {
      await this.deps.redis.del(
        ...legUuids.map((legUuid) => `${TELEPHONY.LEG_KEY_PREFIX}${legUuid}`),
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
    await this.updateCallState(conversationUuid, (draft) => {
      draft.conferenceSid = conferenceSid;
      return { result: undefined };
    });
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

    const update = await this.updateCallState(conversationUuid, (draft) => {
      if (draft.ending) {
        return { result: false };
      }
      for (const leg of legs) {
        draft.agentLegs[leg.legUuid] = leg.userId;
      }
      draft.pendingAgentLegUuids = [
        ...new Set([
          ...draft.pendingAgentLegUuids,
          ...legs.map((leg) => leg.legUuid),
        ]),
      ];
      return { result: true };
    });

    if (!update?.result) {
      await Promise.all(legs.map((leg) => this.safeHangup(leg.legUuid)));
    }
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

    const update = await this.updateCallState(conversationUuid, (draft) => {
      if (draft.ending) {
        return { result: false };
      }
      draft.externalLegUuid = legUuid;
      return { result: true };
    });
    if (!update?.result) {
      await this.safeHangup(legUuid);
    }

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
    const update = await this.updateCallState(conversationUuid, (draft) => {
      if (!draft.ending) {
        draft.ending = true;
        draft.endingRequestedAt = new Date().toISOString();
        draft.endingRequestedBy = initiatedBy;
        // The rings stay pending: a leg that never joined is still not on
        // the call while it is hung up, so a ring that lost to the answer
        // does not count as occupying its member again.
        draft.pendingTransferToUserId = undefined;
        draft.transferInitiatedBy = undefined;
        draft.transferOriginLegUuid = undefined;
      }
      return { result: undefined };
    });
    if (!update) {
      return null;
    }

    await this.hangupConversation(conversationUuid);

    return update.after;
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

  /**
   * What Twilio says a leg is doing now, for a call whose status callbacks
   * may have been lost: its `CallStatus`, and how long it lasted once it is
   * over. A leg Twilio does not know cannot still be on the call, and is
   * reported `completed`.
   */
  async fetchLegStatus(
    legUuid: string,
  ): Promise<{ status: string; duration?: number }> {
    const { client } = this.requireVoice();

    try {
      const leg = await client.calls(legUuid).fetch();
      const duration = Number.parseInt(leg.duration ?? '', 10);
      return Number.isNaN(duration)
        ? { status: leg.status }
        : { status: leg.status, duration };
    } catch (error) {
      if (responseStatus(error) === 404) {
        return { status: 'completed' };
      }
      throw error;
    }
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

  /**
   * Replace what a leg is doing with the voicemail prompt. Tolerates a leg
   * that has already ended: building the TwiML can wait up to two seconds
   * on the greeting probe, and the caller can hang up during that wait.
   */
  async redirectLegToVoicemail(
    legUuid: string,
    state: Pick<CallState, 'conversationUuid' | 'voicemailGreetingUrl'>,
    reason: VoicemailReason,
  ): Promise<void> {
    const { client } = this.requireVoice();
    const twiml = await this.buildVoicemailTwiml(state, reason);

    try {
      await client.calls(legUuid).update({ twiml });
    } catch (error) {
      if (responseStatus(error) === 404) {
        this.deps.log.info(
          { conversationUuid: state.conversationUuid, legUuid },
          'Leg ended before the voicemail redirect could be applied',
        );
        return;
      }
      throw error;
    }
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

  /**
   * Greet the caller and record their message. Takes the call state rather
   * than its id so that no voicemail can be built without the greeting the
   * called number asked for. A configured greeting is probed with a HEAD
   * request right here, because Twilio's <Play> aborts the whole document
   * (and never runs the <Record> after it) on a fetch it cannot complete or
   * parse as audio; only a confirmed greeting is ever played, everything else
   * gives way to the built-in words. The length guard runs first and skips
   * the probe entirely for a URL that could not be played anyway, since it
   * would not fit even a reachable recording into the TwiML.
   */
  async buildVoicemailTwiml(
    state: Pick<CallState, 'conversationUuid' | 'voicemailGreetingUrl'>,
    reason: VoicemailReason,
  ): Promise<string> {
    const { conversationUuid, voicemailGreetingUrl } = state;

    if (
      voicemailGreetingUrl &&
      !this.fitsInlineForEveryReason(conversationUuid, {
        kind: 'recording',
        url: voicemailGreetingUrl,
      })
    ) {
      // The URL stays out of the log; the length is what the warning is about.
      this.deps.log.warn(
        { conversationUuid, greetingUrlLength: voicemailGreetingUrl.length },
        'Voicemail greeting URL is too long for the TwiML; speaking the built-in greeting',
      );
      return this.renderVoicemailTwiml(
        conversationUuid,
        reason,
        chooseVoicemailGreeting(reason, undefined, undefined),
      );
    }

    const probeOutcome = voicemailGreetingUrl
      ? await probeGreetingUrl(voicemailGreetingUrl, { fetch })
      : undefined;

    if (voicemailGreetingUrl && probeOutcome !== 'reachable') {
      // The URL may carry a signed token; only its path is safe to log.
      this.deps.log.warn(
        {
          conversationUuid,
          greetingPath: new URL(voicemailGreetingUrl).pathname,
          outcome: probeOutcome,
        },
        'Voicemail greeting is not playable; speaking the built-in greeting instead',
      );
    }

    return this.renderVoicemailTwiml(
      conversationUuid,
      reason,
      chooseVoicemailGreeting(reason, voicemailGreetingUrl, probeOutcome),
    );
  }

  /*
   * A caller pulled out of the conference gets the voicemail as TwiML inside
   * an API request. Twilio refuses one that is too long, and the caller would
   * stay on hold. The size depends on the greeting URL as it is written into
   * the XML and on the reason in the callbacks, so the real document is
   * measured, for every reason: a number then plays its greeting to all of
   * its callers or to none, however they reached voicemail.
   */
  private fitsInlineForEveryReason(
    conversationUuid: string,
    greeting: VoicemailGreeting,
  ): boolean {
    return VOICEMAIL_REASONS.every(
      (reason) =>
        this.renderVoicemailTwiml(conversationUuid, reason, greeting).length <=
        INLINE_TWIML_MAX_LENGTH,
    );
  }

  private renderVoicemailTwiml(
    conversationUuid: string,
    reason: VoicemailReason,
    greeting: VoicemailGreeting,
  ): string {
    const response = new twilio.twiml.VoiceResponse();

    if (greeting.kind === 'recording') {
      response.play(greeting.url);
    } else {
      response.say({ voice: 'alice' }, greeting.text);
    }

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

    await this.ensureConferenceReference(state.conversationUuid, conferenceSid);

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
