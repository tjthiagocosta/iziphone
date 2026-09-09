'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { useHasRole } from '@/components/auth/PermissionGate';
import { useAuth } from '@/components/providers/AuthProvider';

/**
 * Keeps the admin console to admins. The API refuses the data anyway; this
 * spares everyone else an empty console and sends them back to the app.
 */
export function AdminGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const isAdmin = useHasRole(['ADMIN']);

  useEffect(() => {
    if (!isLoading && user && !isAdmin) {
      router.replace('/app');
    }
  }, [isLoading, user, isAdmin, router]);

  if (!isAdmin) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}
