import { TextEncoder } from 'node:util';
import { RoleSchema } from '@repo/dto';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

/*
 * The short-lived token the API issues for realtime clients. The call
 * controller verifies it on Socket.IO handshakes and on its voice routes. Both
 * services share the Better Auth secret, so the token is a plain HS256 JWT.
 */

export const JWT_ALGORITHM = 'HS256';
export const JWT_DEFAULT_TTL = '1h';

export const JwtClaimsSchema = z.object({
  /** The user id. */
  sub: z.string().min(1),
  email: z.string().min(1),
  role: RoleSchema,
  iat: z.number().int(),
  exp: z.number().int(),
});

export type JwtClaims = z.infer<typeof JwtClaimsSchema>;
export type JwtUserClaims = Pick<JwtClaims, 'sub' | 'email' | 'role'>;

function secretKey(secret: string): Uint8Array {
  if (secret.length === 0) {
    throw new Error('JWT secret must not be empty');
  }
  return new TextEncoder().encode(secret);
}

export async function signJWT(
  claims: JwtUserClaims,
  secret: string,
  options: { expiresIn?: string } = {},
): Promise<string> {
  return new SignJWT({ email: claims.email, role: claims.role })
    .setSubject(claims.sub)
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? JWT_DEFAULT_TTL)
    .sign(secretKey(secret));
}

/**
 * Verify signature, algorithm and expiry, then validate the claim shape.
 * Rejects with a `jose` error for a bad or expired token and a `ZodError`
 * for a token that verifies but carries unexpected claims.
 */
export async function verifyJWT(
  token: string,
  secret: string,
): Promise<JwtClaims> {
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: [JWT_ALGORITHM],
  });
  return JwtClaimsSchema.parse(payload);
}
