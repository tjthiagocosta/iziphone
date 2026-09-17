import type { Server as HttpServer } from 'node:http';
import type { CallTransferOutcome, IncomingCall } from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import {
  type CallEndedBroadcaster,
  startCallEndedBroadcaster,
} from './call-ended-broadcaster.js';
import { notifyIncomingCall } from './incoming-call-notifier.js';
import { PresenceService } from './presence.service.js';
import { createSocketAuthMiddleware } from './socket-auth.js';
import { registerSocketHandlers } from './socket-handlers.js';
import { createSocketServer } from './socket-server.js';

/*
 * The softphone side of the service: Socket.IO connections from browsers,
 * who is online, and pushing calls to them.
 */

export interface Realtime {
  /** Offer a call to the users who are online; resolves to the ids reached. */
  notifyIncomingCall(userIds: string[], call: IncomingCall): Promise<string[]>;
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
  /** Start listening for `call:ended`; call once the app is ready. */
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
  let broadcaster: CallEndedBroadcaster | null = null;

  server.io.use(createSocketAuthMiddleware(deps.authSecret, deps.log));
  registerSocketHandlers(server.io, {
    presence,
    redis: deps.redis,
    authSecret: deps.authSecret,
    log: deps.log,
    onCallRejected: deps.onCallRejected,
  });

  return {
    notifyIncomingCall(userIds, call) {
      return notifyIncomingCall({ io: server.io, presence }, userIds, call);
    },

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
    },

    async close() {
      await broadcaster?.close();
      broadcaster = null;
      await server.close();
    },
  };
}
