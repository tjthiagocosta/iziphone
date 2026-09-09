import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Exclude better-auth from server-side bundling to avoid next/document import issues
  serverExternalPackages: ['better-auth', 'better-auth/react'],
};

export default nextConfig;
