import type { Prisma, PrismaClient } from '@repo/db';
import {
  isSameMessageOwner,
  type MessageOwner,
  type MessageOwnerRef,
} from '@repo/dto';

/**
 * Whom a line works for, a user or a department, as it stands now, or null for
 * a line nobody holds; given a conversation, the owner it copied from its line
 * when it was created, which decides every read below. An administrator
 * cannot give a number to a user and a department at once; the user is read
 * first, here and so everywhere an owner is compared or shown.
 */
export function lineOwnerOf(line: {
  userId: string | null;
  departmentId: string | null;
}): MessageOwnerRef | null {
  if (line.userId) {
    return { type: 'user', id: line.userId };
  }

  if (line.departmentId) {
    return { type: 'department', id: line.departmentId };
  }

  return null;
}

/**
 * Whether a conversation is the current owner's thread on its line, and so the
 * one new messages on that line with that contact go to. A conversation keeps
 * the owner it was created under: once the line changes hands the old thread
 * stays readable to whoever owned it then, and nobody writes to it any more.
 */
export function isLineOwnersThread(
  conversation: { userId: string | null; departmentId: string | null },
  line: { userId: string | null; departmentId: string | null },
): boolean {
  return isSameMessageOwner(lineOwnerOf(conversation), lineOwnerOf(line));
}

/**
 * An owner as the API shows it, from a row that carries the owner columns and
 * both owner relations. Null when the row has no owner, or when the owner's
 * own row is missing. Both relations are required so that a query which
 * forgets to select one fails to compile rather than showing every thread as
 * having nobody; a caller that knowingly has no relation passes `null`.
 */
export function toMessageOwner(row: {
  userId: string | null;
  departmentId: string | null;
  user: { name: string | null; email: string } | null;
  department: { name: string } | null;
}): MessageOwner | null {
  const owner = lineOwnerOf(row);

  switch (owner?.type) {
    case 'user':
      return row.user
        ? {
            type: 'user',
            id: owner.id,
            name: row.user.name || row.user.email,
          }
        : null;
    case 'department':
      return row.department
        ? {
            type: 'department',
            id: owner.id,
            name: row.department.name,
          }
        : null;
    default:
      return null;
  }
}

/**
 * Which conversations a user may see: the ones on their own number, and the
 * ones on a number belonging to a department they are in.
 *
 * A conversation is a contact on one line under one owner, so this is also
 * what decides which parts of a contact's history they see: the same contact
 * reached on a department they do not belong to is a different conversation,
 * and so is the thread the line's previous owner had with them. Both stay
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
 * Everyone {@link buildConversationScope} would return this conversation to:
 * the user it belongs to, and the members of the department it belongs to.
 * The inverse of the filter above and kept beside it, so the two cannot drift
 * and a conversation is never announced to somebody who could not open it.
 *
 * A deleted department contributes nobody, for the reason in
 * {@link loadDepartmentIds}. A deleted user contributes nobody either:
 * deleting a user ends their sessions and releases their numbers but leaves
 * their membership rows behind, and somebody who has been let go is not told
 * that a line they used to work has changed. An unknown conversation has no
 * audience.
 */
export async function loadConversationAudience(
  db: Pick<PrismaClient, 'messageConversation'>,
  conversationId: string,
): Promise<string[]> {
  const conversation = await db.messageConversation.findUnique({
    where: { id: conversationId },
    select: {
      userId: true,
      user: { select: { deletedAt: true } },
      department: {
        select: {
          deletedAt: true,
          users: {
            where: { user: { deletedAt: null } },
            select: { userId: true },
          },
        },
      },
    },
  });

  if (!conversation) {
    return [];
  }

  const department = conversation.department;
  const members = department?.deletedAt
    ? []
    : (department?.users.map((member) => member.userId) ?? []);
  const owner =
    conversation.userId && !conversation.user?.deletedAt
      ? conversation.userId
      : null;

  // A number belongs to a user or to a department, never both, but the owner
  // can also be a member; de-duplicated so nobody is sent the same thing twice.
  return [...new Set(owner ? [owner, ...members] : members)];
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
