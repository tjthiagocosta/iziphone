import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type PresenceRedis,
  PresenceService,
  SOCKET_HEARTBEAT_MS,
} from './presence.service.js';

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

/**
 * Just enough of ioredis for presence: sorted sets, sets, transactions and
 * pipelines, and a clock of its own that the test moves, which TIME reports
 * and key expiry follows.
 */
function buildFakeRedis() {
  const clock = { now: Date.parse('2026-09-08T12:00:00.000Z') };
  const sortedSets = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const expiresAt = new Map<string, number>();
  const ttls = new Map<string, number>();

  const remove = (key: string) => {
    expiresAt.delete(key);
    const removedSortedSet = sortedSets.delete(key);
    return sets.delete(key) || removedSortedSet;
  };
  const dropIfExpired = (key: string) => {
    const deadline = expiresAt.get(key);
    if (deadline !== undefined && deadline <= clock.now) {
      remove(key);
    }
  };
  const bound = (value: number | string) => {
    const text = String(value);
    const exclusive = text.startsWith('(');
    const raw = exclusive ? text.slice(1) : text;
    const score =
      raw === '-inf' ? -Infinity : raw === '+inf' ? Infinity : Number(raw);
    return { score, exclusive };
  };
  const sortedSetAt = (key: string) => {
    dropIfExpired(key);
    if (sets.has(key)) {
      throw new Error(
        'WRONGTYPE Operation against a key holding the wrong kind of value',
      );
    }
    return sortedSets.get(key);
  };

  const zadd = (key: string, score: number, member: string) => {
    const sortedSet = sortedSetAt(key) ?? new Map<string, number>();
    const added = sortedSet.has(member) ? 0 : 1;
    sortedSet.set(member, score);
    sortedSets.set(key, sortedSet);
    return added;
  };
  const zrem = (key: string, ...members: string[]) => {
    const sortedSet = sortedSetAt(key);
    let removed = 0;
    for (const member of members) {
      if (sortedSet?.delete(member)) removed += 1;
    }
    // Redis deletes a sorted set when its last member goes.
    if (sortedSet?.size === 0) remove(key);
    return removed;
  };
  /** Members with their scores, in the order Redis keeps: by score, then by member. */
  const entriesOf = (key: string) =>
    [...(sortedSetAt(key) ?? [])].sort(
      ([memberA, a], [memberB, b]) => a - b || (memberA < memberB ? -1 : 1),
    );
  const zrangebyscore = (
    key: string,
    min: number | string,
    max: number | string,
  ) => {
    const low = bound(min);
    const high = bound(max);
    return entriesOf(key)
      .filter(
        ([, score]) =>
          (low.exclusive ? score > low.score : score >= low.score) &&
          (high.exclusive ? score < high.score : score <= high.score),
      )
      .map(([member]) => member);
  };
  // The strings Redis sends: whole seconds, then the microseconds within them.
  const time = () => [
    String(Math.floor(clock.now / SECOND)),
    String((clock.now % SECOND) * 1000),
  ];
  const expire = (key: string, seconds: number) => {
    dropIfExpired(key);
    if (!sortedSets.has(key) && !sets.has(key)) return 0;
    expiresAt.set(key, clock.now + seconds * SECOND);
    ttls.set(key, seconds);
    return 1;
  };

  /** Runs each queued command the way EXEC does: a failure is an entry, not a throw. */
  const buildChain = () => {
    const commands: Array<() => unknown> = [];
    const chain = {
      zadd(key: string, score: number, member: string) {
        commands.push(() => zadd(key, score, member));
        return chain;
      },
      zremrangebyscore(
        key: string,
        min: number | string,
        max: number | string,
      ) {
        commands.push(() => zrem(key, ...zrangebyscore(key, min, max)));
        return chain;
      },
      /** Only the whole set with its scores, which is all presence asks for. */
      zrange(key: string, _start: 0, _stop: '-1', _withScores: 'WITHSCORES') {
        commands.push(() =>
          entriesOf(key).flatMap(([member, score]) => [member, String(score)]),
        );
        return chain;
      },
      time() {
        commands.push(time);
        return chain;
      },
      expire(key: string, seconds: number) {
        commands.push(() => expire(key, seconds));
        return chain;
      },
      async exec() {
        return commands.map((command) => {
          try {
            return [null, command()] as const;
          } catch (error) {
            return [error, null] as const;
          }
        });
      },
    };
    return chain;
  };

  const redis = {
    async time() {
      return time();
    },
    multi: buildChain,
    pipeline: buildChain,
    async zrem(key: string, ...members: string[]) {
      return zrem(key, ...members);
    },
    async expire(key: string, seconds: number) {
      return expire(key, seconds);
    },
    async del(...keys: string[]) {
      let removed = 0;
      for (const key of keys) {
        dropIfExpired(key);
        if (remove(key)) removed += 1;
      }
      return removed;
    },
    async sadd(key: string, ...members: string[]) {
      dropIfExpired(key);
      const set = sets.get(key) ?? new Set<string>();
      for (const member of members) set.add(member);
      sets.set(key, set);
      return members.length;
    },
    async smembers(key: string) {
      dropIfExpired(key);
      return [...(sets.get(key) ?? [])];
    },
  };

  return {
    redis: redis as unknown as PresenceRedis,
    clock,
    ttls,
    /** Every key Redis still holds, with the members of each. */
    stored() {
      const keys = [...sortedSets.keys(), ...sets.keys()];
      for (const key of keys) dropIfExpired(key);
      return Object.fromEntries([
        ...[...sortedSets].map(([key, value]) => [key, [...value.keys()]]),
        ...[...sets].map(([key, value]) => [key, [...value]]),
      ]);
    },
  };
}

function buildPresence() {
  const fake = buildFakeRedis();
  return { ...fake, presence: new PresenceService(fake.redis) };
}

describe('PresenceService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('reports every connected socket of the users who are online', async () => {
    const { presence } = buildPresence();

    await presence.registerSocket('user-1', 'socket-laptop');
    await presence.registerSocket('user-1', 'socket-desk');
    await presence.registerSocket('user-2', 'socket-2');

    await expect(
      presence.socketIdsOf(['user-1', 'user-2', 'user-3']),
    ).resolves.toEqual(
      new Map([
        ['user-1', ['socket-desk', 'socket-laptop']],
        ['user-2', ['socket-2']],
      ]),
    );
  });

  test('a user stays online when another of their tabs closes', async () => {
    const { presence } = buildPresence();

    await presence.registerSocket('user-1', 'socket-tab-a');
    await presence.registerSocket('user-1', 'socket-tab-b');
    await presence.unregisterSocket('user-1', 'socket-tab-b');

    await expect(presence.socketIdsOf(['user-1'])).resolves.toEqual(
      new Map([['user-1', ['socket-tab-a']]]),
    );

    await presence.unregisterSocket('user-1', 'socket-tab-a');
    await expect(presence.socketIdsOf(['user-1'])).resolves.toEqual(new Map());
  });

  test('a disconnect that arrives after the reconnect leaves the new socket online', async () => {
    const { presence } = buildPresence();

    await presence.registerSocket('user-1', 'socket-old');
    await presence.registerSocket('user-1', 'socket-new');
    await presence.unregisterSocket('user-1', 'socket-old');

    await expect(presence.socketIdsOf(['user-1'])).resolves.toEqual(
      new Map([['user-1', ['socket-new']]]),
    );
  });

  test('a socket that keeps its heartbeat is online however long it has been connected', async () => {
    const { presence, clock } = buildPresence();
    await presence.registerSocket('user-1', 'socket-1');

    const connectedAt = clock.now;
    while (clock.now - connectedAt < 25 * HOUR) {
      clock.now += SOCKET_HEARTBEAT_MS;
      await presence.registerSocket('user-1', 'socket-1');
    }

    await expect(presence.socketIdsOf(['user-1'])).resolves.toEqual(
      new Map([['user-1', ['socket-1']]]),
    );
  });

  test('a socket survives two missed heartbeats, and is gone 90 seconds after the last one', async () => {
    const { presence, clock } = buildPresence();
    await presence.registerSocket('user-1', 'socket-1');

    clock.now += 90 * SECOND - 1;
    await expect(presence.socketIdsOf(['user-1'])).resolves.toEqual(
      new Map([['user-1', ['socket-1']]]),
    );

    clock.now += 1;
    await expect(presence.socketIdsOf(['user-1'])).resolves.toEqual(new Map());
  });

  test('sockets of a controller that died stop counting, then are forgotten', async () => {
    const { presence, clock, stored } = buildPresence();
    await presence.registerSocket('user-1', 'socket-on-dead-controller');
    await presence.registerSocket('user-2', 'socket-on-dead-controller-2');

    // Nothing unregisters them. user-1 reconnects to another instance, which
    // keeps the heartbeat of the new socket only.
    clock.now += 40 * SECOND;
    await presence.registerSocket('user-1', 'socket-reconnected');
    clock.now += SOCKET_HEARTBEAT_MS;
    await presence.registerSocket('user-1', 'socket-reconnected');

    clock.now += 25 * SECOND;
    await expect(presence.socketIdsOf(['user-1', 'user-2'])).resolves.toEqual(
      new Map([['user-1', ['socket-reconnected']]]),
    );

    clock.now += 5 * SECOND;
    await presence.registerSocket('user-1', 'socket-reconnected');
    expect(stored()).toEqual({
      'presence:sockets:user-1': ['socket-reconnected'],
    });
  });

  test('controller instances whose clocks disagree still see the sockets of one another', async () => {
    vi.useFakeTimers();
    const { redis } = buildFakeRedis();
    const instanceA = new PresenceService(redis);
    const instanceB = new PresenceService(redis);

    vi.setSystemTime('2026-09-08T12:00:00.000Z');
    await instanceA.registerSocket('user-1', 'socket-on-a');

    // Instance B runs an hour ahead; hardly any time has passed in between.
    vi.setSystemTime('2026-09-08T13:00:00.000Z');
    await instanceB.registerSocket('user-1', 'socket-on-b');

    await expect(instanceB.socketIdsOf(['user-1'])).resolves.toEqual(
      new Map([['user-1', ['socket-on-a', 'socket-on-b']]]),
    );
    vi.setSystemTime('2026-09-08T12:00:00.000Z');
    await expect(instanceA.socketIdsOf(['user-1'])).resolves.toEqual(
      new Map([['user-1', ['socket-on-a', 'socket-on-b']]]),
    );
  });

  test('refuses to guess who is online when Redis does not tell the time', async () => {
    const { presence, clock } = buildPresence();
    await presence.registerSocket('user-1', 'socket-1');

    clock.now = Number.NaN;

    await expect(presence.socketIdsOf(['user-1'])).rejects.toThrow(/TIME/);
    await expect(presence.registerSocket('user-1', 'socket-2')).rejects.toThrow(
      /TIME/,
    );
  });

  test('a registration Redis refuses is an error, not a user silently left offline', async () => {
    const { presence, redis } = buildPresence();
    // Something else already lives under the key, so the write is refused.
    await redis.sadd('presence:sockets:user-1', 'not-a-sorted-set');

    await expect(presence.registerSocket('user-1', 'socket-1')).rejects.toThrow(
      /WRONGTYPE/,
    );
  });

  test('a registration Redis discards is an error too', async () => {
    const { presence, redis } = buildPresence();
    const transaction = redis.multi();
    vi.spyOn(transaction, 'exec').mockResolvedValue(null);
    vi.spyOn(redis, 'multi').mockReturnValue(transaction);

    await expect(presence.registerSocket('user-1', 'socket-1')).rejects.toThrow(
      /discarded/,
    );
  });

  test('a user whose sockets cannot be read is left out without hiding who else is online', async () => {
    const { presence, redis } = buildPresence();
    await presence.registerSocket('user-1', 'socket-1');
    // Something else lives under this user's key, so reading it fails.
    await redis.sadd('presence:sockets:user-2', 'not-a-sorted-set');

    await expect(presence.socketIdsOf(['user-2', 'user-1'])).resolves.toEqual(
      new Map([['user-1', ['socket-1']]]),
    );
  });

  test('leaves nothing in Redis for a user whose sockets all disconnected', async () => {
    const { presence, stored } = buildPresence();

    await presence.registerSocket('user-1', 'socket-1');
    await presence.unregisterSocket('user-1', 'socket-1');

    expect(stored()).toEqual({});
  });

  test('tracks who was offered a call until the call is cleaned up', async () => {
    const { presence, ttls } = buildPresence();

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
