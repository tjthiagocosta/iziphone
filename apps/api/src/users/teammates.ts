import type { PrismaClient } from '@repo/db';
import type { Teammate } from '@repo/dto';

/**
 * Everyone a user can hand a call to: every user who has not been deleted,
 * other than themselves. Whether a teammate is online is for the call
 * controller to say when the transfer is attempted, not for this list.
 */
export async function listTeammates(
  db: PrismaClient,
  userId: string,
): Promise<Teammate[]> {
  const users = await db.user.findMany({
    where: { id: { not: userId }, deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      departments: {
        where: { department: { deletedAt: null } },
        orderBy: { order: 'asc' },
        select: { department: { select: { name: true } } },
      },
    },
  });

  return users
    .map((user) => ({
      id: user.id,
      // Not everyone has a name; their email is what colleagues know instead.
      name: user.name?.trim() || user.email,
      departments: user.departments.map(
        (membership) => membership.department.name,
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
