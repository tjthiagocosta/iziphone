import { ROLES } from '@repo/dto';
import { describe, expect, test } from 'vitest';
import {
  getPermissionsForRole,
  hasPermission,
  hasRole,
  PERMISSIONS,
} from './permissions.js';

describe('permissions', () => {
  test('every permission names at least one role', () => {
    for (const roles of Object.values(PERMISSIONS)) {
      expect(roles.length).toBeGreaterThan(0);
    }
  });

  test('admins hold every permission', () => {
    expect(getPermissionsForRole('ADMIN').sort()).toEqual(
      Object.keys(PERMISSIONS).sort(),
    );
  });

  test('agents cannot manage users or listen to recordings', () => {
    expect(hasPermission('AGENT', 'users:manage')).toBe(false);
    expect(hasPermission('AGENT', 'recordings:listen')).toBe(false);
    expect(hasPermission('AGENT', 'calls:view')).toBe(true);
  });

  test('supervisors see everything but manage nothing', () => {
    expect(hasPermission('SUPERVISOR', 'calls:viewAll')).toBe(true);
    expect(hasPermission('SUPERVISOR', 'departments:manage')).toBe(false);
  });

  test('hasRole checks membership in the allowed list', () => {
    expect(hasRole('AGENT', ROLES)).toBe(true);
    expect(hasRole('AGENT', ['ADMIN', 'SUPERVISOR'])).toBe(false);
  });
});
