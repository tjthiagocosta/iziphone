'use client';

import { createAuthClient } from 'better-auth/react';

/**
 * Better Auth client for React
 *
 * Provides hooks and methods for authentication:
 * - useSession: Get current session state
 * - signIn: Sign in with email/password
 * - signUp: Register new account
 * - signOut: Sign out current session
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
});

// Export typed hooks and methods
export const { useSession, signIn, signUp, signOut } = authClient;
