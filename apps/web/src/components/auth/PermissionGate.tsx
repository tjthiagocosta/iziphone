'use client';

import type { Role } from '@repo/dto';
import { hasPermission, hasRole, type Permission } from '@repo/events';
import type { ReactNode } from 'react';
import { useAuth } from '@/components/providers/AuthProvider';

interface PermissionGateProps {
  /** Required permission to render children */
  permission?: Permission;
  /** Alternative: require one of these roles */
  roles?: Role[];
  /** Content to render when authorized */
  children: ReactNode;
  /** Content to render when not authorized (default: null) */
  fallback?: ReactNode;
}

/**
 * Component that conditionally renders children based on user permissions
 *
 * @example
 * ```tsx
 * // By permission
 * <PermissionGate permission="users:manage">
 *   <AdminPanel />
 * </PermissionGate>
 *
 * // By role
 * <PermissionGate roles={['ADMIN', 'SUPERVISOR']}>
 *   <ReportsSection />
 * </PermissionGate>
 *
 * // With fallback
 * <PermissionGate permission="reports:view" fallback={<AccessDenied />}>
 *   <Reports />
 * </PermissionGate>
 * ```
 */
export function PermissionGate({
  permission,
  roles,
  children,
  fallback = null,
}: PermissionGateProps) {
  const { user } = useAuth();

  // Not authenticated
  if (!user) {
    return fallback;
  }

  if (permission && !hasPermission(user.role, permission)) {
    return fallback;
  }

  if (roles && !hasRole(user.role, roles)) {
    return fallback;
  }

  return <>{children}</>;
}

/**
 * Hook to check if the current user has a permission
 *
 * @example
 * ```tsx
 * const canManageUsers = usePermission('users:manage');
 *
 * if (canManageUsers) {
 *   // Show admin features
 * }
 * ```
 */
export function usePermission(permission: Permission): boolean {
  const { user } = useAuth();

  if (!user) {
    return false;
  }

  return hasPermission(user.role, permission);
}

/**
 * Hook to check if the current user has one of the specified roles
 *
 * @example
 * ```tsx
 * const isAdminOrSupervisor = useHasRole(['ADMIN', 'SUPERVISOR']);
 * ```
 */
export function useHasRole(roles: Role[]): boolean {
  const { user } = useAuth();

  if (!user) {
    return false;
  }

  return hasRole(user.role, roles);
}
