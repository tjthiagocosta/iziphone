import { describe, expect, test } from 'vitest';
import { type PresenceRedis, PresenceService } from './presence.service.js';

/** Just enough of ioredis for presence: hashes, sets and a pipeline of hget. */
function buildFakeRedis() {
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  const ttls = new Map<string, number>();

  const redis = {
    async hset(key: string, values: Record<string, string>) {
      hashes.set(key, { ...hashes.get(key), ...values });
      return Object.keys(values).length;
    },
    async hget(key: string, field: string) {
      return hashes.get(key)?.[field] ?? null;
    },
    async expire(key: string, seconds: number) {
      ttls.set(key, seconds);
      return 1;
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) {
        if (hashes.delete(key) || sets.delete(key)) removed += 1;
      }
      return removed;
    },
    pipeline() {
      const commands: Array<() => Promise<unknown>> = [];
      const chain = {
        hget(key: string, field: string) {
          commands.push(() => redis.hget(key, field));
          return chain;
        },
        async exec() {
          return Promise.all(
            commands.map(async (command) => [null, await command()] as const),
          );
        },
      };
      return chain;
    },
    async sadd(key: string, ...members: string[]) {
      const set = sets.get(key) ?? new Set<string>();
      for (const member of members) set.add(member);
      sets.set(key, set);
      return members.length;
    },
    async smembers(key: string) {
      return [...(sets.get(key) ?? [])];
    },
  };

  return { redis: redis as unknown as PresenceRedis, ttls };
}

describe('PresenceService', () => {
  test('reports the socket of every registered user', async () => {
    const { redis, ttls } = buildFakeRedis();
    const presence = new PresenceService(redis);

    await presence.registerSocket('user-1', 'socket-1', { platform: 'web' });
    await presence.registerSocket('user-2', 'socket-2');

    await expect(
      presence.socketIdsOf(['user-1', 'user-2', 'user-3']),
    ).resolves.toEqual(
      new Map([
        ['user-1', 'socket-1'],
        ['user-2', 'socket-2'],
      ]),
    );
    expect(ttls.get('user:sockets:user-1')).toBe(24 * 60 * 60);
  });

  test('unregistering only removes the socket that disconnected', async () => {
    const { redis } = buildFakeRedis();
    const presence = new PresenceService(redis);

    await presence.registerSocket('user-1', 'socket-old');
    await presence.registerSocket('user-1', 'socket-new');
    await presence.unregisterSocket('user-1', 'socket-old');

    await expect(presence.socketIdsOf(['user-1'])).resolves.toEqual(
      new Map([['user-1', 'socket-new']]),
    );

    await presence.unregisterSocket('user-1', 'socket-new');
    await expect(presence.socketIdsOf(['user-1'])).resolves.toEqual(new Map());
  });

  test('tracks who was offered a call until the call is cleaned up', async () => {
    const { redis, ttls } = buildFakeRedis();
    const presence = new PresenceService(redis);

    await presence.addCallParticipants('CAcall1', ['user-1', 'user-2']);
    await presence.addCallParticipants('CAcall1', ['user-2']);
    await presence.addCallParticipants('CAcall1', []);

    await expect(presence.callParticipants('CAcall1')).resolves.toEqual([
      'user-1',
      'user-2',
    ]);
    expect(ttls.get('call:participants:CAcall1')).toBe(60 * 60);

    await presence.removeCallParticipants('CAcall1');
    await expect(presence.callParticipants('CAcall1')).resolves.toEqual([]);
  });
});
