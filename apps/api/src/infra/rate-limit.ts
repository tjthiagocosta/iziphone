import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

/**
 * Prefixes of the routes the limiter leaves alone, with the reason each one
 * cannot afford a 429. Everything else, health included, takes the global
 * limit.
 */
const EXEMPT_PATH_PREFIXES = [
  // Twilio treats a 4xx as a delivered failure and never retries it, so a
  // throttled webhook drops the inbound message or the delivery status for
  // good. These routes are guarded by the Twilio signature instead.
  '/webhooks/twilio/',
  // Twilio fetches MMS attachments and voicemail greetings from here by URL
  // while a message is going out or a call is in progress; a 429 on a <Play>
  // fetch aborts the TwiML document and ends the call. The random id in the
  // path is the access control these have.
  '/media/',
  // The call controller presents the bearer INTERNAL_API_TOKEN on these and
  // calls them from a single address, in bursts whenever the routing cache is
  // cold. One busy minute must not stop it from routing calls.
  '/internal/',
];

/** Whether the limiter skips `path`, the registered path of a route. */
export function isRateLimitExempt(path: string): boolean {
  return EXEMPT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const register = async (fastify: FastifyInstance) => {
  await fastify.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
    allowList: (request: FastifyRequest) =>
      isRateLimitExempt(request.routeOptions.url ?? request.url),
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${Math.round(context.ttl / 1000)} seconds.`,
    }),
    skipOnError: false,
  });
};

/**
 * Per-client-IP limit for the whole API. Buckets by `request.ip`, which is
 * only the real client behind a reverse proxy once `TRUST_PROXY` is set.
 *
 * `fastify-plugin` is what makes it work at all: @fastify/rate-limit installs
 * itself through an `onRoute` hook, and that hook is encapsulated, so without
 * the wrapper it would see only routes registered inside this plugin, which is
 * none of them.
 */
export const rateLimitPlugin = fp(register, { name: 'rate-limit' });

/** Route config for credential endpoints, to slow down password guessing. */
export const authRateLimit = {
  rateLimit: {
    max: 10,
    timeWindow: '1 minute',
  },
};
