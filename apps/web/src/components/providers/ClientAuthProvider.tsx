'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';

// Dynamically import AuthProvider with ssr: false to completely avoid server-side bundling
const AuthProvider = dynamic(
  () => import('./AuthProvider').then((mod) => mod.AuthProvider),
  { ssr: false },
);

export function ClientAuthProvider({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
