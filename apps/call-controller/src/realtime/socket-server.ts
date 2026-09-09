import type { Server as HttpServer } from 'node:http';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '@repo/dto';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';

export type TypedSocketServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export interface SocketServerHandle {
  io: TypedSocketServer;
  /** Drops every client and the adapter's Redis connections; leaves the HTTP server to Fastify. */
  close(): Promise<void>;
}

/**
 * Socket.IO on Fastify's HTTP server, with the Redis adapter so several
 * controller instances can reach any connected softphone.
 */
export function createSocketServer(
  httpServer: HttpServer,
  redis: Redis,
  corsOrigins: string[],
): SocketServerHandle {
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();

  const io: TypedSocketServer = new Server(httpServer, {
    cors: { origin: corsOrigins, methods: ['GET', 'POST'], credentials: true },
    pingTimeout: 60_000,
    pingInterval: 25_000,
    adapter: createAdapter(pubClient, subClient),
  });

  return {
    io,
    async close() {
      io.disconnectSockets(true);
      io.engine.close();
      await Promise.all([pubClient.quit(), subClient.quit()]);
    },
  };
}
