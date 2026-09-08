import { PrismaPg } from '@prisma/adapter-pg';
import { type Prisma, PrismaClient } from './generated/prisma/client.js';

export interface PrismaClientOptions {
  /** PostgreSQL connection string. The pool opens on the first query. */
  connectionString: string;
  /** Prisma log levels written to stdout. Defaults to errors only. */
  log?: readonly Prisma.LogLevel[];
}

/**
 * Builds a Prisma client over the `pg` driver adapter. Callers own the
 * instance: create one per process and call `$disconnect()` on shutdown.
 */
export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: options.connectionString }),
    log: [...(options.log ?? ['error'])],
  });
}

export * from './generated/prisma/client.js';
