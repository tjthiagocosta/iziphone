import type {
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import twilio from 'twilio';

export interface TwilioSignatureOptions {
  /** Auth token of the Twilio account that signs the webhooks; null when unconfigured. */
  authToken: string | null;
  /** Public base URL of this API, the URL Twilio signed against. */
  publicUrl: string;
  /** Development skips validation so local tunnels are easy to work with. */
  skipValidation: boolean;
}

/**
 * Builds the preHandler every Twilio webhook route must use. Twilio signs
 * the exact public URL plus the form body; a proxy that rewrites either one
 * makes every signature fail, hence the explicit public URL.
 */
export function createTwilioSignatureValidator(
  options: TwilioSignatureOptions,
) {
  return function validateTwilioSignature(
    request: FastifyRequest,
    reply: FastifyReply,
    done?: HookHandlerDoneFunction,
  ): void {
    if (options.skipValidation) {
      request.log.debug('Skipping Twilio webhook signature validation');
      done?.();
      return;
    }

    if (!options.authToken) {
      request.log.error(
        'Twilio webhook received but TWILIO_AUTH_TOKEN is not configured',
      );
      reply.status(500).send({ error: 'Server misconfiguration' });
      return;
    }

    const signature = request.headers['x-twilio-signature'];
    if (typeof signature !== 'string' || signature.trim().length === 0) {
      request.log.warn('Missing Twilio webhook signature');
      reply.status(403).send({ error: 'Missing signature' });
      return;
    }

    const url = new URL(
      request.raw.url ?? request.url,
      `${options.publicUrl}/`,
    ).toString();
    const isValid = twilio.validateRequest(
      options.authToken,
      signature,
      url,
      formParameters(request.body),
    );

    if (!isValid) {
      request.log.warn({ url }, 'Invalid Twilio webhook signature');
      reply.status(403).send({ error: 'Invalid signature' });
      return;
    }

    done?.();
  };
}

export type TwilioSignatureValidator = ReturnType<
  typeof createTwilioSignatureValidator
>;

function formParameters(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(body).flatMap(([key, value]) => {
      if (typeof value === 'string') {
        return [[key, value]];
      }

      if (Array.isArray(value)) {
        return value
          .filter((entry): entry is string => typeof entry === 'string')
          .map((entry) => [key, entry] as const);
      }

      return [];
    }),
  );
}
