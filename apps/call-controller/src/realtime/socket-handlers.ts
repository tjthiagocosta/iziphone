import { CallRejectedSchema, UserSocketRegistrationSchema } from '@repo/dto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import {
  type PresenceService,
  SOCKET_HEARTBEAT_MS,
} from './presence.service.js';
import { registerTokenRefresh } from './socket-auth.js';
import type { TypedSocketServer } from './socket-server.js';

export interface SocketHandlerDependencies {
  presence: Pick<PresenceService, 'registerSocket' | 'unregisterSocket'>;
  /** The connection presence is kept on; it says `ready` each time it is back. */
  redis: Pick<Redis, 'on'>;
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
  const refreshers = new Set<() => void>();

  // A Redis that was away for longer than presence remembers a socket comes
  // back knowing nobody. Left to the heartbeats, every agent would stay
  // offline, and their calls go to voicemail, for up to a whole interval more.
  deps.redis.on('ready', () => {
    for (const refresh of refreshers) {
      refresh();
    }
  });

  io.on('connection', (socket) => {
    const { userId } = socket.data;
    const log = deps.log.child({ userId, socketId: socket.id });

    log.info('Socket connected');
    registerTokenRefresh(socket, deps.authSecret);

    let registered = false;
    let closed = false;
    let refreshFailing = false;

    const unregister = async (): Promise<void> => {
      try {
        await deps.presence.unregisterSocket(userId, socket.id);
      } catch (error) {
        // Not retried: nothing refreshes a closed socket, so presence stops
        // counting it once it is stale.
        log.error({ err: error }, 'Failed to unregister socket');
      }
    };

    const register = async (): Promise<void> => {
      try {
        await deps.presence.registerSocket(userId, socket.id);
      } finally {
        // Registering takes more than one trip to Redis, so one under way
        // when the socket closes can land after the unregister and undo it;
        // even one that failed, if only its reply was lost.
        if (closed) {
          await unregister();
        }
      }
    };

    // The softphone registers once per connection, while presence forgets a
    // socket it has not heard of for a while so that a controller that died
    // cannot leave its users online; hence the repeat. The timer starts with
    // the socket, not with the registration: one still being stored when the
    // socket closes would start a timer after the disconnect that stops it,
    // and keep a closed socket online for good.
    const refresh = (): void => {
      if (!registered) {
        return;
      }
      register().then(
        () => {
          refreshFailing = false;
        },
        (error: unknown) => {
          // While Redis is away every socket fails every heartbeat; one line
          // per socket per outage says as much as one per attempt.
          if (!refreshFailing) {
            log.warn({ err: error }, 'Failed to refresh socket registration');
          }
          refreshFailing = true;
        },
      );
    };
    const heartbeat = setInterval(refresh, SOCKET_HEARTBEAT_MS);
    // Shutting down must not wait on a socket that was never disconnected.
    heartbeat.unref();
    refreshers.add(refresh);

    socket.on('register_user', async (data) => {
      const parsed = UserSocketRegistrationSchema.safeParse(data);
      if (!parsed.success) {
        socket.emit('error', {
          message: 'Invalid registration payload',
          code: 'REGISTRATION_FAILED',
        });
        return;
      }

      // Before the write: if it fails, the next heartbeat makes up for it.
      registered = true;
      try {
        await register();
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
      closed = true;
      clearInterval(heartbeat);
      refreshers.delete(refresh);
      log.info({ reason }, 'Socket disconnected');
      await unregister();
    });
  });
}
