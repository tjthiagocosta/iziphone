import { z } from 'zod';
import { RoleSchema } from '../common/domain.js';

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

export type AuthenticatedUser = z.infer<typeof AuthenticatedUserSchema>;
export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>;
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;
