import type { Redis } from 'ioredis';
import { vi } from 'vitest';
import {
  TelephonyService,
  type TwilioClient,
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
  /** Seconds each key was written with, so a test can see what would expire. */
  const ttls = new Map<string, number | undefined>();
  const redis = {
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
  return { redis: redis as unknown as Redis, store, ttls };
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
        return { sid: legUuid };
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
  const { redis, store, ttls } = createFakeRedis();
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

  return { telephony, twilio, store, ttls, telephonyLog };
}
