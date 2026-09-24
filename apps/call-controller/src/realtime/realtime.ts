import type { Server as HttpServer } from 'node:http';
import type {
  CallTransferOutcome,
  IncomingCall,
  OwnAvailabilityResponse,
  UserAvailability,
} from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { CallOffer } from '../calls/index.js';
import { AvailabilityService } from './availability.service.js';
import { AvailabilityStore } from './availability-store.js';
import {
  type CallEndedBroadcaster,
  startCallEndedBroadcaster,
} from './call-ended-broadcaster.js';
import {
  type MessageActivityRelay,
  startMessageActivityRelay,
} from './message-activity-relay.js';
import { PresenceService } from './presence.service.js';
import { createSocketAuthMiddleware } from './socket-auth.js';
import { registerSocketHandlers } from './socket-handlers.js';
import { createSocketServer } from './socket-server.js';

/*
 * The softphone side of the service: Socket.IO connections from browsers,
 * who is online, who can take a call, and pushing calls to them.
 */

export interface Realtime {
  /**
   * Offer a call to those of these users who can take it, claiming each one
   * for it first; resolves to who was offered it and why the others were not.
   */
  offerCall(userIds: string[], call: IncomingCall): Promise<CallOffer>;
  /** Claim users for a call they placed, whatever their availability. */
  occupy(conversationUuid: string, userIds: string[]): Promise<void>;
  /** Let go of users a call no longer occupies. */
  release(conversationUuid: string, userIds: string[]): Promise<void>;
  /**
   * Keep a live call's claims on these users from running out, and claim
   * again any that already did.
   */
  renew(conversationUuid: string, userIds: string[]): Promise<void>;
  /** Where each of these users stands now. */
  availabilityOf(userIds: string[]): Promise<UserAvailability[]>;
  ownAvailability(userId: string): Promise<OwnAvailabilityResponse>;
  /** Turn do not disturb on or off for all of the user's softphones. */
  setDoNotDisturb(
    userId: string,
    on: boolean,
  ): Promise<OwnAvailabilityResponse>;
  /** Remember users who must hear that the call ended without being offered it. */
  trackCallParticipants(
    conversationUuid: string,
    userIds: string[],
  ): Promise<void>;
  /** Tell these users' softphones how a transfer ended. */
  notifyTransferOutcome(
    userIds: string[],
    outcome: CallTransferOutcome,
  ): Promise<void>;
  /**
   * Start listening for the channels whose only audience is the browsers:
   * `call:ended` and `message:activity`. Call once the app is ready.
   */
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RealtimeDependencies {
  httpServer: HttpServer;
  redis: Redis;
  log: FastifyBaseLogger;
  authSecret: string;
  corsOrigins: string[];
  onCallRejected(conversationUuid: string, userId: string): Promise<unknown>;
}

export function createRealtime(deps: RealtimeDependencies): Realtime {
  const presence = new PresenceService(deps.redis);
  const server = createSocketServer(
    deps.httpServer,
    deps.redis,
    deps.corsOrigins,
  );
  const availability = new AvailabilityService({
    store: new AvailabilityStore(deps.redis),
    presence,
    io: server.io,
    log: deps.log,
  });
  let broadcaster: CallEndedBroadcaster | null = null;
  let messageActivity: MessageActivityRelay | null = null;

  server.io.use(createSocketAuthMiddleware(deps.authSecret, deps.log));
  registerSocketHandlers(server.io, {
    presence,
    redis: deps.redis,
    authSecret: deps.authSecret,
    log: deps.log,
    onCallRejected: deps.onCallRejected,
    onConnectionChanged: (userId) => availability.connectionChanged(userId),
  });

  return {
    offerCall: (userIds, call) => availability.offerCall(userIds, call),
    occupy: (conversationUuid, userIds) =>
      availability.occupy(conversationUuid, userIds),
    release: (conversationUuid, userIds) =>
      availability.release(conversationUuid, userIds),
    renew: (conversationUuid, userIds) =>
      availability.renew(conversationUuid, userIds),
    availabilityOf: (userIds) => availability.availabilityOf(userIds),
    ownAvailability: (userId) => availability.ownAvailability(userId),
    setDoNotDisturb: (userId, on) => availability.setDoNotDisturb(userId, on),

    trackCallParticipants(conversationUuid, userIds) {
      return presence.addCallParticipants(conversationUuid, userIds);
    },

    async notifyTransferOutcome(userIds, outcome) {
      const sockets = await presence.socketIdsOf(userIds);
      for (const socketIds of sockets.values()) {
        server.io.to(socketIds).emit('call_transfer_outcome', outcome);
      }
    },

    async start() {
      broadcaster = await startCallEndedBroadcaster({
        redis: deps.redis,
        io: server.io,
        presence,
        log: deps.log,
      });
      messageActivity = await startMessageActivityRelay({
        redis: deps.redis,
        io: server.io,
        presence,
        log: deps.log,
      });
    },

    async close() {
      await broadcaster?.close();
      broadcaster = null;
      await messageActivity?.close();
      messageActivity = null;
      await server.close();
    },
  };
}
