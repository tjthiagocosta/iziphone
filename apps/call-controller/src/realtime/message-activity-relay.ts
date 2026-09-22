import {
  CHANNELS,
  createChannelSubscriber,
  type MessageActivityNotification,
} from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import type { PresenceService } from './presence.service.js';
import type { TypedSocketServer } from './socket-server.js';

/*
 * The API knows a conversation changed and who may see it; only this service
 * knows where those people's browsers are. So it relays the notification to
 * their sockets and understands nothing of it: the payload is ids, the browser
 * asks the API for the content, and this service keeps no message state and
 * needs no database.
 */

export interface MessageActivityRelay {
  close(): Promise<void>;
}

export async function startMessageActivityRelay(deps: {
  redis: Pick<Redis, 'duplicate'>;
  io: Pick<TypedSocketServer, 'to'>;
  presence: Pick<PresenceService, 'socketIdsOf'>;
  log: FastifyBaseLogger;
}): Promise<MessageActivityRelay> {
  // Subscribing puts a connection into subscriber mode, so it gets its own.
  const connection = deps.redis.duplicate();

  const relay = async ({
    userIds,
    ...activity
  }: MessageActivityNotification): Promise<void> => {
    const sockets = await deps.presence.socketIdsOf(userIds);
    const socketIds = [...sockets.values()].flat();
    // `to([])` addresses every socket there is, so an empty list must never
    // get as far as the emit. Everyone in the audience may simply be offline.
    if (socketIds.length === 0) {
      return;
    }

    deps.io.to(socketIds).emit('message_activity', activity);
    deps.log.debug(
      {
        conversationId: activity.conversationId,
        kind: activity.kind,
        notified: sockets.size,
        sockets: socketIds.length,
      },
      'Relayed message_activity',
    );
  };

  await createChannelSubscriber(connection, deps.log)
    .on(CHANNELS.MESSAGE_ACTIVITY, relay)
    .start();

  return {
    async close() {
      await connection.quit();
    },
  };
}
