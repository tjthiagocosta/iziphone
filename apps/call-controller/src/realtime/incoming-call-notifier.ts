import type { IncomingCall } from '@repo/dto';
import type { PresenceService } from './presence.service.js';
import type { TypedSocketServer } from './socket-server.js';

/**
 * Offer a call to every connected softphone of the users who are online, on
 * whichever controller instance each is connected to. Resolves to the users
 * reached.
 */
export async function notifyIncomingCall(
  deps: {
    io: Pick<TypedSocketServer, 'to'>;
    presence: Pick<PresenceService, 'socketIdsOf' | 'addCallParticipants'>;
  },
  userIds: string[],
  call: IncomingCall,
): Promise<string[]> {
  const sockets = await deps.presence.socketIdsOf(userIds);
  const online = [...sockets.keys()];
  const socketIds = [...sockets.values()].flat();
  // Checked on the sockets, not the users: `to([])` addresses every socket
  // there is, so an empty list must never get as far as the emit.
  if (socketIds.length === 0) {
    return [];
  }

  await deps.presence.addCallParticipants(call.conversationUuid, online);
  deps.io.to(socketIds).emit('incoming_call', call);

  return online;
}
