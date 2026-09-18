'use client';

import { createAuthClient } from 'better-auth/react';
import { API_URL } from './api/client';

/**
 * Better Auth's browser client: sign in and sign out against the API. There is
 * no sign-up: the API refuses it, and a person gets in through an invite link.
 */
export const authClient = createAuthClient({ baseURL: API_URL });

export const { signIn } = authClient;
