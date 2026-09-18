import type { Prisma, PrismaClient } from '@repo/db';
import type { CallListQuery, CallRecordingContext, Role } from '@repo/dto';
import { hasPermission } from '@repo/events';
import type { AuthUser } from '../auth/index.js';

/**
 * The timeline entry the API writes once a voicemail recording exists. A
 * plain `recordingUrl` does not mean voicemail; a conference recording sets
 * it as well.
 */
const VOICEMAIL_EVENT = 'VOICEMAIL_COMPLETED';

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

/**
 * Who may hear a recording of a call they can already see. Listening to a
 * voicemail is part of working a line, so it follows the call's visibility;
 * the recording of the conversation itself is what `recordings:listen`
 * reserves for supervisors and admins.
 */
export function canListenToRecording(
  role: Role,
  context: CallRecordingContext,
): boolean {
  return context === 'VOICEMAIL' || hasPermission(role, 'recordings:listen');
}

/**
 * The `where` for a call list: the role scope narrowed by what the query
 * asked for.
 *
 * The filters go inside an `AND` rather than being merged into the scope
 * object, because an agent's scope is an `OR` over their own calls and their
 * departments'. A filter set as a sibling key of that `OR` reads as another
 * alternative and widens the scope instead of narrowing it.
 *
 * `linePhone` and `contactPhone` are each matched against both legs: which
 * leg holds our number depends on the call's direction, and the pair of them
 * selects one conversation's calls.
 */
export function buildCallListWhere(
  scope: Prisma.CallWhereInput,
  query: Pick<
    CallListQuery,
    'linePhone' | 'contactPhone' | 'status' | 'direction' | 'hasVoicemail'
  >,
): Prisma.CallWhereInput {
  const filters: Prisma.CallWhereInput[] = [];

  for (const phone of [query.linePhone, query.contactPhone]) {
    if (phone) {
      filters.push({ OR: [{ from: phone }, { to: phone }] });
    }
  }

  if (query.status) {
    filters.push({ status: { in: [...query.status] } });
  }

  if (query.direction) {
    filters.push({ direction: query.direction });
  }

  if (query.hasVoicemail !== undefined) {
    const leftAVoicemail = {
      events: { some: { eventType: VOICEMAIL_EVENT } },
    } as const;
    filters.push(query.hasVoicemail ? leftAVoicemail : { NOT: leftAVoicemail });
  }

  return filters.length > 0 ? { AND: [scope, ...filters] } : scope;
}
