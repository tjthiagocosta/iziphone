import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Guards the `/internal` routes the call controller uses. The controller
 * presents the shared INTERNAL_API_TOKEN as a bearer token.
 */
export function internalAuthHook(expectedToken: string) {
  const expected = Buffer.from(expectedToken);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? '';
    const presented = Buffer.from(
      header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '',
    );

    const matches =
      presented.length === expected.length &&
      timingSafeEqual(presented, expected);

    if (!matches) {
      request.log.warn(
        'Rejected internal request with a missing or wrong token',
      );
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  };
}
