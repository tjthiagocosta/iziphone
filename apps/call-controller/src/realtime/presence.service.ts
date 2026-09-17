import type { Redis } from 'ioredis';

/*
 * Who is online and who was offered which call, shared by every controller
 * instance through Redis.
 *
 *   presence:sockets:{userId}             sorted set of the user's socket ids,
 *                                         scored by when each was last seen (ms)
 *   call:participants:{conversationUuid}  set of user ids offered the call
 *
 * A user is online while at least one of their sockets was seen recently. The
 * controller holding a socket registers it again on every heartbeat for as
 * long as it stays connected, so neither another tab closing nor the age of
 * the connection takes the user offline. A socket whose controller died
 * without running its disconnect handler is no longer refreshed and stops
 * counting once it is stale.
 *
 * "Recently" is measured on Redis's clock, never on the instance's own. With
 * local clocks, an instance running ahead of the others would take their
 * sockets for stale, leave their users out of calls and prune their entries.
 */

// Not `user:sockets:`: earlier versions kept a hash under that name, and a
// sorted-set command on a leftover one fails with WRONGTYPE.
const SOCKET_KEY_PREFIX = 'presence:sockets:';
const CALL_PARTICIPANTS_PREFIX = 'call:participants:';
/** How often the controller holding a socket has to register it again. */
export const SOCKET_HEARTBEAT_MS = 30_000;
// Three heartbeats, so two in a row can be lost (Redis unreachable, a stalled
// event loop) before a connected user is taken for offline.
const SOCKET_STALE_AFTER_MS = 3 * SOCKET_HEARTBEAT_MS;
// Calls should not outlive this; the set is only for the call_ended fan-out.
const CALL_PARTICIPANTS_TTL_SECONDS = 60 * 60;

export type PresenceRedis = Pick<
  Redis,
  | 'time'
  | 'multi'
  | 'zrem'
  | 'expire'
  | 'del'
  | 'pipeline'
  | 'sadd'
  | 'smembers'
>;

export class PresenceService {
  constructor(private readonly redis: PresenceRedis) {}

  /**
   * Record that the socket is connected right now. Called when a softphone
   * registers and again on every heartbeat, which also restores an entry that
   * Redis lost.
   */
  async registerSocket(userId: string, socketId: string): Promise<void> {
    const key = `${SOCKET_KEY_PREFIX}${userId}`;
    const now = millisecondsOf(await this.redis.time());
    // One transaction, so the entry never exists without the expiry that
    // cleans up after a user who does not come back.
    const results = await this.redis
      .multi()
      .zadd(key, now, socketId)
      // Nobody unregisters the sockets of a controller that died; without
      // this they would pile up under a user who always has another one open.
      .zremrangebyscore(key, '-inf', now - SOCKET_STALE_AFTER_MS)
      .expire(key, Math.ceil(SOCKET_STALE_AFTER_MS / 1000))
      .exec();

    // `exec` resolves even when a command inside the transaction failed.
    if (!results) {
      throw new Error('Redis discarded the socket registration');
    }
    for (const [error] of results) {
      if (error) {
        throw error;
      }
    }
  }

  /** Forget a socket. The user's other sockets are left alone. */
  async unregisterSocket(userId: string, socketId: string): Promise<void> {
    await this.redis.zrem(`${SOCKET_KEY_PREFIX}${userId}`, socketId);
  }

  /** Ids of the connected sockets of each user, for the users who are online. */
  async socketIdsOf(userIds: string[]): Promise<Map<string, string[]>> {
    const online = new Map<string, string[]>();
    if (userIds.length === 0) {
      return online;
    }

    // TIME rides in the same pipeline: looking somebody up is on the path of
    // every incoming call, and this way it stays one trip to Redis.
    const pipeline = this.redis.pipeline().time();
    for (const userId of userIds) {
      pipeline.zrange(`${SOCKET_KEY_PREFIX}${userId}`, 0, '-1', 'WITHSCORES');
    }

    const [clock, ...replies] = (await pipeline.exec()) ?? [];
    if (!clock || clock[0]) {
      throw clock?.[0] ?? new Error('Redis did not answer the presence lookup');
    }
    const oldestLive = millisecondsOf(clock[1]) - SOCKET_STALE_AFTER_MS;

    replies.forEach(([error, reply], index) => {
      const userId = userIds[index];
      if (error || !userId || !Array.isArray(reply)) {
        return;
      }
      const socketIds = membersScoredAfter(reply, oldestLive);
      if (socketIds.length > 0) {
        online.set(userId, socketIds);
      }
    });

    return online;
  }

  async addCallParticipants(
    conversationUuid: string,
    userIds: string[],
  ): Promise<void> {
    if (userIds.length === 0) {
      return;
    }

    const key = `${CALL_PARTICIPANTS_PREFIX}${conversationUuid}`;
    await this.redis.sadd(key, ...userIds);
    await this.redis.expire(key, CALL_PARTICIPANTS_TTL_SECONDS);
  }

  async callParticipants(conversationUuid: string): Promise<string[]> {
    return this.redis.smembers(
      `${CALL_PARTICIPANTS_PREFIX}${conversationUuid}`,
    );
  }

  async removeCallParticipants(conversationUuid: string): Promise<void> {
    await this.redis.del(`${CALL_PARTICIPANTS_PREFIX}${conversationUuid}`);
  }
}

/** A TIME reply, seconds then the microseconds within them, in milliseconds. */
function millisecondsOf(timeReply: unknown): number {
  const [seconds, microseconds] = Array.isArray(timeReply) ? timeReply : [];
  // ioredis types the reply as numbers but hands over the strings Redis sent.
  const now = Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
  if (!Number.isFinite(now)) {
    throw new Error('Redis answered TIME with something unreadable');
  }
  return now;
}

/**
 * The members of a WITHSCORES reply scored after `threshold`. The reply is
 * flat (member, score, member, score...) with the scores as strings: ioredis
 * hands it over that way on either protocol unless told to map replies as
 * RESP3, which the type of the client this service takes rules out.
 */
function membersScoredAfter(reply: unknown[], threshold: number): string[] {
  const members: string[] = [];
  for (let index = 0; index + 1 < reply.length; index += 2) {
    const member = reply[index];
    if (typeof member === 'string' && Number(reply[index + 1]) > threshold) {
      members.push(member);
    }
  }
  return members;
}
