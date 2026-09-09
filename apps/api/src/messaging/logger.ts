/**
 * The slice of a pino-style logger the messaging services use. `fastify.log`
 * satisfies it; tests pass a recording stub.
 */
export interface MessagingLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}
