import {
  type CallEndedEvent,
  CHANNELS,
  createChannelSubscriber,
} from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { PresenceService } from './presence.service.js';
import type { TypedSocketServer } from './socket-server.js';

export interface CallEndedBroadcaster {
  close(): Promise<void>;
}

/**
 * When a call ends, every softphone that was offered it hears so, whichever
 * controller instance published the event.
 */
export async function startCallEndedBroadcaster(deps: {
  redis: Pick<Redis, 'duplicate'>;
  io: Pick<TypedSocketServer, 'to'>;
  presence: Pick<
    PresenceService,
    'callParticipants' | 'socketIdsOf' | 'removeCallParticipants'
  >;
  log: FastifyBaseLogger;
}): Promise<CallEndedBroadcaster> {
  const connection = deps.redis.duplicate();

  const broadcast = async (event: CallEndedEvent): Promise<void> => {
    const { conversationUuid } = event;
    const participants = await deps.presence.callParticipants(conversationUuid);
    if (participants.length === 0) {
      return;
    }

    const sockets = await deps.presence.socketIdsOf(participants);
    const socketIds = [...sockets.values()].flat();
    // `to([])` addresses every socket there is, so an empty list must never
    // get as far as the emit.
    if (socketIds.length > 0) {
      deps.io.to(socketIds).emit('call_ended', {
        conversationUuid,
        status: event.status,
        duration: event.duration,
        endedAt: event.timestamp,
      });
    }

    await deps.presence.removeCallParticipants(conversationUuid);
    deps.log.info(
      {
        conversationUuid,
        offered: participants.length,
        notified: sockets.size,
        sockets: socketIds.length,
      },
      'Broadcast call_ended',
    );
  };

  await createChannelSubscriber(connection, deps.log)
    .on(CHANNELS.CALL_ENDED, broadcast)
    .start();

  return {
    async close() {
      await connection.quit();
    },
  };
}
