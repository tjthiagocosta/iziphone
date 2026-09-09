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

const BCRYPT_ROUNDS = 12;
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
