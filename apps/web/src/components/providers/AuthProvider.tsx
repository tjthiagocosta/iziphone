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
import { onSessionExpired } from '@/lib/api/client';
import { authClient } from '@/lib/auth-client';
import {
  type LoginTarget,
  loginPathFor,
  requiresSession,
} from '@/lib/session-guard';

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
 * Ends the session on the server. Answers whether it refused, rather than
 * throwing: the caller signs the visitor out of this browser either way.
 */
async function endServerSession(): Promise<boolean> {
  try {
    const { error } = await authClient.signOut();
    if (error) {
      reportSignOutFailure(error);
      return false;
    }
    return true;
  } catch (caughtError) {
    reportSignOutFailure(caughtError);
    return false;
  }
}

// The only place the detail exists; the visitor is told what it means for them.
function reportSignOutFailure(cause: unknown): void {
  if (process.env.NODE_ENV !== 'production') {
    console.error('Unable to complete sign out request', cause);
  }
}

/**
 * Loads the signed-in user from the API once per page load. The edge proxy
 * only sees that a session cookie exists; this is where a cookie that no
 * longer opens a session sends the visitor back to the login page.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const signOutLocally = useCallback(
    (target: LoginTarget) => {
      setState({ status: 'signed-out' });
      router.replace(loginPathFor(target));
    },
    [router],
  );

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
          router.replace(loginPathFor({ redirect: `${pathname}${search}` }));
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

  /*
   * Only while signed in: a 401 before the first load has settled is the
   * answer that led here, and on the login page a refused sign-in is a 401
   * of its own.
   */
  useEffect(() => {
    if (state.status !== 'signed-in') {
      return;
    }

    return onSessionExpired(() => {
      const { pathname, search } = window.location;
      signOutLocally({
        redirect: requiresSession(pathname)
          ? `${pathname}${search}`
          : undefined,
        reason: 'session-expired',
      });
    });
  }, [state.status, signOutLocally]);

  const signOut = useCallback(async () => {
    const ended = await endServerSession();
    /*
     * A server that refused still leaves the cookie valid, but leaving the
     * shell signed in on a shared machine is the worse of the two: clear it
     * either way and let the login page say the session may still be open.
     */
    signOutLocally(ended ? {} : { reason: 'sign-out-failed' });
  }, [signOutLocally]);

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
