import type { Prisma, PrismaClient } from '@repo/db';

/**
 * Which conversations a user may see: the ones on their own number, and the
 * ones on a number belonging to a department they are in.
 *
 * A conversation is a contact on one line, so this is also what decides which
 * halves of a contact's history they see: the same contact reached on a
 * department they do not belong to is a different conversation, and stays
 * invisible. Expressed as a Prisma filter so it can be applied to a list, to
 * a relation include, and to a lookup that should miss rather than forbid.
 */
export function buildConversationScope(
  userId: string,
  departmentIds: readonly string[],
): Prisma.MessageConversationWhereInput {
  return {
    OR: [
      { userId },
      ...(departmentIds.length
        ? [{ departmentId: { in: [...departmentIds] } }]
        : []),
    ],
  };
}

/** The same rule as {@link buildConversationScope}, on a loaded row. */
export function canAccessConversation(
  conversation: { userId: string | null; departmentId: string | null },
  userId: string,
  departmentIds: readonly string[],
): boolean {
  if (conversation.userId === userId) {
    return true;
  }

  return (
    conversation.departmentId !== null &&
    departmentIds.includes(conversation.departmentId)
  );
}

/**
 * The departments a user is in. A deleted department is left out: its
 * conversations stop being visible with it.
 */
export async function loadDepartmentIds(
  db: Pick<PrismaClient, 'userDepartment'>,
  userId: string,
): Promise<string[]> {
  const memberships = await db.userDepartment.findMany({
    where: { userId, department: { deletedAt: null } },
    select: { departmentId: true },
  });

  return memberships.map((membership) => membership.departmentId);
}
