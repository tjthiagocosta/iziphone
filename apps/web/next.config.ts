import type { NextConfig } from 'next';
import { API_URL, CALL_CONTROLLER_URL } from './src/lib/api/client';
import { securityHeaders } from './src/lib/security-headers';

/*
 * The backend URLs come from the API client rather than from a second read of
 * the environment: the policy has to allow exactly what the browser calls.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  poweredByHeader: false,
  // Exclude better-auth from server-side bundling to avoid next/document import issues
  serverExternalPackages: ['better-auth', 'better-auth/react'],
  headers() {
    return Promise.resolve([
      {
        source: '/(.*)',
        headers: securityHeaders({
          apiUrl: API_URL,
          callControllerUrl: CALL_CONTROLLER_URL,
          isDevelopment: process.env.NODE_ENV !== 'production',
        }),
      },
    ]);
  },
};

export default nextConfig;
