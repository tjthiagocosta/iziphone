import { CallRejectedSchema, UserSocketRegistrationSchema } from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type { PresenceService } from './presence.service.js';
import { registerTokenRefresh } from './socket-auth.js';
import type { TypedSocketServer } from './socket-server.js';

export interface SocketHandlerDependencies {
  presence: Pick<PresenceService, 'registerSocket' | 'unregisterSocket'>;
  authSecret: string;
  log: FastifyBaseLogger;
  /** The user declined an offered call. */
  onCallRejected(conversationUuid: string, userId: string): Promise<unknown>;
}

/** What a connected softphone can ask of this service. */
export function registerSocketHandlers(
  io: Pick<TypedSocketServer, 'on'>,
  deps: SocketHandlerDependencies,
): void {
  io.on('connection', (socket) => {
    const { userId } = socket.data;
    const log = deps.log.child({ userId, socketId: socket.id });

    log.info('Socket connected');
    registerTokenRefresh(socket, deps.authSecret);

    socket.on('register_user', async (data) => {
      const parsed = UserSocketRegistrationSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', {
          message: 'Invalid registration payload',
          code: 'REGISTRATION_FAILED',
        });
        return;
      }

      try {
        await deps.presence.registerSocket(
          userId,
          socket.id,
          parsed.data.deviceInfo,
        );
        log.info('Socket registered for calls');
      } catch (error) {
        log.error({ err: error }, 'Failed to register socket');
        socket.emit('error', {
          message: 'Failed to register socket',
          code: 'REGISTRATION_FAILED',
        });
      }
    });

    socket.on('call_reject', async (data) => {
      const parsed = CallRejectedSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', {
          message: 'Invalid call payload',
          code: 'CALL_REJECT_FAILED',
        });
        return;
      }

      const { conversationUuid } = parsed.data;
      try {
        await deps.onCallRejected(conversationUuid, userId);
        log.info({ conversationUuid }, 'Call rejected');
      } catch (error) {
        log.error({ err: error, conversationUuid }, 'Failed to reject call');
        socket.emit('error', {
          message: 'Failed to reject call',
          code: 'CALL_REJECT_FAILED',
        });
      }
    });

    socket.on('call_accept', (data) => {
      log.info(
        { conversationUuid: data.conversationUuid },
        'Softphone acknowledged the call',
      );
    });

    socket.on('disconnect', async (reason) => {
      log.info({ reason }, 'Socket disconnected');
      try {
        await deps.presence.unregisterSocket(userId, socket.id);
      } catch (error) {
        log.error({ err: error }, 'Failed to unregister socket');
      }
    });
  });
}
