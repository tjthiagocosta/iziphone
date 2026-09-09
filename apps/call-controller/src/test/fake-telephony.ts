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
  const redis = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (store.delete(key)) removed += 1;
      return removed;
    }),
  };
  return { redis: redis as unknown as Redis, store };
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
              participantUpdates.push({ conferenceSid, legUuid, params });
              return {};
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
        list: vi.fn(async () => [{ sid: 'CFconference1' }]),
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
  const { redis, store } = createFakeRedis();
  const twilio = createFakeTwilioClient();
  const config = testControllerConfig.twilio;
  if (!config) {
    throw new Error('test config must include Twilio');
  }

  const telephony = new TelephonyService({
    redis,
    voice: { config, client: twilio.client },
    internalApi: testControllerConfig.internalApi,
    log: createFakeLogger(),
  });

  return { telephony, twilio, store };
}
