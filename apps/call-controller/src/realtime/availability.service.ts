import type {
  IncomingCall,
  OwnAvailabilityResponse,
  UnavailableReason,
  UserAvailability,
} from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type { CallOffer } from '../calls/index.js';
import { decideAvailability } from './availability-rule.js';
import type {
  AvailabilityStore,
  StoredAvailability,
} from './availability-store.js';
import type { PresenceService } from './presence.service.js';
import type { TypedSocketServer } from './socket-server.js';

/*
 * Who can be offered a call, and offering it: the rule applied to the
 * user's sockets, do not disturb and claims, then the claim taken at the
 * revision the rule was applied to, so that two calls deciding at once
 * cannot both take one free user. A user whose availability changed hears
 * of it on their own softphones, and on nobody else's.
 *
 * The store is always read before the sockets. A softphone connecting or
 * going away moves the revision on once presence has changed, so a decision
 * read the other way round could pair an old connection with the revision
 * that already counts its change, and a claim taken at it would stand.
 */

/**
 * How many times an offer reads a user again when their revision moved
 * between the read and the claim. Past it the user is taken for busy: their
 * availability is changing faster than the offer can settle, which only
 * other calls reaching for them at the same moment can explain.
 */
export const CLAIM_ATTEMPTS = 5;

export interface AvailabilityServiceDependencies {
  store: AvailabilityStore;
  presence: Pick<PresenceService, 'socketIdsOf' | 'addCallParticipants'>;
  io: Pick<TypedSocketServer, 'to'>;
  log: FastifyBaseLogger;
}

type ClaimOutcome =
  | { state: 'available'; socketIds: string[]; added: boolean }
  | { state: UnavailableReason };

export class AvailabilityService {
  constructor(private readonly deps: AvailabilityServiceDependencies) {}

  /**
   * Offer the call to every connected softphone of those users who can take
   * it, claiming each one first. A user the call already claims is offered
   * it again.
   */
  async offerCall(userIds: string[], call: IncomingCall): Promise<CallOffer> {
    const { store, presence, io } = this.deps;
    const { conversationUuid } = call;

    const unique = [...new Set(userIds)];
    const stored = await store.readMany(unique);
    const sockets = await presence.socketIdsOf(unique);
    const outcomes = await Promise.all(
      stored.map(async (user) => ({
        userId: user.userId,
        outcome: await this.claimIfAvailable(
          user,
          sockets.get(user.userId) ?? [],
          conversationUuid,
        ),
      })),
    );

    const offer: CallOffer = { offered: [], refused: [] };
    const socketIds: string[] = [];
    const claimed: string[] = [];
    for (const { userId, outcome } of outcomes) {
      if (outcome.state !== 'available') {
        offer.refused.push({ userId, reason: outcome.state });
        continue;
      }
      offer.offered.push(userId);
      socketIds.push(...outcome.socketIds);
      if (outcome.added) {
        claimed.push(userId);
      }
    }

    // Checked on the sockets, not the users: `to([])` addresses every socket
    // there is, so an empty list must never get as far as the emit.
    if (socketIds.length > 0) {
      await presence.addCallParticipants(conversationUuid, offer.offered);
      io.to(socketIds).emit('incoming_call', call);
    }

    await this.announceAll(claimed);
    return offer;
  }

  /** Claim users for a call they placed, whatever their availability. */
  async occupy(conversationUuid: string, userIds: string[]): Promise<void> {
    const claims = await Promise.all(
      [...new Set(userIds)].map(async (userId) => ({
        userId,
        claim: await this.deps.store.claim(userId, conversationUuid, null),
      })),
    );
    await this.announceAll(
      claims.filter(({ claim }) => claim?.added).map(({ userId }) => userId),
    );
  }

  async release(conversationUuid: string, userIds: string[]): Promise<void> {
    const releases = await Promise.all(
      [...new Set(userIds)].map(async (userId) => ({
        userId,
        revision: await this.deps.store.release(userId, conversationUuid),
      })),
    );
    await this.announceAll(
      releases
        .filter(({ revision }) => revision !== null)
        .map(({ userId }) => userId),
    );
  }

  /**
   * Keep the call's claims on these users from running out, and claim again
   * those whose claim already ran out, telling them they are busy again.
   */
  async renew(conversationUuid: string, userIds: string[]): Promise<void> {
    const restored = await this.deps.store.renew(conversationUuid, [
      ...new Set(userIds),
    ]);
    await this.announceAll(restored);
  }

  /**
   * One of the user's softphones connected or went away. Their revision moves
   * on, so an offer decided on the connection before it takes nothing, and
   * they hear where they stand now.
   */
  async connectionChanged(userId: string): Promise<void> {
    await this.deps.store.markChanged(userId);
    await this.announceAll([userId]);
  }

  /** Where each of these users stands now, for the transfer picker. */
  async availabilityOf(userIds: string[]): Promise<UserAvailability[]> {
    const unique = [...new Set(userIds)];
    const stored = await this.deps.store.readMany(unique);
    const sockets = await this.deps.presence.socketIdsOf(unique);

    return stored.map((user) =>
      availabilityFrom(user, sockets.get(user.userId)?.length ?? 0),
    );
  }

  async ownAvailability(userId: string): Promise<OwnAvailabilityResponse> {
    const stored = await this.deps.store.read(userId);
    const sockets = await this.deps.presence.socketIdsOf([userId]);

    return {
      availability: availabilityFrom(stored, sockets.get(userId)?.length ?? 0),
      doNotDisturb: stored.doNotDisturb,
    };
  }

  /**
   * Turn do not disturb on or off for every softphone of the user. It stays
   * as set until they change it again, whatever calls come and go.
   */
  async setDoNotDisturb(
    userId: string,
    on: boolean,
  ): Promise<OwnAvailabilityResponse> {
    const { changed } = await this.deps.store.setDoNotDisturb(userId, on);
    if (changed) {
      await this.announceAll([userId]);
    }
    return this.ownAvailability(userId);
  }

  /**
   * Claim the user for the call if the rule says they can take it, from a
   * first read made for the whole offer; each attempt after it reads the
   * user again.
   */
  private async claimIfAvailable(
    firstRead: StoredAvailability,
    firstSocketIds: string[],
    conversationUuid: string,
  ): Promise<ClaimOutcome> {
    const { store, presence, log } = this.deps;
    const { userId } = firstRead;
    let stored = firstRead;
    let socketIds = firstSocketIds;

    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        stored = await store.read(userId);
        socketIds = (await presence.socketIdsOf([userId])).get(userId) ?? [];
      }

      const state = decideAvailability(
        {
          sockets: socketIds.length,
          doNotDisturb: stored.doNotDisturb,
          calls: stored.calls,
        },
        conversationUuid,
      );
      if (state !== 'available') {
        return { state };
      }

      const claim = await store.claim(
        userId,
        conversationUuid,
        stored.revision,
      );
      if (claim) {
        return { state, socketIds, added: claim.added };
      }
    }

    log.warn(
      { conversationUuid, userId, attempts: CLAIM_ATTEMPTS },
      'Gave up claiming a user whose availability kept changing; taken for busy',
    );
    return { state: 'busy' };
  }

  /**
   * Tell each user's own softphones where they stand now, and keep
   * `availableSince` in step. A failure costs only the notice: the softphone
   * reads a snapshot when it reconnects, and the next change is sent anyway.
   */
  private async announceAll(userIds: string[]): Promise<void> {
    if (userIds.length === 0) {
      return;
    }

    const { store, presence, io, log } = this.deps;
    try {
      const stored = await store.readMany(userIds);
      const sockets = await presence.socketIdsOf(userIds);
      await Promise.all(
        stored.map(async (user) => {
          const socketIds = sockets.get(user.userId) ?? [];
          const availability = availabilityFrom(user, socketIds.length);
          await store.recordEligibility(
            user.userId,
            user.revision,
            availability.state === 'available',
          );
          if (socketIds.length > 0) {
            io.to(socketIds).emit('user_availability', availability);
          }
        }),
      );
    } catch (error) {
      log.warn(
        { err: error, userIds },
        'Failed to announce a change of availability',
      );
    }
  }
}

function availabilityFrom(
  stored: StoredAvailability,
  sockets: number,
): UserAvailability {
  return {
    userId: stored.userId,
    state: decideAvailability({
      sockets,
      doNotDisturb: stored.doNotDisturb,
      calls: stored.calls,
    }),
    revision: stored.revision,
  };
}
