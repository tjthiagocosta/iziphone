import type { Redis } from 'ioredis';

/*
 * Who is online and who was offered which call, shared by every controller
 * instance through Redis.
 *
 *   user:sockets:{userId}                 hash: socketId, connectedAt, metadata
 *   call:participants:{conversationUuid}  set of user ids offered the call
 */

const SOCKET_KEY_PREFIX = 'user:sockets:';
const CALL_PARTICIPANTS_PREFIX = 'call:participants:';
const SOCKET_TTL_SECONDS = 24 * 60 * 60;
// Calls should not outlive this; the set is only for the call_ended fan-out.
const CALL_PARTICIPANTS_TTL_SECONDS = 60 * 60;

export type PresenceRedis = Pick<
  Redis,
  'hset' | 'hget' | 'expire' | 'del' | 'pipeline' | 'sadd' | 'smembers'
>;

export class PresenceService {
  constructor(private readonly redis: PresenceRedis) {}

  async registerSocket(
    userId: string,
    socketId: string,
    deviceInfo?: Record<string, unknown>,
  ): Promise<void> {
    const key = `${SOCKET_KEY_PREFIX}${userId}`;
    await this.redis.hset(key, {
      socketId,
      connectedAt: new Date().toISOString(),
      metadata: deviceInfo ? JSON.stringify(deviceInfo) : '',
    });
    await this.redis.expire(key, SOCKET_TTL_SECONDS);
  }

  /**
   * Forget a socket. A newer socket for the same user (a reconnect that
   * raced the old disconnect) is left alone.
   */
  async unregisterSocket(userId: string, socketId: string): Promise<void> {
    const key = `${SOCKET_KEY_PREFIX}${userId}`;
    const current = await this.redis.hget(key, 'socketId');
    if (current === socketId) {
      await this.redis.del(key);
    }
  }

  /** Socket id per user, for the users who are online. */
  async socketIdsOf(userIds: string[]): Promise<Map<string, string>> {
    const online = new Map<string, string>();
    if (userIds.length === 0) {
      return online;
    }

    const pipeline = this.redis.pipeline();
    for (const userId of userIds) {
      pipeline.hget(`${SOCKET_KEY_PREFIX}${userId}`, 'socketId');
    }

    const results = (await pipeline.exec()) ?? [];
    results.forEach(([error, socketId], index) => {
      const userId = userIds[index];
      if (!error && typeof socketId === 'string' && socketId && userId) {
        online.set(userId, socketId);
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
