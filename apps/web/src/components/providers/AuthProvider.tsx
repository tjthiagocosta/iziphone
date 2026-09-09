'use client';

import {
  type AuthenticatedUser,
  AuthMeResponseSchema,
  AuthTokenResponseSchema,
} from '@repo/dto';
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

/** The signed-in user, as the API describes them. */
export type AuthUser = AuthenticatedUser;

/**
 * Session data from better-auth
 */
interface SessionData {
  user: {
    id: string;
    email: string;
    name: string | null;
    emailVerified: boolean;
  } | null;
}

/**
 * Auth context value
 */
interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
}

type AuthClient = typeof import('@/lib/auth-client')['authClient'];

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * Auth provider component
 * Wraps the app to provide authentication state and methods
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<SessionData | null>(null);
  const [isPending, setIsPending] = useState(true);
  const [token, setToken] = useState<string | null>(null);
  const [fullUser, setFullUser] = useState<AuthUser | null>(null);
  const tokenFetchedRef = useRef(false);
  const tokenRef = useRef<string | null>(null);
  const authClientRef = useRef<AuthClient | null>(null);

  // Initialize auth client and session on mount
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    async function initAuth() {
      try {
        // Dynamic import to avoid SSR/static generation issues
        const { authClient } = await import('@/lib/auth-client');
        authClientRef.current = authClient;

        // Subscribe to session changes using $fetch for initial load
        const sessionResponse = await authClient.getSession();
        if (sessionResponse.data) {
          setSession({ user: sessionResponse.data.user });
        } else {
          setSession(null);
        }
        setIsPending(false);
      } catch (error) {
        console.error('Failed to initialize auth:', error);
        setIsPending(false);
      }
    }

    initAuth();

    return () => {
      unsubscribe?.();
    };
  }, []);

  // The session from Better Auth carries no role; the API answers with it.
  const fetchFullUser = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const response = await fetch(`${API_URL}/api/auth/me`, {
        credentials: 'include',
      });
      if (!response.ok) {
        return null;
      }

      const body = AuthMeResponseSchema.safeParse(await response.json());
      if (!body.success) {
        console.error('The API answered with an unexpected user', body.error);
        return null;
      }

      setFullUser(body.data.user);
      return body.data.user;
    } catch (error) {
      console.error('Failed to fetch user data:', error);
      return null;
    }
  }, []);

  // Fetch JWT token for Socket.IO when authenticated
  const fetchToken = useCallback(async (): Promise<string | null> => {
    try {
      const response = await fetch(`${API_URL}/api/auth/jwt-token`, {
        credentials: 'include',
      });
      if (!response.ok) {
        return null;
      }

      const body = AuthTokenResponseSchema.safeParse(await response.json());
      if (!body.success) {
        console.error('The API answered with an unexpected token', body.error);
        return null;
      }

      setToken(body.data.token);
      return body.data.token;
    } catch (error) {
      console.error('Failed to fetch auth token:', error);
      return null;
    }
  }, []);

  // Fetch full user and token when user authenticates
  useEffect(() => {
    if (session?.user && !tokenFetchedRef.current) {
      tokenFetchedRef.current = true;
      fetchFullUser();
      fetchToken();
    } else if (!session?.user) {
      tokenFetchedRef.current = false;
      setToken(null);
      tokenRef.current = null;
      setFullUser(null);
    }
  }, [session?.user, fetchFullUser, fetchToken]);

  // Keep tokenRef in sync with token state
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);

  // Sign out handler
  const handleSignOut = useCallback(async () => {
    if (authClientRef.current) {
      await authClientRef.current.signOut();
    }
    setSession(null);
    setToken(null);
    setFullUser(null);
    tokenFetchedRef.current = false;
    router.push('/login');
    router.refresh();
  }, [router]);

  // Get token (fetch if not available)
  // Uses ref to avoid recreating the callback when token changes
  const getToken = useCallback(async (): Promise<string | null> => {
    if (tokenRef.current) {
      return tokenRef.current;
    }
    return fetchToken();
  }, [fetchToken]);

  const value: AuthContextValue = {
    user: fullUser,
    isLoading: isPending || (!!session?.user && !fullUser),
    isAuthenticated: !!session?.user,
    signOut: handleSignOut,
    getToken,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access auth context
 * Must be used within AuthProvider
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }

  return context;
}
