import { AVAILABILITY } from '@repo/events';
import type { Redis } from 'ioredis';

/*
 * Do not disturb and the calls claiming each user, in Redis under the
 * `AVAILABILITY` keys of `@repo/events`. Every change is one script, so it
 * lands whole or not at all, and every change to either fact bumps the
 * user's revision, as does a softphone of theirs connecting or going away:
 * a claim is taken only at the revision its decision was read at, and a
 * softphone told of two changes keeps the later one.
 *
 * A claim is scored by when it was last renewed, on Redis's clock, and stops
 * counting once it is `CLAIM_LIFETIME_MS` old. Nothing has to remove it for
 * the user to be free again, which is what heals a release that was lost.
 */

export type AvailabilityRedis = Pick<Redis, 'eval'>;

/** What Redis holds about a user, apart from their sockets. */
export interface StoredAvailability {
  userId: string;
  revision: number;
  doNotDisturb: boolean;
  /** The calls whose claim on the user has not run out. */
  calls: string[];
  /** When the user last became free to take a call, in ms on Redis's clock. */
  availableSince: number | null;
}

// Lua numbers print with 14 significant digits by default; a time in
// milliseconds has 13, but `%.0f` keeps it whole whatever it grows to.
const NOW = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
`;

/**
 * KEYS: user and claims of each user, in pairs. ARGV: claim lifetime (ms).
 * Returns one entry per pair, in order.
 */
export const READ_AVAILABILITY_SCRIPT = `${NOW}
local oldest = string.format('(%.0f', now - tonumber(ARGV[1]))
local users = {}
for i = 1, #KEYS, 2 do
  local user = redis.call('HMGET', KEYS[i], 'revision', 'dnd', 'availableSince')
  local calls = redis.call('ZRANGEBYSCORE', KEYS[i + 1], oldest, '+inf')
  users[#users + 1] = { user[1] or '0', user[2] or '', user[3] or '', calls }
end
return users
`;

/**
 * KEYS: user, claims. ARGV: expected revision ('' to claim whatever it is),
 * call, claim lifetime (ms). Returns the revision after the claim and 1 if
 * the claim is new, or -1 when the revision moved on since it was read.
 */
export const CLAIM_SCRIPT = `
local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
if ARGV[1] ~= '' and tonumber(ARGV[1]) ~= revision then return { -1, 0 } end
${NOW}
local lifetime = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', string.format('%.0f', now - lifetime))
local added = redis.call('ZADD', KEYS[2], string.format('%.0f', now), ARGV[2])
redis.call('PEXPIRE', KEYS[2], lifetime)
if added == 1 then
  revision = redis.call('HINCRBY', KEYS[1], 'revision', 1)
end
return { revision, added }
`;

/**
 * KEYS: user, claims. ARGV: call. Returns the revision after the release, or
 * 0 when the call held no claim on the user.
 */
export const RELEASE_SCRIPT = `
if redis.call('ZREM', KEYS[2], ARGV[1]) == 0 then return 0 end
return redis.call('HINCRBY', KEYS[1], 'revision', 1)
`;

/**
 * KEYS: user and claims of each user, in pairs. ARGV: call, claim lifetime
 * (ms). Every claim is renewed, including one that ran out while the call
 * went on (the controller or Redis was away for longer than a lifetime): the
 * call still occupies the user, so it claims them again, and their revision
 * moves on as for any new claim. Returns the positions (from 1) of the pairs
 * whose claim was taken again that way.
 */
export const RENEW_SCRIPT = `${NOW}
local lifetime = tonumber(ARGV[2])
local restored = {}
for i = 1, #KEYS, 2 do
  local score = redis.call('ZSCORE', KEYS[i + 1], ARGV[1])
  redis.call('ZADD', KEYS[i + 1], string.format('%.0f', now), ARGV[1])
  redis.call('PEXPIRE', KEYS[i + 1], lifetime)
  if not score or tonumber(score) <= now - lifetime then
    redis.call('HINCRBY', KEYS[i], 'revision', 1)
    restored[#restored + 1] = (i + 1) / 2
  end
end
return restored
`;

/** KEYS: user. Returns the revision after. */
export const MARK_CHANGED_SCRIPT = `
return redis.call('HINCRBY', KEYS[1], 'revision', 1)
`;

/**
 * KEYS: user. ARGV: '1' to turn do not disturb on, '0' to turn it off.
 * Returns the revision after, and 1 if that changed anything.
 */
export const DO_NOT_DISTURB_SCRIPT = `
local on = redis.call('HEXISTS', KEYS[1], 'dnd') == 1
if on == (ARGV[1] == '1') then
  return { tonumber(redis.call('HGET', KEYS[1], 'revision') or '0'), 0 }
end
if ARGV[1] == '1' then
  redis.call('HSET', KEYS[1], 'dnd', '1')
else
  redis.call('HDEL', KEYS[1], 'dnd')
end
return { redis.call('HINCRBY', KEYS[1], 'revision', 1), 1 }
`;

/**
 * KEYS: user. ARGV: the revision the decision was read at, '1' if the user
 * could take a call then. A decision read at an older revision than the last
 * one recorded is dropped, so two of them finishing out of order cannot leave
 * a busy user looking free since some time.
 */
export const RECORD_ELIGIBILITY_SCRIPT = `
local seen = tonumber(redis.call('HGET', KEYS[1], 'sinceRevision') or '-1')
if tonumber(ARGV[1]) < seen then return 0 end
redis.call('HSET', KEYS[1], 'sinceRevision', ARGV[1])
if ARGV[2] ~= '1' then
  redis.call('HDEL', KEYS[1], 'availableSince')
elseif redis.call('HEXISTS', KEYS[1], 'availableSince') == 0 then
  ${NOW}
  redis.call('HSET', KEYS[1], 'availableSince', string.format('%.0f', now))
end
return 1
`;

export class AvailabilityStore {
  constructor(private readonly redis: AvailabilityRedis) {}

  async read(userId: string): Promise<StoredAvailability> {
    const [stored] = await this.readMany([userId]);
    if (!stored) {
      throw new Error('Redis answered the availability read unreadably');
    }
    return stored;
  }

  /** What Redis holds about each of these users, in their order, in one trip. */
  async readMany(userIds: string[]): Promise<StoredAvailability[]> {
    if (userIds.length === 0) {
      return [];
    }

    const reply = await this.redis.eval(
      READ_AVAILABILITY_SCRIPT,
      userIds.length * 2,
      ...userIds.flatMap(keysOf),
      AVAILABILITY.CLAIM_LIFETIME_MS,
    );
    if (!Array.isArray(reply) || reply.length !== userIds.length) {
      throw new Error('Redis answered the availability read unreadably');
    }

    return userIds.map((userId, index) => {
      const entry: unknown = reply[index];
      const [revision, dnd, since, calls] = Array.isArray(entry) ? entry : [];
      if (!Array.isArray(calls)) {
        throw new Error('Redis answered the availability read unreadably');
      }
      return {
        userId,
        revision: Number(revision),
        doNotDisturb: dnd === '1',
        calls: calls.map(String),
        availableSince: since ? Number(since) : null,
      };
    });
  }

  /**
   * Claim the user for a call. With an expected revision the claim is taken
   * only if nothing changed since that revision was read, and resolves to
   * null otherwise; with none it is taken regardless. Claiming again for the
   * same call only renews the claim, and says it added nothing.
   */
  async claim(
    userId: string,
    conversationUuid: string,
    expectedRevision: number | null,
  ): Promise<{ revision: number; added: boolean } | null> {
    const reply = await this.redis.eval(
      CLAIM_SCRIPT,
      2,
      ...keysOf(userId),
      expectedRevision ?? '',
      conversationUuid,
      AVAILABILITY.CLAIM_LIFETIME_MS,
    );

    const [revision, added] = Array.isArray(reply) ? reply : [];
    if (!(Number(revision) >= 0)) {
      return null;
    }
    return { revision: Number(revision), added: Number(added) === 1 };
  }

  /** Resolves to the revision after, or null when the call held no claim. */
  async release(
    userId: string,
    conversationUuid: string,
  ): Promise<number | null> {
    const revision = Number(
      await this.redis.eval(
        RELEASE_SCRIPT,
        2,
        ...keysOf(userId),
        conversationUuid,
      ),
    );
    return revision > 0 ? revision : null;
  }

  /**
   * Keep the call's claims on these users from running out, and claim again
   * any that already did. Resolves to the users claimed again.
   */
  async renew(conversationUuid: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) {
      return [];
    }

    const reply = await this.redis.eval(
      RENEW_SCRIPT,
      userIds.length * 2,
      ...userIds.flatMap(keysOf),
      conversationUuid,
      AVAILABILITY.CLAIM_LIFETIME_MS,
    );
    const restored = new Set(Array.isArray(reply) ? reply.map(Number) : []);
    return userIds.filter((_, index) => restored.has(index + 1));
  }

  /**
   * Move the user's revision on for a change the store does not hold, such
   * as a softphone connecting or going away: a claim decided before it is
   * refused, and what is announced after it outranks what was announced
   * before. Resolves to the revision after.
   */
  async markChanged(userId: string): Promise<number> {
    return Number(
      await this.redis.eval(MARK_CHANGED_SCRIPT, 1, userKey(userId)),
    );
  }

  async setDoNotDisturb(
    userId: string,
    on: boolean,
  ): Promise<{ revision: number; changed: boolean }> {
    const reply = await this.redis.eval(
      DO_NOT_DISTURB_SCRIPT,
      1,
      userKey(userId),
      on ? '1' : '0',
    );

    const [revision, changed] = Array.isArray(reply) ? reply : [];
    return { revision: Number(revision), changed: Number(changed) === 1 };
  }

  /** Keep `availableSince` in step with what the rule decided at this revision. */
  async recordEligibility(
    userId: string,
    revision: number,
    eligible: boolean,
  ): Promise<void> {
    await this.redis.eval(
      RECORD_ELIGIBILITY_SCRIPT,
      1,
      userKey(userId),
      revision,
      eligible ? '1' : '0',
    );
  }
}

/** A user's hash and claims, in the order the scripts take them. */
function keysOf(userId: string): [string, string] {
  return [userKey(userId), claimsKey(userId)];
}

function userKey(userId: string): string {
  return `${AVAILABILITY.USER_KEY_PREFIX}${userId}`;
}

function claimsKey(userId: string): string {
  return `${AVAILABILITY.CLAIMS_KEY_PREFIX}${userId}`;
}
