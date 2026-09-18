/**
 * The part of the Fastify logger that services actually use. Naming it here
 * lets a command-line entry point hand a service a two-line logger without
 * standing a server up, and keeps the whole of `FastifyBaseLogger` out of
 * signatures that only ever write three kinds of line.
 */
export interface ServiceLogger {
  info(details: object, message: string): void;
  info(message: string): void;
  warn(details: object, message: string): void;
  warn(message: string): void;
  error(details: object, message: string): void;
  error(message: string): void;
}

/** Writes nothing. For a command that prints its own output. */
export const silentLogger: ServiceLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
