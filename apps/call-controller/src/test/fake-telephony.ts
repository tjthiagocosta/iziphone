import type { Redis } from 'ioredis';
import { vi } from 'vitest';
import {
  TelephonyService,
  type TwilioClient,
  WRITE_CALL_STATE_SCRIPT,
} from '../calls/telephony.service.js';
import { createFakeLogger } from './fake-logger.js';
import { testControllerConfig } from './route-test-helpers.js';

/*
 * A real TelephonyService on an in-memory Redis and a scripted Twilio
 * client, so call flows are tested through the code that talks to Twilio
 * rather than around it.
 */

export function createFakeRedis() {
  const store = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  /** Seconds each key was written with, so a test can see what would expire. */
  const ttls = new Map<string, number | undefined>();
  let beforeCallStateWrite: (() => Promise<void>) | undefined;

  /** `WRITE_CALL_STATE_SCRIPT`, as Redis runs it: all at once. */
  const writeCallState = (keys: string[], args: string[]): number => {
    const [stateKey = '', liveKey = ''] = keys;
    const [version, payload, seconds, conversationUuid = ''] = args;
    const stored = store.get(stateKey);
    if (stored === undefined) return -1;
    if ((JSON.parse(stored).version ?? 0) !== Number(version)) return 0;
    if (payload === '') {
      store.delete(stateKey);
      sets.get(liveKey)?.delete(conversationUuid);
    } else if (payload !== undefined) {
      store.set(stateKey, payload);
      ttls.set(stateKey, Number(seconds));
    }
    return 1;
  };

  const redis = {
    eval: vi.fn(
      async (
        script: string,
        numberOfKeys: number,
        ...rest: Array<string | number>
      ) => {
        if (script !== WRITE_CALL_STATE_SCRIPT) {
          throw new Error('The fake Redis does not know this script');
        }
        // Another write landing between the read and this one, as a test
        // arranged; it runs once.
        const interloper = beforeCallStateWrite;
        beforeCallStateWrite = undefined;
        await interloper?.();
        const values = rest.map(String);
        return writeCallState(
          values.slice(0, numberOfKeys),
          values.slice(numberOfKeys),
        );
      },
    ),
    sadd: vi.fn(async (key: string, ...members: string[]) => {
      const set = sets.get(key) ?? new Set<string>();
      sets.set(key, set);
      const before = set.size;
      for (const member of members) set.add(member);
      return set.size - before;
    }),
    srem: vi.fn(async (key: string, ...members: string[]) => {
      let removed = 0;
      for (const member of members) {
        if (sets.get(key)?.delete(member)) removed += 1;
      }
      return removed;
    }),
    smembers: vi.fn(async (key: string) => [...(sets.get(key) ?? [])]),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(
      async (key: string, value: string, _mode?: 'EX', seconds?: number) => {
        store.set(key, value);
        ttls.set(key, seconds);
        return 'OK';
      },
    ),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    }),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
  };
  return {
    redis: redis as unknown as Redis,
    store,
    sets,
    ttls,
    /**
     * Run something (a decline, say) after the next change to a call state
     * has read the state and before it is written, once.
     */
    beforeNextCallStateWrite(hook: () => Promise<void>) {
      beforeCallStateWrite = hook;
    },
  };
}

export function createFakeTwilioClient() {
  let nextLeg = 1;
  const created: Array<Record<string, unknown>> = [];
  const updates: Array<{ legUuid: string; params: Record<string, unknown> }> =
    [];
  const participantUpdates: Array<{
    conferenceSid: string;
    legUuid: string;
    params: Record<string, unknown>;
  }> = [];
  const failures = new Map<string, unknown>();
  /** What Twilio says of a leg when asked; `in-progress` unless set. */
  const legStatuses = new Map<string, string>();
  const unknownLegs = new Set<string>();
  const fetched: string[] = [];
  let beforeCreate: (() => Promise<void>) | undefined;
  let beforeHold: (() => Promise<void>) | undefined;
  let holdFailure: unknown;
  let holdAnswer: boolean | undefined;
  let conferenceSids = ['CFconference1'];

  const client = {
    api: {
      accounts: () => ({ fetch: vi.fn(async () => ({ sid: 'ACfake' })) }),
    },
    calls: (legUuid: string) => ({
      update: async (params: Record<string, unknown>) => {
        const failure = failures.get(legUuid);
        if (failure) throw failure;
        updates.push({ legUuid, params });
        if (params.status === 'completed') {
          legStatuses.set(legUuid, 'completed');
        }
        return { sid: legUuid };
      },
      fetch: async () => {
        fetched.push(legUuid);
        const failure = failures.get(legUuid);
        if (failure) throw failure;
        if (unknownLegs.has(legUuid)) {
          throw Object.assign(
            new Error('The requested resource was not found'),
            {
              status: 404,
            },
          );
        }
        const status = legStatuses.get(legUuid) ?? 'in-progress';
        return { sid: legUuid, status, duration: '42' };
      },
    }),
    conferences: Object.assign(
      (conferenceSid: string) => ({
        participants: Object.assign(
          (legUuid: string) => ({
            update: async (params: Record<string, unknown>) => {
              await beforeHold?.();
              if (holdFailure) throw holdFailure;
              participantUpdates.push({ conferenceSid, legUuid, params });
              return {
                callSid: legUuid,
                hold: holdAnswer ?? params.hold === true,
              };
            },
          }),
          {
            create: async (params: Record<string, unknown>) => {
              await beforeCreate?.();
              const failure = failures.get(String(params.to));
              if (failure) throw failure;
              created.push({ conferenceSid, ...params });
              return { callSid: `CAleg${nextLeg++}` };
            },
          },
        ),
      }),
      {
        list: vi.fn(async () => conferenceSids.map((sid) => ({ sid }))),
      },
    ),
  };

  return {
    client: client as unknown as TwilioClient,
    /** Participants created through `participants.create`, in order. */
    created,
    /** `calls(sid).update(...)` calls: hangups and TwiML redirects. */
    updates,
    participantUpdates,
    /** Run something (a hangup, say) while Twilio is creating a participant. */
    whileCreating(hook: () => Promise<void>) {
      beforeCreate = hook;
    },
    /** Run something (a decline, say) while Twilio is holding a participant. */
    whileHolding(hook: () => Promise<void>) {
      beforeHold = hook;
    },
    /** Make holding and resuming throw, or work again with `undefined`. */
    failHoldWith(error: unknown) {
      holdFailure = error;
    },
    /** Make Twilio answer every hold and resume with this flag, whatever was asked. */
    answerHoldsWith(hold: boolean) {
      holdAnswer = hold;
    },
    /** Twilio lists no conference in progress, as once everybody has left. */
    endConference() {
      conferenceSids = [];
    },
    /** The hold flag of every participant update, in order. */
    holds: () => participantUpdates.map((update) => update.params.hold),
    /**
     * What Twilio answers when asked about the leg from now on, as when its
     * status callback never arrived. A leg hung up here reads `completed`.
     */
    reportLeg(legUuid: string, status: string) {
      legStatuses.set(legUuid, status);
    },
    /** Twilio answers 404 when asked about the leg. */
    forgetLeg(legUuid: string) {
      unknownLegs.add(legUuid);
    },
    /** The legs Twilio was asked about, in order. */
    fetched,
    /** Make the next operation on a leg id or dial target throw. */
    failWith(target: string, error: unknown) {
      failures.set(target, error);
    },
    hangups: () =>
      updates
        .filter((u) => u.params.status === 'completed')
        .map((u) => u.legUuid),
    redirects: () => updates.filter((u) => typeof u.params.twiml === 'string'),
  };
}

export function createFakeTelephony() {
  const { redis, store, sets, ttls, beforeNextCallStateWrite } =
    createFakeRedis();
  const twilio = createFakeTwilioClient();
  const config = testControllerConfig.twilio;
  if (!config) {
    throw new Error('test config must include Twilio');
  }

  const telephonyLog = createFakeLogger();
  const telephony = new TelephonyService({
    redis,
    voice: { config, client: twilio.client },
    internalApi: testControllerConfig.internalApi,
    log: telephonyLog,
  });

  return {
    telephony,
    twilio,
    store,
    sets,
    ttls,
    telephonyLog,
    beforeNextCallStateWrite,
  };
}
