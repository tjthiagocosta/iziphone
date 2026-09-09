'use client';

import type { AuthenticatedUser } from '@repo/dto';
import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { fetchCurrentUser, fetchRealtimeToken } from '@/lib/api/auth';
import { authClient } from '@/lib/auth-client';
import { loginPathFor, requiresSession } from '@/lib/session-guard';

export type AuthUser = AuthenticatedUser;

type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: AuthUser }
  | { status: 'failed'; error: string };

export interface AuthContextValue {
  user: AuthUser | null;
  /** True until the API has said whether the session cookie opens a session. */
  isLoading: boolean;
  /** Why the session could not be loaded, when the API was unreachable. */
  error: string | null;
  signOut: () => Promise<void>;
  /** A fresh token for the call controller; it authenticates the socket and the voice routes. */
  getRealtimeToken: () => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Loads the signed-in user from the API once per page load. The edge proxy
 * only sees that a session cookie exists; this is where a cookie that no
 * longer opens a session sends the visitor back to the login page.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    fetchCurrentUser().then(
      (user) => {
        if (cancelled) return;
        if (user) {
          setState({ status: 'signed-in', user });
          return;
        }
        setState({ status: 'signed-out' });
        const { pathname, search } = window.location;
        if (requiresSession(pathname)) {
          router.replace(loginPathFor(`${pathname}${search}`));
        }
      },
      (error: unknown) => {
        if (cancelled) return;
        setState({
          status: 'failed',
          error:
            error instanceof Error
              ? error.message
              : 'The session could not be loaded',
        });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [router]);

  const signOut = useCallback(async () => {
    const { error } = await authClient.signOut();
    if (error) {
      throw new Error(error.message ?? 'Sign out failed');
    }
    setState({ status: 'signed-out' });
    router.replace('/login');
  }, [router]);

  const value: AuthContextValue = {
    user: state.status === 'signed-in' ? state.user : null,
    isLoading: state.status === 'loading',
    error: state.status === 'failed' ? state.error : null,
    signOut,
    getRealtimeToken: fetchRealtimeToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
