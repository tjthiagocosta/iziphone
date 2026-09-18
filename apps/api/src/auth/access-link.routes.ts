import { ForgotPasswordSchema, SetPasswordSchema } from '@repo/dto';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { authRateLimit } from '../infra/index.js';
import { AccessLinkService } from './access-link.service.js';

/*
 * The signed-out half of the access model: asking for a reset link, finding
 * out whether a link still works, and spending it. No cookie is required to
 * reach any of these, so each one is written to give a stranger nothing:
 * `forgot-password` answers the same for every address, and a dead link never
 * says whose it was.
 */
export const accessLinkRoutes: FastifyPluginAsync = async (fastify) => {
  const accessLinks = new AccessLinkService(
    fastify.db,
    fastify.mailer,
    fastify.config.webUrl,
    fastify.log,
  );

  fastify.post(
    '/api/auth/forgot-password',
    { config: authRateLimit },
    async (request, reply) => {
      const { email } = ForgotPasswordSchema.parse(request.body);

      /*
       * Deliberately not awaited. The answer is the same for every address,
       * but the work behind it is not: issuing a link and handing it to a mail
       * server takes time only when the address has an account, and somebody
       * timing the answers would read that difference as a list of who works
       * here. Answering first also keeps a slow mail server out of the
       * visitor's way.
       */
      void accessLinks
        .requestReset(email)
        .catch((error) =>
          fastify.log.error({ error }, 'Password reset request failed'),
        );

      return reply.send({ success: true });
    },
  );

  fastify.get<{ Params: { token: string } }>(
    '/api/auth/set-password/:token',
    {
      /*
       * The token is the whole secret, and Fastify logs every request URL at
       * info. Nothing below error is written for this route, so a link cannot
       * be recovered from the access log.
       */
      logLevel: 'error',
    },
    async (request, reply) => {
      return reply.send(await accessLinks.describe(request.params.token));
    },
  );

  fastify.post(
    '/api/auth/set-password',
    { config: authRateLimit },
    async (request, reply) => {
      const data = SetPasswordSchema.parse(request.body);
      const result = await accessLinks.consume(data);

      if (!result.ok) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: result.message,
        });
      }

      /*
       * Signing in is left to Better Auth rather than minting a session here,
       * so the cookie this answers with is the same one the sign-in route
       * sets, with the same attributes and the same lifetime.
       */
      const signedIn = await signIn(fastify, result.email, data.password);

      if (!signedIn) {
        /*
         * The password is set and every old session is gone, so this is not a
         * failure of the operation; the browser just lands on the login page.
         */
        fastify.log.error('Sign-in after setting a password was refused');
        return reply.send({ success: true });
      }

      forwardSessionCookies(signedIn, reply);

      return reply.send({ success: true });
    },
  );
};

async function signIn(
  fastify: Parameters<FastifyPluginAsync>[0],
  email: string,
  password: string,
): Promise<Response | null> {
  try {
    const response = await fastify.auth.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });

    return response.ok ? response : null;
  } catch (error) {
    fastify.log.error({ error }, 'Sign-in after setting a password failed');
    return null;
  }
}

function forwardSessionCookies(response: Response, reply: FastifyReply): void {
  const cookies = response.headers.getSetCookie();

  if (cookies.length > 0) {
    reply.header('set-cookie', cookies);
  }
}
