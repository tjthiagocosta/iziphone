import type { IncomingCall } from '@repo/dto';
import { AVAILABILITY } from '@repo/events';
import { describe, expect, test, vi } from 'vitest';
import { createFakeAvailabilityRedis } from '../test/fake-availability-redis.js';
import { createFakeLogger } from '../test/fake-logger.js';
import { AvailabilityService, CLAIM_ATTEMPTS } from './availability.service.js';
import {
  AvailabilityStore,
  READ_AVAILABILITY_SCRIPT,
} from './availability-store.js';
import type { PresenceService } from './presence.service.js';
import type { TypedSocketServer } from './socket-server.js';

function callFor(conversationUuid: string): IncomingCall {
  return { conversationUuid, from: '+15555550123', to: '+15555550100' };
}

/** user-1 has two tabs open, user-2 one, user-3 none. */
function buildService(
  sockets: Record<string, string[]> = {
    'user-1': ['socket-1a', 'socket-1b'],
    'user-2': ['socket-2'],
  },
) {
  const fake = createFakeAvailabilityRedis();
  const store = new AvailabilityStore(fake.redis);
  const emitted: Array<{ to: string[]; event: string; payload: unknown }> = [];
  const to = vi.fn((socketIds: string[]) => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ to: socketIds, event, payload });
      return true;
    },
  }));
  const presence = {
    socketIdsOf: vi.fn<PresenceService['socketIdsOf']>(
      async (userIds) =>
        new Map(
          userIds.flatMap((userId) => {
            const ids = sockets[userId] ?? [];
            return ids.length > 0 ? [[userId, ids] as const] : [];
          }),
        ),
    ),
    addCallParticipants: vi.fn<PresenceService['addCallParticipants']>(
      async () => undefined,
    ),
  };
  const log = createFakeLogger();
  const service = new AvailabilityService({
    store,
    presence,
    io: { to } as unknown as Pick<TypedSocketServer, 'to'>,
    log,
  });

  const availabilityEvents = () =>
    emitted.filter((entry) => entry.event === 'user_availability');
  const offers = () =>
    emitted.filter((entry) => entry.event === 'incoming_call');

  return {
    service,
    store,
    presence,
    to,
    log,
    availabilityEvents,
    offers,
    ...fake,
  };
}

describe('AvailabilityService', () => {
  describe('offering a call', () => {
    test('offers it to every softphone of those who can take it and says why the rest cannot', async () => {
      const { service, offers, presence } = buildService({
        'user-1': ['socket-1a', 'socket-1b'],
        'user-2': ['socket-2'],
        'user-4': ['socket-4'],
      });
      await service.setDoNotDisturb('user-2', true);
      await service.occupy('CAother', ['user-4']);

      const offer = await service.offerCall(
        ['user-1', 'user-2', 'user-3', 'user-4'],
        callFor('CAcall1'),
      );

      expect(offer).toEqual({
        offered: ['user-1'],
        refused: [
          { userId: 'user-2', reason: 'dnd' },
          { userId: 'user-3', reason: 'offline' },
          { userId: 'user-4', reason: 'busy' },
        ],
      });
      expect(offers()).toEqual([
        {
          to: ['socket-1a', 'socket-1b'],
          event: 'incoming_call',
          payload: callFor('CAcall1'),
        },
      ]);
      expect(presence.addCallParticipants).toHaveBeenCalledWith('CAcall1', [
        'user-1',
      ]);
    });

    test('claims whoever it offers the call to, so no other call reaches them', async () => {
      const { service } = buildService();

      await service.offerCall(['user-1'], callFor('CAcall1'));
      const second = await service.offerCall(['user-1'], callFor('CAcall2'));

      expect(second).toEqual({
        offered: [],
        refused: [{ userId: 'user-1', reason: 'busy' }],
      });
    });

    test('offers a call again to somebody it already claims', async () => {
      const { service } = buildService();
      await service.offerCall(['user-1'], callFor('CAcall1'));

      await expect(
        service.offerCall(['user-1'], callFor('CAcall1')),
      ).resolves.toEqual({ offered: ['user-1'], refused: [] });
    });

    test('of two calls reaching for one free user at once, only one gets them', async () => {
      const { service } = buildService();

      const [first, second] = await Promise.all([
        service.offerCall(['user-1'], callFor('CAcall1')),
        service.offerCall(['user-1'], callFor('CAcall2')),
      ]);

      expect(
        [first, second].map((offer) => offer.offered.length).sort(),
      ).toEqual([0, 1]);
      expect([first, second].flatMap((offer) => offer.refused)).toEqual([
        { userId: 'user-1', reason: 'busy' },
      ]);
    });

    test('decides again when the user changed between the read and the claim', async () => {
      const { service, beforeNextClaim } = buildService();
      beforeNextClaim(async () => {
        await service.setDoNotDisturb('user-1', true);
      });

      await expect(
        service.offerCall(['user-1'], callFor('CAcall1')),
      ).resolves.toEqual({
        offered: [],
        refused: [{ userId: 'user-1', reason: 'dnd' }],
      });
    });

    test('takes a user whose availability keeps changing under it for busy', async () => {
      const { service, store, beforeNextClaim, log, offers } = buildService();
      const interfere = async () => {
        await store.claim('user-1', 'CAother', null);
        await store.release('user-1', 'CAother');
        beforeNextClaim(interfere);
      };
      beforeNextClaim(interfere);

      await expect(
        service.offerCall(['user-1'], callFor('CAcall1')),
      ).resolves.toEqual({
        offered: [],
        refused: [{ userId: 'user-1', reason: 'busy' }],
      });
      expect(offers()).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', attempts: CLAIM_ATTEMPTS }),
        expect.any(String),
      );
    });

    test('reads everybody it offers the call to in one trip', async () => {
      const { service, redis } = buildService({
        'user-1': ['socket-1a'],
        'user-2': ['socket-2'],
        'user-3': ['socket-3'],
      });

      await service.offerCall(
        ['user-1', 'user-2', 'user-3'],
        callFor('CAcall1'),
      );

      const reads = vi
        .mocked(redis.eval)
        .mock.calls.filter(([script]) => script === READ_AVAILABILITY_SCRIPT);
      // One for the offer, one to tell the three they are busy now.
      expect(reads).toHaveLength(2);
    });

    test('sends nothing to anybody when nobody can take it', async () => {
      const { service, to, presence } = buildService();

      await service.offerCall(['user-3'], callFor('CAcall1'));

      // `to([])` would address every socket there is.
      expect(to).not.toHaveBeenCalled();
      expect(presence.addCallParticipants).not.toHaveBeenCalled();
    });

    test('tells those it claimed, and only them, that they are busy now', async () => {
      const { service, availabilityEvents } = buildService();

      await service.offerCall(['user-1'], callFor('CAcall1'));

      expect(availabilityEvents()).toEqual([
        {
          to: ['socket-1a', 'socket-1b'],
          event: 'user_availability',
          payload: { userId: 'user-1', state: 'busy', revision: 1 },
        },
      ]);
    });
  });

  describe('claims', () => {
    test('a release frees the user for the next call and tells them', async () => {
      const { service, availabilityEvents } = buildService();
      await service.offerCall(['user-1', 'user-2'], callFor('CAcall1'));

      await service.release('CAcall1', ['user-2']);

      await expect(
        service.offerCall(['user-2'], callFor('CAcall2')),
      ).resolves.toMatchObject({ offered: ['user-2'] });
      expect(availabilityEvents()).toContainEqual({
        to: ['socket-2'],
        event: 'user_availability',
        payload: { userId: 'user-2', state: 'available', revision: 2 },
      });
    });

    test('releasing a user the call does not hold tells nobody anything', async () => {
      const { service, availabilityEvents } = buildService();

      await service.release('CAcall1', ['user-1']);

      expect(availabilityEvents()).toEqual([]);
    });

    test('a user who dials out is claimed even with do not disturb on', async () => {
      const { service } = buildService();
      await service.setDoNotDisturb('user-1', true);

      await service.occupy('CAout1', ['user-1']);
      await service.setDoNotDisturb('user-1', false);

      await expect(service.availabilityOf(['user-1'])).resolves.toEqual([
        { userId: 'user-1', state: 'busy', revision: 3 },
      ]);
    });

    test('a claim whose release was lost frees the user within its lifetime', async () => {
      const { service, clock } = buildService();
      await service.offerCall(['user-1'], callFor('CAcall1'));

      clock.now += AVAILABILITY.CLAIM_LIFETIME_MS;

      await expect(
        service.offerCall(['user-1'], callFor('CAcall2')),
      ).resolves.toMatchObject({ offered: ['user-1'] });
    });

    test('a renewed claim keeps the user busy for as long as the call goes on', async () => {
      const { service, clock } = buildService();
      await service.offerCall(['user-1'], callFor('CAcall1'));

      for (let round = 0; round < 4; round += 1) {
        clock.now += AVAILABILITY.CLAIM_RENEW_INTERVAL_MS;
        await service.renew('CAcall1', ['user-1']);
      }

      await expect(
        service.offerCall(['user-1'], callFor('CAcall2')),
      ).resolves.toMatchObject({ offered: [] });
    });

    test('a renewal claims again a user still on the call whose claim ran out, and tells them', async () => {
      const { service, clock, availabilityEvents } = buildService();
      await service.offerCall(['user-1'], callFor('CAcall1'));
      // The controller was down for longer than a claim lasts.
      clock.now += 2 * AVAILABILITY.CLAIM_LIFETIME_MS;

      await service.renew('CAcall1', ['user-1']);

      await expect(
        service.offerCall(['user-1'], callFor('CAcall2')),
      ).resolves.toMatchObject({ offered: [] });
      expect(availabilityEvents().at(-1)).toEqual({
        to: ['socket-1a', 'socket-1b'],
        event: 'user_availability',
        payload: { userId: 'user-1', state: 'busy', revision: 2 },
      });
    });

    test('a renewal of claims that still count tells nobody anything', async () => {
      const { service, clock, availabilityEvents } = buildService();
      await service.offerCall(['user-1'], callFor('CAcall1'));
      const told = availabilityEvents().length;

      clock.now += AVAILABILITY.CLAIM_RENEW_INTERVAL_MS;
      await service.renew('CAcall1', ['user-1']);

      expect(availabilityEvents()).toHaveLength(told);
    });

    test('claiming a user for a call they placed tells them once', async () => {
      const { service, availabilityEvents } = buildService();

      await service.occupy('CAout1', ['user-1']);
      await service.occupy('CAout1', ['user-1']);

      expect(availabilityEvents()).toEqual([
        {
          to: ['socket-1a', 'socket-1b'],
          event: 'user_availability',
          payload: { userId: 'user-1', state: 'busy', revision: 1 },
        },
      ]);
    });
  });

  describe('connections', () => {
    test('a softphone connecting moves the revision on, tells the user, and starts their time as free', async () => {
      const sockets: Record<string, string[]> = {};
      const { service, store, clock, availabilityEvents } =
        buildService(sockets);

      sockets['user-1'] = ['socket-1a'];
      await service.connectionChanged('user-1');

      expect(availabilityEvents()).toEqual([
        {
          to: ['socket-1a'],
          event: 'user_availability',
          payload: { userId: 'user-1', state: 'available', revision: 1 },
        },
      ]);
      await expect(store.read('user-1')).resolves.toMatchObject({
        availableSince: clock.now,
      });
    });

    test('the last softphone going away ends their time as free', async () => {
      const sockets: Record<string, string[]> = { 'user-1': ['socket-1a'] };
      const { service, store } = buildService(sockets);
      await service.connectionChanged('user-1');

      sockets['user-1'] = [];
      await service.connectionChanged('user-1');

      await expect(store.read('user-1')).resolves.toMatchObject({
        revision: 2,
        availableSince: null,
      });
    });

    test('an offer decided before the softphone went away takes nothing', async () => {
      const sockets: Record<string, string[]> = { 'user-1': ['socket-1a'] };
      const { service, beforeNextClaim, offers } = buildService(sockets);
      beforeNextClaim(async () => {
        sockets['user-1'] = [];
        await service.connectionChanged('user-1');
      });

      await expect(
        service.offerCall(['user-1'], callFor('CAcall1')),
      ).resolves.toEqual({
        offered: [],
        refused: [{ userId: 'user-1', reason: 'offline' }],
      });
      expect(offers()).toEqual([]);
    });
  });

  describe('do not disturb', () => {
    test('turning it on tells every softphone of the user and answers with where they stand', async () => {
      const { service, availabilityEvents } = buildService();

      await expect(service.setDoNotDisturb('user-1', true)).resolves.toEqual({
        availability: { userId: 'user-1', state: 'dnd', revision: 1 },
        doNotDisturb: true,
      });
      expect(availabilityEvents()).toEqual([
        {
          to: ['socket-1a', 'socket-1b'],
          event: 'user_availability',
          payload: { userId: 'user-1', state: 'dnd', revision: 1 },
        },
      ]);
    });

    test('asking for what is already so tells nobody anything', async () => {
      const { service, availabilityEvents } = buildService();

      await service.setDoNotDisturb('user-1', false);

      expect(availabilityEvents()).toEqual([]);
    });

    test('outlasts a call: once it ends, the user is still not disturbed', async () => {
      const { service } = buildService();
      await service.occupy('CAout1', ['user-1']);
      await service.setDoNotDisturb('user-1', true);

      await service.release('CAout1', ['user-1']);

      await expect(service.ownAvailability('user-1')).resolves.toEqual({
        availability: { userId: 'user-1', state: 'dnd', revision: 3 },
        doNotDisturb: true,
      });
    });

    test('is reported to a user whose softphone has not connected yet', async () => {
      const { service } = buildService({});
      await service.setDoNotDisturb('user-1', true);

      await expect(service.ownAvailability('user-1')).resolves.toEqual({
        availability: { userId: 'user-1', state: 'offline', revision: 1 },
        doNotDisturb: true,
      });
    });
  });

  test('reports where each user stands with the revision it was read at', async () => {
    const { service } = buildService();
    await service.occupy('CAcall1', ['user-2']);

    await expect(
      service.availabilityOf(['user-1', 'user-2', 'user-3', 'user-1']),
    ).resolves.toEqual([
      { userId: 'user-1', state: 'available', revision: 0 },
      { userId: 'user-2', state: 'busy', revision: 1 },
      { userId: 'user-3', state: 'offline', revision: 0 },
    ]);
  });

  test('remembers since when a user is free, until they no longer are', async () => {
    const { service, store, clock } = buildService();
    await service.occupy('CAcall1', ['user-1']);
    await service.release('CAcall1', ['user-1']);
    const freedAt = clock.now;

    clock.now += 60_000;
    await service.offerCall(['user-2'], callFor('CAcall2'));
    await expect(store.read('user-1')).resolves.toMatchObject({
      availableSince: freedAt,
    });

    await service.setDoNotDisturb('user-1', true);
    await expect(store.read('user-1')).resolves.toMatchObject({
      availableSince: null,
    });

    clock.now += 60_000;
    await service.setDoNotDisturb('user-1', false);
    await expect(store.read('user-1')).resolves.toMatchObject({
      availableSince: clock.now,
    });
  });
});
