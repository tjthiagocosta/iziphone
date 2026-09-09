import type { Prisma, PrismaClient } from '@repo/db';
import type { AuthUser } from '../auth/index.js';

/**
 * Which call records a user may see and command. Supervisors and admins
 * cover the whole history; an agent is limited to their own calls and the
 * calls of the departments they belong to. Expressed as a Prisma filter so
 * lists filter in the database and lookups miss (404) rather than forbid,
 * which would reveal that a call exists.
 */
export function buildCallScope(
  user: Pick<AuthUser, 'id' | 'role'>,
  departmentIds: readonly string[],
): Prisma.CallWhereInput {
  if (user.role === 'ADMIN' || user.role === 'SUPERVISOR') {
    return {};
  }

  return {
    OR: [{ userId: user.id }, { departmentId: { in: [...departmentIds] } }],
  };
}

export async function loadCallScope(
  db: Pick<PrismaClient, 'userDepartment'>,
  user: Pick<AuthUser, 'id' | 'role'>,
): Promise<Prisma.CallWhereInput> {
  if (user.role !== 'AGENT') {
    return buildCallScope(user, []);
  }

  const memberships = await db.userDepartment.findMany({
    where: { userId: user.id },
    select: { departmentId: true },
  });

  return buildCallScope(
    user,
    memberships.map((membership) => membership.departmentId),
  );
}
