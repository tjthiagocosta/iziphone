import { AuthRefreshSchema } from '@repo/dto';
import { verifyJWT } from '@repo/events';
import type { FastifyBaseLogger } from 'fastify';
import type { TypedSocket } from './socket-server.js';

/*
 * Softphones connect with the realtime JWT the API issued, sent in the
 * handshake's `auth.token`. The token expires, so a connected client sends a
 * fresh one over `auth:refresh` before then.
 */

export function createSocketAuthMiddleware(
  authSecret: string,
  log: FastifyBaseLogger,
) {
  return (socket: TypedSocket, next: (error?: Error) => void): void => {
    const token: unknown = socket.handshake.auth.token;
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('Authentication failed: token required'));
      return;
    }

    verifyJWT(token, authSecret).then(
      (claims) => {
        socket.data.userId = claims.sub;
        socket.data.email = claims.email;
        socket.data.role = claims.role;
        socket.data.connectedAt = new Date().toISOString();
        next();
      },
      (error: unknown) => {
        log.warn({ err: error }, 'Socket authentication failed');
        next(new Error('Authentication failed: invalid token'));
      },
    );
  };
}

export function registerTokenRefresh(
  socket: TypedSocket,
  authSecret: string,
): void {
  socket.on('auth:refresh', async (data) => {
    const parsed = AuthRefreshSchema.safeParse(data);
    if (!parsed.success) {
      socket.emit('auth:refreshed', { success: false, error: 'Invalid token' });
      return;
    }

    try {
      const claims = await verifyJWT(parsed.data.token, authSecret);
      socket.data.userId = claims.sub;
      socket.data.email = claims.email;
      socket.data.role = claims.role;
      socket.emit('auth:refreshed', { success: true });
    } catch {
      socket.emit('auth:refreshed', { success: false, error: 'Invalid token' });
    }
  });
}
