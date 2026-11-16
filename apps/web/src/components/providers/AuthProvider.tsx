'use client';

import type { AuthenticatedUser } from '@repo/dto';
import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { fetchCurrentUser, fetchRealtimeToken } from '@/lib/api/auth';
import { onSessionExpired } from '@/lib/api/client';
import { keepAsking } from '@/lib/api/retry';
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
  /**
   * Why the session could not be loaded: a failure that will not pass, or any
   * failure of the one reload a sign-in page asks for.
   */
  error: string | null;
  signOut: () => Promise<void>;
  /**
   * Asks the API again whose session the browser holds and answers that user,
   * or null when it holds none or a newer load or a sign-out overtook the
   * answer. A page that signs the visitor in awaits it before it navigates;
   * see `enterApp`.
   */
  reloadSession: () => Promise<AuthUser | null>;
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
 * Loads the signed-in user from the API when the page loads, and again when a
 * page that signed the visitor in asks it to. The edge proxy only sees that a
 * session cookie exists; this is where a cookie that no longer opens a
 * session sends the visitor back to the login page.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  /*
   * Moves on with every load, every sign-out and the provider going away, so
   * that only the newest of them settles the state, and a load waiting to ask
   * again gives up. The first load can still be out when the visitor signs
   * in, and its "nobody" must not land after the answer the sign-in asked for.
   */
  const sessionChange = useRef(0);

  const signOutLocally = useCallback(
    (target: LoginTarget) => {
      sessionChange.current += 1;
      setState({ status: 'signed-out' });
      router.replace(loginPathFor(target));
    },
    [router],
  );

  /*
   * The load a page makes when it opens asks again after a failure that can
   * pass, such as a spent rate limit or a restarting API, and the state stays
   * loading meanwhile: failed, the shell would stay empty until a reload. A
   * page that signs the visitor in asks once. It says itself that the app
   * could not open, the visitor is there to try again, and an answer that
   * came after they left would navigate them away from wherever they went.
   */
  const loadSession = useCallback(
    async ({ askAgain }: { askAgain: boolean }): Promise<AuthUser | null> => {
      sessionChange.current += 1;
      const load = sessionChange.current;

      let user: AuthUser | null;
      try {
        user = askAgain
          ? await keepAsking(
              fetchCurrentUser,
              () => load === sessionChange.current,
            )
          : await fetchCurrentUser();
      } catch (error) {
        if (load === sessionChange.current) {
          setState({
            status: 'failed',
            error:
              error instanceof Error
                ? error.message
                : 'The session could not be loaded',
          });
        }
        throw error;
      }

      // Overtaken: what the provider holds is a newer answer's, not this one's.
      if (load !== sessionChange.current) {
        return null;
      }
      if (user) {
        setState({ status: 'signed-in', user });
        return user;
      }
      setState({ status: 'signed-out' });
      const { pathname, search } = window.location;
      if (requiresSession(pathname)) {
        router.replace(loginPathFor({ redirect: `${pathname}${search}` }));
      }
      return null;
    },
    [router],
  );

  const reloadSession = useCallback(
    () => loadSession({ askAgain: false }),
    [loadSession],
  );

  useEffect(() => {
    // The state carries a failure to the views; nothing else waits on this load.
    loadSession({ askAgain: true }).catch(() => undefined);

    return () => {
      sessionChange.current += 1;
    };
  }, [loadSession]);

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
    reloadSession,
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
