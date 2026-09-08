import type { Role } from '@repo/dto';

/*
 * Role-based access control. Roles come from `@repo/dto`; this table says
 * which of them may perform each action. Keep it the single source of truth:
 * the web app renders from it and the API enforces it.
 */

export const PERMISSIONS = {
  'calls:view': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'calls:manage': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'calls:transfer': ['ADMIN', 'SUPERVISOR', 'AGENT'],
  'calls:viewAll': ['ADMIN', 'SUPERVISOR'],
  'recordings:listen': ['ADMIN', 'SUPERVISOR'],
  'users:view': ['ADMIN', 'SUPERVISOR'],
  'users:manage': ['ADMIN'],
  'departments:view': ['ADMIN', 'SUPERVISOR'],
  'departments:manage': ['ADMIN'],
  'internal:access': ['ADMIN'],
  'reports:view': ['ADMIN', 'SUPERVISOR'],
  'settings:manage': ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export function hasRole(role: Role, allowed: readonly Role[]): boolean {
  return allowed.includes(role);
}

export function getPermissionsForRole(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) =>
    hasPermission(role, permission),
  );
}
