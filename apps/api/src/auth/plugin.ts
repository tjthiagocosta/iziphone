import { AuthenticatedUserSchema } from '@repo/dto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { type Auth, createAuth } from './better-auth.js';

/** What Better Auth hands back; validated because `role` is a free-form field there. */
const AuthSessionSchema = z.object({
  session: z.object({
    id: z.string(),
    userId: z.string(),
    expiresAt: z.coerce.date(),
    token: z.string(),
  }),
  user: AuthenticatedUserSchema,
});

export type AuthUser = z.infer<typeof AuthenticatedUserSchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;
export type Role = AuthUser['role'];

declare module 'fastify' {
  interface FastifyInstance {
    auth: Auth;
    requireAuth: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<FastifyReply | undefined>;
    requireRole: (
      roles: readonly Role[],
    ) => (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<FastifyReply | undefined>;
  }
  interface FastifyRequest {
    session?: AuthSession;
    user?: AuthUser;
  }
}

/** The user behind a request that already passed `requireAuth`. */
export function authenticatedUser(request: FastifyRequest): AuthUser {
  if (!request.user) {
    throw new Error('Route is missing the requireAuth preHandler');
  }
  return request.user;
}

function toWebHeaders(headers: FastifyRequest['headers']): Headers {
  const webHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    const normalized = Array.isArray(value) ? value.join(', ') : value;
    if (normalized) {
      webHeaders.set(key, normalized);
    }
  }
  return webHeaders;
}

const register: FastifyPluginAsync = async (fastify) => {
  const { config } = fastify;
  const auth = createAuth({
    db: fastify.db,
    secret: config.authSecret,
    baseURL: config.publicUrl,
    trustedOrigins: [config.publicUrl, ...config.corsOrigins],
    secureCookies: config.nodeEnv === 'production',
  });

  fastify.decorate('auth', auth);

  async function readSession(
    request: FastifyRequest,
  ): Promise<AuthSession | null> {
    const session = await auth.api.getSession({
      headers: toWebHeaders(request.headers),
    });

    if (!session) {
      return null;
    }

    const parsed = AuthSessionSchema.safeParse(session);

    if (!parsed.success) {
      request.log.error(
        { userId: session.user.id, issues: parsed.error.issues },
        'Session has an unexpected shape; refusing it',
      );
      return null;
    }

    return parsed.data;
  }

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await readSession(request);

    if (!session) {
      // An async hook that answers must return the reply, or Fastify decides
      // whether to continue by looking at reply.sent, which is still false
      // while any async onSend hook holds the response back: the route handler
      // would then run despite the 401.
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    request.session = session;
    request.user = session.user;
  };

  fastify.decorate('requireAuth', requireAuth);

  fastify.decorate('requireRole', (allowedRoles: readonly Role[]) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      const refused = await requireAuth(request, reply);

      if (refused) return refused;

      if (!request.user || !allowedRoles.includes(request.user.role)) {
        return reply.status(403).send({
          error: 'Forbidden',
          message: `Required role: ${allowedRoles.join(' or ')}`,
        });
      }
    };
  });
};

export const authPlugin = fp(register, {
  name: 'auth',
  dependencies: ['prisma'],
});
