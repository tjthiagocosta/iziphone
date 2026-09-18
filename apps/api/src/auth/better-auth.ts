import type { PrismaClient } from '@repo/db';
import bcrypt from 'bcryptjs';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';

export interface AuthOptions {
  db: PrismaClient;
  secret: string;
  /** Public URL of the API; Better Auth builds its callback URLs on it. */
  baseURL: string;
  /** Browser origins allowed to call the auth endpoints. */
  trustedOrigins: string[];
  secureCookies: boolean;
}

/** The one cost factor in the system; the access-link flow hashes with it too. */
export const BCRYPT_ROUNDS = 12;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const SESSION_REFRESH_SECONDS = 60 * 60 * 24;

/**
 * Email and password sessions backed by Postgres. No social providers.
 * Sessions are read from the database on every request so that revoking
 * one takes effect immediately.
 */
export function createAuth(options: AuthOptions) {
  return betterAuth({
    database: prismaAdapter(options.db, { provider: 'postgresql' }),
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: options.trustedOrigins,

    emailAndPassword: {
      enabled: true,
      /*
       * Every deployment is one company's own phone system, run by its admin.
       * Nobody arrives by registering: an admin invites them, and the invite
       * link is what sets the first password. Leaving this open would hand a
       * stranger a session, a voice token and the customer's Twilio bill.
       */
      disableSignUp: true,
      requireEmailVerification: false,
      password: {
        hash: (password) => bcrypt.hash(password, BCRYPT_ROUNDS),
        verify: ({ password, hash }) => bcrypt.compare(password, hash),
      },
    },

    session: {
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: SESSION_REFRESH_SECONDS,
    },

    // Better Auth buckets by the x-forwarded-for header, which any client can
    // set, so its limiter hands an attacker a fresh bucket per request while
    // putting every header-less client into one shared bucket. The Fastify
    // limiter covers /api/auth/* instead (see infra/rate-limit.ts) and buckets
    // by request.ip, which is derived from TRUST_PROXY.
    rateLimit: { enabled: false },

    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          defaultValue: 'AGENT',
          input: false,
        },
      },
    },

    advanced: {
      cookiePrefix: 'iziphone',
      useSecureCookies: options.secureCookies,
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
