import { AVAILABILITY } from '@repo/events';
import { describe, expect, test, vi } from 'vitest';
import { createFakeAvailabilityRedis } from '../test/fake-availability-redis.js';
import { AvailabilityStore } from './availability-store.js';

function buildStore() {
  const fake = createFakeAvailabilityRedis();
  return { store: new AvailabilityStore(fake.redis), ...fake };
}

describe('AvailabilityStore', () => {
  test('knows nothing of a user nobody has touched', async () => {
    const { store } = buildStore();

    await expect(store.read('user-1')).resolves.toEqual({
      userId: 'user-1',
      revision: 0,
      doNotDisturb: false,
      calls: [],
      availableSince: null,
    });
  });

  test('reads many users in one trip, in the order asked', async () => {
    const { store, redis } = buildStore();
    await store.claim('user-2', 'CAcall1', null);
    await store.setDoNotDisturb('user-3', true);
    const trips = vi.mocked(redis.eval).mock.calls.length;

    const users = await store.readMany(['user-3', 'user-1', 'user-2']);

    expect(vi.mocked(redis.eval).mock.calls.length).toBe(trips + 1);
    expect(users).toEqual([
      expect.objectContaining({ userId: 'user-3', doNotDisturb: true }),
      expect.objectContaining({ userId: 'user-1', revision: 0, calls: [] }),
      expect.objectContaining({ userId: 'user-2', calls: ['CAcall1'] }),
    ]);
  });

  describe('claims', () => {
    test('a claim at the revision it was decided on is taken and moves the revision on', async () => {
      const { store } = buildStore();

      await expect(store.claim('user-1', 'CAcall1', 0)).resolves.toEqual({
        revision: 1,
        added: true,
      });
      await expect(store.read('user-1')).resolves.toMatchObject({
        revision: 1,
        calls: ['CAcall1'],
      });
    });

    test('claiming again for the same call changes nothing, and says so', async () => {
      const { store } = buildStore();
      await store.claim('user-1', 'CAcall1', 0);

      await expect(store.claim('user-1', 'CAcall1', 1)).resolves.toEqual({
        revision: 1,
        added: false,
      });
      await expect(store.read('user-1')).resolves.toMatchObject({
        revision: 1,
        calls: ['CAcall1'],
      });
    });

    test('a claim decided on an older revision is refused and takes nothing', async () => {
      const { store } = buildStore();
      await store.claim('user-1', 'CAcall1', 0);

      await expect(store.claim('user-1', 'CAcall2', 0)).resolves.toBeNull();
      await expect(store.read('user-1')).resolves.toMatchObject({
        revision: 1,
        calls: ['CAcall1'],
      });
    });

    test('a claim without an expected revision is taken whatever the revision', async () => {
      const { store } = buildStore();
      await store.setDoNotDisturb('user-1', true);

      await expect(store.claim('user-1', 'CAcall1', null)).resolves.toEqual({
        revision: 2,
        added: true,
      });
      await expect(store.read('user-1')).resolves.toMatchObject({
        calls: ['CAcall1'],
      });
    });

    test('a release takes only that call off the user and moves the revision on', async () => {
      const { store } = buildStore();
      await store.claim('user-1', 'CAcall1', null);
      await store.claim('user-1', 'CAcall2', null);

      await expect(store.release('user-1', 'CAcall1')).resolves.toBe(3);
      await expect(store.read('user-1')).resolves.toMatchObject({
        revision: 3,
        calls: ['CAcall2'],
      });
    });

    test('releasing a call that holds no claim changes nothing', async () => {
      const { store } = buildStore();
      await store.claim('user-1', 'CAcall1', null);

      await expect(store.release('user-1', 'CAcall2')).resolves.toBeNull();
      await expect(store.read('user-1')).resolves.toMatchObject({
        revision: 1,
      });
    });

    test('a claim nobody renews stops counting once it is a lifetime old', async () => {
      const { store, clock } = buildStore();
      await store.claim('user-1', 'CAcall1', null);

      clock.now += AVAILABILITY.CLAIM_LIFETIME_MS - 1;
      await expect(store.read('user-1')).resolves.toMatchObject({
        calls: ['CAcall1'],
      });

      clock.now += 1;
      await expect(store.read('user-1')).resolves.toMatchObject({ calls: [] });
    });

    test('a renewed claim keeps counting past its first lifetime, and moves no revision on', async () => {
      const { store, clock } = buildStore();
      await store.claim('user-1', 'CAcall1', null);
      await store.claim('user-2', 'CAcall1', null);

      for (let round = 0; round < 5; round += 1) {
        clock.now += AVAILABILITY.CLAIM_RENEW_INTERVAL_MS;
        await expect(
          store.renew('CAcall1', ['user-1', 'user-2']),
        ).resolves.toEqual([]);
      }

      await expect(store.read('user-1')).resolves.toMatchObject({
        revision: 1,
        calls: ['CAcall1'],
      });
      await expect(store.read('user-2')).resolves.toMatchObject({
        revision: 1,
        calls: ['CAcall1'],
      });
    });

    test('renewing claims again a user whose claim ran out while the call went on, and says who', async () => {
      const { store, clock } = buildStore();
      await store.claim('user-1', 'CAcall1', null);
      await store.claim('user-2', 'CAcall1', null);
      // Nothing renewed them for longer than a claim lasts: the controller,
      // or Redis, was away.
      clock.now += 2 * AVAILABILITY.CLAIM_LIFETIME_MS;
      await expect(store.read('user-1')).resolves.toMatchObject({ calls: [] });
      await store.claim('user-2', 'CAcall2', null);

      await expect(
        store.renew('CAcall1', ['user-1', 'user-2']),
      ).resolves.toEqual(['user-1', 'user-2']);

      await expect(store.read('user-1')).resolves.toMatchObject({
        revision: 2,
        calls: ['CAcall1'],
      });
      await expect(store.read('user-2')).resolves.toMatchObject({
        revision: 3,
        calls: expect.arrayContaining(['CAcall1', 'CAcall2']),
      });
    });

    test('a claim taken again by a renewal refuses a claim decided before it', async () => {
      const { store, clock } = buildStore();
      await store.claim('user-1', 'CAcall1', null);
      clock.now += AVAILABILITY.CLAIM_LIFETIME_MS;
      const { revision } = await store.read('user-1');

      await store.renew('CAcall1', ['user-1']);

      await expect(
        store.claim('user-1', 'CAcall2', revision),
      ).resolves.toBeNull();
    });

    test('a claim that ran out does not stand in the way of the next one', async () => {
      const { store, clock } = buildStore();
      await store.claim('user-1', 'CAcall1', null);
      clock.now += AVAILABILITY.CLAIM_LIFETIME_MS;

      await expect(store.claim('user-1', 'CAcall2', 1)).resolves.toEqual({
        revision: 2,
        added: true,
      });
      await expect(store.read('user-1')).resolves.toMatchObject({
        calls: ['CAcall2'],
      });
    });
  });

  test('a change the store does not hold moves the revision on, so a claim decided before it is refused', async () => {
    const { store } = buildStore();
    const { revision } = await store.read('user-1');

    await expect(store.markChanged('user-1')).resolves.toBe(revision + 1);

    await expect(
      store.claim('user-1', 'CAcall1', revision),
    ).resolves.toBeNull();
  });

  describe('do not disturb', () => {
    test('turning it on or off moves the revision on only when it changes', async () => {
      const { store } = buildStore();

      await expect(store.setDoNotDisturb('user-1', true)).resolves.toEqual({
        revision: 1,
        changed: true,
      });
      await expect(store.setDoNotDisturb('user-1', true)).resolves.toEqual({
        revision: 1,
        changed: false,
      });
      await expect(store.setDoNotDisturb('user-1', false)).resolves.toEqual({
        revision: 2,
        changed: true,
      });
      await expect(store.read('user-1')).resolves.toMatchObject({
        doNotDisturb: false,
      });
    });

    test('stays on while calls claim and release the user', async () => {
      const { store } = buildStore();
      await store.setDoNotDisturb('user-1', true);

      await store.claim('user-1', 'CAcall1', null);
      await store.release('user-1', 'CAcall1');

      await expect(store.read('user-1')).resolves.toMatchObject({
        doNotDisturb: true,
        calls: [],
      });
    });
  });

  describe('available since', () => {
    test('is set when the user becomes free and kept while they stay free', async () => {
      const { store, clock } = buildStore();
      const firstFree = clock.now;

      await store.recordEligibility('user-1', 0, true);
      clock.now += 5000;
      await store.recordEligibility('user-1', 1, true);

      await expect(store.read('user-1')).resolves.toMatchObject({
        availableSince: firstFree,
      });
    });

    test('is cleared while the user cannot take a call, and starts again after', async () => {
      const { store, clock } = buildStore();
      await store.recordEligibility('user-1', 0, true);

      await store.recordEligibility('user-1', 1, false);
      await expect(store.read('user-1')).resolves.toMatchObject({
        availableSince: null,
      });

      clock.now += 5000;
      await store.recordEligibility('user-1', 2, true);
      await expect(store.read('user-1')).resolves.toMatchObject({
        availableSince: clock.now,
      });
    });

    test('ignores a decision read at an older revision than one already recorded', async () => {
      const { store } = buildStore();
      await store.recordEligibility('user-1', 2, false);

      await store.recordEligibility('user-1', 1, true);

      await expect(store.read('user-1')).resolves.toMatchObject({
        availableSince: null,
      });
    });
  });
});
