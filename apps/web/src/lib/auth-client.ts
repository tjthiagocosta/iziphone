'use client';

import { createAuthClient } from 'better-auth/react';
import { API_URL } from './api/client';

/** Better Auth's browser client: sign in, sign up and sign out against the API. */
export const authClient = createAuthClient({ baseURL: API_URL });

export const { signIn, signUp } = authClient;
