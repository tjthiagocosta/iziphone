import {
  type AuthenticatedUser,
  AuthMeResponseSchema,
  AuthTokenResponseSchema,
  SessionListResponseSchema,
  type UserSession,
} from '@repo/dto';
import { ApiError, requestApi } from './client';

/** The signed-in user, or null when the session cookie no longer opens one. */
export async function fetchCurrentUser(): Promise<AuthenticatedUser | null> {
  try {
    const { user } = await requestApi('/api/auth/me', {
      schema: AuthMeResponseSchema,
    });
    return user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

/**
 * A fresh short-lived token for the call controller. It authenticates the
 * realtime socket and the voice routes; fetch it when needed rather than
 * caching it, since it expires within the hour.
 */
export async function fetchRealtimeToken(): Promise<string> {
  const { token } = await requestApi('/api/auth/jwt-token', {
    schema: AuthTokenResponseSchema,
  });
  return token;
}

export async function listSessions(): Promise<UserSession[]> {
  const { sessions } = await requestApi('/api/sessions', {
    schema: SessionListResponseSchema,
  });
  return sessions;
}

export function revokeSession(sessionId: string): Promise<void> {
  return requestApi(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

export function revokeOtherSessions(): Promise<void> {
  return requestApi('/api/sessions/revoke-all', { method: 'POST' });
}
