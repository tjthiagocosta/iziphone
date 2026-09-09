import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { HttpError } from './http-error.js';

const STATUS_LABELS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/**
 * One error shape for the whole API: `{ error, message }`.
 *
 * A Zod failure means the client sent something the shared schemas reject,
 * so it is a 400 carrying the first issue. Rule violations raised by the
 * services carry their own status. Fastify's own 4xx errors (bad content
 * type, rate limit) keep theirs. Anything else is a 500 whose details stay
 * in the log.
 */
export function apiErrorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: STATUS_LABELS[400],
      message: error.issues[0]?.message ?? 'Invalid request',
    });
  }

  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  const isOwnError = error instanceof HttpError;

  if (
    typeof statusCode === 'number' &&
    (isOwnError || (statusCode >= 400 && statusCode < 500))
  ) {
    return reply.status(statusCode).send({
      error: STATUS_LABELS[statusCode] ?? 'Error',
      message: error.message,
    });
  }

  request.log.error({ error }, 'Unhandled request error');

  return reply.status(500).send({
    error: 'Internal Server Error',
    message: 'Internal Server Error',
  });
}
