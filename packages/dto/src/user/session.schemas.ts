import { z } from 'zod';
import { RoleSchema } from '../common/domain.js';
import { IsoDateTimeSchema } from '../common/primitives.js';

/*
 * The signed-in user, as the API answers `GET /api/auth/me`. Better Auth
 * keeps `role` as a free-form field, so both sides validate it.
 */
export const AuthenticatedUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: RoleSchema,
  emailVerified: z.boolean(),
});

export const AuthMeResponseSchema = z.object({
  user: AuthenticatedUserSchema,
});

/** The short-lived token that authenticates the realtime socket. */
export const AuthTokenResponseSchema = z.object({
  token: z.string(),
});

/** One of the user's own sign-ins, as `GET /api/sessions` lists them. */
export const UserSessionSchema = z.object({
  id: z.string(),
  createdAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** The session behind the request that listed them. */
  isCurrent: z.boolean(),
});

export const SessionListResponseSchema = z.object({
  sessions: z.array(UserSessionSchema),
});

export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;
export type UserSession = z.infer<typeof UserSessionSchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
