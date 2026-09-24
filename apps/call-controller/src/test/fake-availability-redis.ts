import type { Redis } from 'ioredis';
import { vi } from 'vitest';
import {
  CLAIM_SCRIPT,
  DO_NOT_DISTURB_SCRIPT,
  MARK_CHANGED_SCRIPT,
  READ_AVAILABILITY_SCRIPT,
  RECORD_ELIGIBILITY_SCRIPT,
  RELEASE_SCRIPT,
  RENEW_SCRIPT,
} from '../realtime/availability-store.js';

/*
 * The availability scripts as Redis runs them, each all at once, on hashes
 * and sorted sets held in memory, with a clock of its own that the test
 * moves: TIME reports it and key expiry follows it.
 */

export function createFakeAvailabilityRedis() {
  const clock = { now: Date.parse('2026-09-23T12:00:00.000Z') };
  const hashes = new Map<string, Map<string, string>>();
  const sortedSets = new Map<string, Map<string, number>>();
  const expiresAt = new Map<string, number>();
  let beforeNextClaim: (() => Promise<void>) | undefined;

  const hashAt = (key: string) => {
    const hash = hashes.get(key) ?? new Map<string, string>();
    hashes.set(key, hash);
    return hash;
  };
  const sortedSetAt = (key: string) => {
    const deadline = expiresAt.get(key);
    if (deadline !== undefined && deadline <= clock.now) {
      sortedSets.delete(key);
      expiresAt.delete(key);
    }
    const sortedSet = sortedSets.get(key) ?? new Map<string, number>();
    sortedSets.set(key, sortedSet);
    return sortedSet;
  };
  const bumpRevision = (userKey: string) => {
    const hash = hashAt(userKey);
    const revision = Number(hash.get('revision') ?? '0') + 1;
    hash.set('revision', String(revision));
    return revision;
  };
  /** The keys a script took in (user, claims) pairs. */
  const pairsOf = (keys: string[]) =>
    keys.flatMap((userKey, index) =>
      index % 2 === 0 ? [{ userKey, claimsKey: keys[index + 1] ?? '' }] : [],
    );

  const scripts = new Map<string, (keys: string[], args: string[]) => unknown>([
    [
      READ_AVAILABILITY_SCRIPT,
      (keys, [lifetime]) =>
        pairsOf(keys).map(({ userKey, claimsKey }) => {
          const hash = hashAt(userKey);
          const oldest = clock.now - Number(lifetime);
          const calls = [...sortedSetAt(claimsKey)]
            .filter(([, score]) => score > oldest)
            .map(([call]) => call);
          return [
            hash.get('revision') ?? '0',
            hash.get('dnd') ?? '',
            hash.get('availableSince') ?? '',
            calls,
          ];
        }),
    ],
    [
      CLAIM_SCRIPT,
      ([userKey = '', claimsKey = ''], [expected, call = '', lifetime]) => {
        const revision = Number(hashAt(userKey).get('revision') ?? '0');
        if (expected !== '' && Number(expected) !== revision) {
          return [-1, 0];
        }
        const claims = sortedSetAt(claimsKey);
        for (const [member, score] of claims) {
          if (score <= clock.now - Number(lifetime)) claims.delete(member);
        }
        const added = !claims.has(call);
        claims.set(call, clock.now);
        expiresAt.set(claimsKey, clock.now + Number(lifetime));
        return added ? [bumpRevision(userKey), 1] : [revision, 0];
      },
    ],
    [
      RELEASE_SCRIPT,
      ([userKey = '', claimsKey = ''], [call = '']) =>
        sortedSetAt(claimsKey).delete(call) ? bumpRevision(userKey) : 0,
    ],
    [
      RENEW_SCRIPT,
      (keys, [call = '', lifetime]) =>
        pairsOf(keys).flatMap(({ userKey, claimsKey }, index) => {
          const claims = sortedSetAt(claimsKey);
          const score = claims.get(call);
          claims.set(call, clock.now);
          expiresAt.set(claimsKey, clock.now + Number(lifetime));
          if (score !== undefined && score > clock.now - Number(lifetime)) {
            return [];
          }
          bumpRevision(userKey);
          return [index + 1];
        }),
    ],
    [MARK_CHANGED_SCRIPT, ([userKey = '']) => bumpRevision(userKey)],
    [
      DO_NOT_DISTURB_SCRIPT,
      ([userKey = ''], [on]) => {
        const hash = hashAt(userKey);
        if (hash.has('dnd') === (on === '1')) {
          return [Number(hash.get('revision') ?? '0'), 0];
        }
        if (on === '1') hash.set('dnd', '1');
        else hash.delete('dnd');
        return [bumpRevision(userKey), 1];
      },
    ],
    [
      RECORD_ELIGIBILITY_SCRIPT,
      ([userKey = ''], [revision, eligible]) => {
        const hash = hashAt(userKey);
        if (Number(revision) < Number(hash.get('sinceRevision') ?? '-1')) {
          return 0;
        }
        hash.set('sinceRevision', String(revision));
        if (eligible !== '1') hash.delete('availableSince');
        else if (!hash.has('availableSince')) {
          hash.set('availableSince', String(clock.now));
        }
        return 1;
      },
    ],
  ]);

  const redis = {
    eval: vi.fn(
      async (
        script: string,
        numberOfKeys: number,
        ...rest: Array<string | number>
      ) => {
        const run = scripts.get(script);
        if (!run) {
          throw new Error('The fake Redis does not know this script');
        }
        if (script === CLAIM_SCRIPT) {
          // Another change landing between an offer's read and its claim,
          // as a test arranged; it runs once.
          const interloper = beforeNextClaim;
          beforeNextClaim = undefined;
          await interloper?.();
        }
        const values = rest.map(String);
        return run(values.slice(0, numberOfKeys), values.slice(numberOfKeys));
      },
    ),
  };

  return {
    redis: redis as unknown as Redis,
    clock,
    hashes,
    /** Run something after the next claim was decided and before it is taken, once. */
    beforeNextClaim(hook: () => Promise<void>) {
      beforeNextClaim = hook;
    },
  };
}
